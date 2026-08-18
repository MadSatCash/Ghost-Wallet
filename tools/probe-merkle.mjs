// Experimento: cuanto vale y cuanto cuesta un merkle proof.
//
// No implementa nada — mide, para poder decidir el punto 3 con numeros:
//
//   1. Un proof corrupto, ¿se detecta o pasa?
//   2. cp_height, ¿ancla cabeceras posteriores al checkpoint o solo anteriores?
//   3. Bajar cabeceras desde un checkpoint reciente, ¿cuanto tarda por Tor?
//
// Se corre con:  node tools/probe-merkle.mjs

import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { SocksProxyAgent } from 'socks-proxy-agent';
import WebSocket from 'ws';

const HOSTS = ['bch.imaginary.cash', 'bch.loping.net', 'bch.soul-dev.com'];
const PORT = 50004;

const dataDir = path.join(os.tmpdir(), 'ghostwallet-merkle-tor', 'data');
let torProcess = null;

function sha256d(buf) {
  return crypto.createHash('sha256').update(
    crypto.createHash('sha256').update(buf).digest()
  ).digest();
}

// Los txid y hashes de bloque se muestran al reves de como se hashean.
function flip(hex) {
  return Buffer.from(hex, 'hex').reverse();
}

// Reconstruye el merkle root subiendo por la rama. Si el servidor manda
// cualquier cosa, el resultado no coincide con el de la cabecera: por eso una
// prueba falsa no "corrompe" nada, simplemente no valida.
function merkleRootFromProof(txidHex, pos, branchHex) {
  let hash = flip(txidHex);
  let index = pos;
  for (const siblingHex of branchHex) {
    const sibling = flip(siblingHex);
    hash = (index & 1)
      ? sha256d(Buffer.concat([sibling, hash]))
      : sha256d(Buffer.concat([hash, sibling]));
    index >>= 1;
  }
  return Buffer.from(hash).reverse().toString('hex');
}

// Cabecera BCH: 80 bytes. El merkle root son los bytes 36..68, al reves.
function merkleRootFromHeader(headerHex) {
  const header = Buffer.from(headerHex, 'hex');
  return Buffer.from(header.subarray(36, 68)).reverse().toString('hex');
}

function prevHashFromHeader(headerHex) {
  const header = Buffer.from(headerHex, 'hex');
  return Buffer.from(header.subarray(4, 36)).reverse().toString('hex');
}

function blockHashFromHeader(headerHex) {
  return Buffer.from(sha256d(Buffer.from(headerHex, 'hex'))).reverse().toString('hex');
}

function findTorExe() {
  const roaming = process.env.APPDATA || path.join(os.homedir(), '.config');
  return [
    path.join(roaming, 'bch-wallet', 'tor-bin', 'tor', 'tor.exe'),
    path.join(roaming, 'bch-wallet', 'tor-bin', 'tor', 'tor'),
    path.join(os.homedir(), '.config', 'bch-wallet', 'tor-bin', 'tor', 'tor'),
  ].find(p => fs.existsSync(p)) || null;
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function startTor() {
  const torExe = findTorExe();
  if (!torExe) throw new Error('No encontre tor.exe.');
  fs.mkdirSync(dataDir, { recursive: true });
  const socksPort = await getFreePort();
  process.stdout.write(`Levantando Tor (SOCKS ${socksPort})`);
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; stopTor(); reject(new Error('Tor timeout')); }
    }, 90000);
    torProcess = spawn(torExe, ['--SocksPort', `127.0.0.1:${socksPort}`, '--DataDirectory', dataDir, '--ClientOnly', '1']);
    torProcess.stdout.on('data', (buf) => {
      const line = buf.toString();
      if (/Bootstrapped \d+%/.test(line)) process.stdout.write('.');
      if (line.includes('Bootstrapped 100%') && !settled) {
        settled = true; clearTimeout(timer); console.log(' listo.\n'); resolve(socksPort);
      }
    });
    torProcess.on('error', (e) => { if (!settled) { settled = true; clearTimeout(timer); reject(e); } });
  });
}

function stopTor() {
  if (torProcess) { try { torProcess.kill(); } catch { /* noop */ } torProcess = null; }
}

function connect(host, socksPort) {
  return new Promise((resolve, reject) => {
    const agent = new SocksProxyAgent(`socks5h://127.0.0.1:${socksPort}`);
    const ws = new WebSocket(`wss://${host}:${PORT}`, undefined, { agent });
    const pending = new Map();
    let nextId = 1, settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; try { ws.close(); } catch {} reject(new Error('timeout')); }
    }, 30000);
    ws.on('open', () => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      resolve({
        host,
        request(method, ...params) {
          return new Promise((res, rej) => {
            const id = nextId++;
            const t = setTimeout(() => { pending.delete(id); rej(new Error('timeout ' + method)); }, 45000);
            pending.set(id, { res, rej, t });
            ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
          });
        },
        close() { try { ws.close(); } catch { /* noop */ } },
      });
    });
    ws.on('message', (data) => {
      for (const line of data.toString().split('\n')) {
        if (!line.trim()) continue;
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        const e = pending.get(msg.id);
        if (!e) continue;
        pending.delete(msg.id); clearTimeout(e.t);
        if (msg.error) e.rej(new Error(msg.error.message || 'rpc error'));
        else e.res(msg.result);
      }
    });
    ws.on('error', (e) => { if (!settled) { settled = true; clearTimeout(timer); reject(e); } });
  });
}

let fallas = 0;
function check(nombre, cond, detalle) {
  console.log(`  ${cond ? 'OK  ' : 'FALLA'} ${nombre}${detalle ? ' — ' + detalle : ''}`);
  if (!cond) fallas++;
}

async function main() {
  const socksPort = await startTor();
  const clients = [];
  for (const host of HOSTS) {
    try { clients.push(await connect(host, socksPort)); } catch (e) { console.log(`  (${host} no respondio)`); }
  }
  if (clients.length < 2) throw new Error('Necesito al menos 2 servidores.');
  const [a, b] = clients;

  const tip = await a.request('blockchain.headers.subscribe');
  console.log(`Tip: ${tip.height}\n`);

  console.log('== 1. ¿Un proof corrupto se detecta? ==');

  // Tx real y confirmada para probar: la ultima del historial de una direccion
  // publica muy usada (la del bloque genesis).
  const dirUsada = 'qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a';
  const L = await import('@bitauth/libauth');
  const lock = L.cashAddressToLockingBytecode('bitcoincash:' + dirUsada);
  const sh = L.binToHex(L.sha256.hash(lock.bytecode).slice().reverse());
  const hist = await a.request('blockchain.scripthash.get_history', sh);
  const confirmadas = hist.filter(h => h.height > 0);
  const txSample = confirmadas[confirmadas.length - 1];
  console.log(`  Tx de prueba: ${txSample.tx_hash.slice(0, 20)}... en bloque ${txSample.height}`);

  const proof = await a.request('blockchain.transaction.get_merkle', txSample.tx_hash, txSample.height);
  const headerTxHex = await a.request('blockchain.block.header', txSample.height);
  const rootDeCabecera = merkleRootFromHeader(headerTxHex);
  const rootCalculado = merkleRootFromProof(txSample.tx_hash, proof.pos, proof.merkle);

  check('el proof legitimo reconstruye el merkle root de la cabecera',
    rootCalculado === rootDeCabecera, `${rootCalculado.slice(0, 16)} vs ${rootDeCabecera.slice(0, 16)}`);

  // Ahora lo importante: corromper un hash de la rama y ver que pasa.
  const ramaCorrupta = [...proof.merkle];
  ramaCorrupta[0] = 'ff'.repeat(32);
  const rootCorrupto = merkleRootFromProof(txSample.tx_hash, proof.pos, ramaCorrupta);
  check('un proof adulterado NO reconstruye el root (se detecta)',
    rootCorrupto !== rootDeCabecera, `da ${rootCorrupto.slice(0, 16)}...`);

  console.log('\n== 2. ¿Los servidores coinciden en la cabecera? ==');
  const headerB = await b.request('blockchain.block.header', txSample.height);
  check('dos operadores devuelven la misma cabecera', headerTxHex === headerB,
    `${a.host} vs ${b.host}`);

  console.log('\n== 3. cp_height: ¿que rango ancla un checkpoint? ==');
  const checkpointSimulado = txSample.height - 1000;

  // Caso A: cabecera ANTERIOR al checkpoint.
  try {
    const anterior = await a.request('blockchain.block.headers', checkpointSimulado - 500, 1, checkpointSimulado);
    check('cabecera anterior al checkpoint: el servidor da root + branch',
      Boolean(anterior.root && anterior.branch), `branch de ${anterior.branch ? anterior.branch.length : 0} hashes`);
  } catch (e) {
    check('cabecera anterior al checkpoint: el servidor da root + branch', false, e.message);
  }

  // Caso B: cabecera POSTERIOR al checkpoint — el caso de una tx reciente.
  // Se espera que NO se pueda: es el limite que decide si el punto 3 sirve
  // para las transacciones que le importan al usuario o solo para historia.
  try {
    const posterior = await a.request('blockchain.block.headers', checkpointSimulado + 500, 1, checkpointSimulado);
    console.log(`  HALLAZGO INESPERADO: ancla hacia adelante (root ${posterior.root ? 'si' : 'no'})`);
    fallas++;
  } catch (e) {
    console.log('  CONFIRMADO: cp_height NO ancla cabeceras posteriores al checkpoint.');
    console.log(`             El servidor responde: "${e.message}"`);
    console.log('             => un checkpoint fijo verifica historia vieja, no transacciones nuevas.');
  }

  console.log('\n== 4. Costo real de bajar cabeceras desde un checkpoint ==');
  for (const [etiqueta, bloques] of [['1 mes', 4320], ['6 meses', 26000], ['1 año', 52560]]) {
    const desde = tip.height - bloques;
    const t0 = Date.now();
    let bajados = 0, bytesHex = 0, requests = 0;
    let cursor = desde;
    while (cursor <= tip.height) {
      const lote = await a.request('blockchain.block.headers', cursor, 2016);
      requests++;
      bajados += lote.count;
      bytesHex += lote.hex.length;
      if (lote.count === 0) break;
      cursor += lote.count;
    }
    const ms = Date.now() - t0;
    console.log(`  ${etiqueta.padEnd(9)} ${String(bajados).padStart(6)} cabeceras  ` +
      `${String(requests).padStart(3)} requests  ${(bytesHex / 2 / 1024 / 1024).toFixed(1)} MB  ${(ms / 1000).toFixed(1)}s`);
  }

  console.log('\n== 5. ¿El encadenamiento cierra? ==');
  const lote = await a.request('blockchain.block.headers', tip.height - 200, 201);
  const hexHeaders = lote.hex;
  let encadenaOk = true;
  let previo = null;
  for (let i = 0; i < lote.count; i++) {
    const hHex = hexHeaders.slice(i * 160, (i + 1) * 160);
    if (previo && prevHashFromHeader(hHex) !== previo) { encadenaOk = false; break; }
    previo = blockHashFromHeader(hHex);
  }
  check('201 cabeceras encadenan por prev_hash', encadenaOk);

  clients.forEach(c => c.close());
  stopTor();
  console.log(fallas === 0 ? '\nSin fallas.\n' : `\n${fallas} comprobaciones fallaron.\n`);
  process.exit(0);
}

main().catch((e) => {
  console.error('\nError:', e.message);
  stopTor();
  process.exit(1);
});
