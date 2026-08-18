// Benchmark del punto 4 COMPLETO: bajar + verificar de verdad.
//
// bench-headers.mjs midio solo la descarga (23s). Eso no es "blindado": bajar
// cabeceras sin verificarlas no prueba nada. Aca se mide el costo real de las
// cuatro etapas, sobre la cadena entera desde el ancla ASERT:
//
//   1. Descargar          (red, repartida entre operadores)
//   2. Encadenamiento     (cada cabecera apunta a la anterior)
//   3. Proof-of-work      (el hash cumple el target declarado)
//   4. ASERT              (el target declarado es el que corresponde)
//
// La 4 es la que importa: sin ella, un atacante declara la dificultad que
// quiera y el chequeo de PoW pasa igual.
//
// El test de que ASERT esta bien implementado es la cadena misma: si el bits
// calculado coincide con el declarado en las 300.000 cabeceras reales, la
// formula y las constantes son correctas. Si no, no.
//
// Se corre con:  node tools/bench-verify.mjs

import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { SocksProxyAgent } from 'socks-proxy-agent';
import WebSocket from 'ws';

const HOSTS = [
  'bch.imaginary.cash',
  'bch.loping.net',
  'bch.soul-dev.com',
  'fulcrum.jettscythe.xyz',
  'cashnode.bch.ninja',
  'fulcrum.criptolayer.net',
];
const PORT = 50004;
const CHUNK = 2016;
const EN_VUELO = 4;

// Ancla ASERT de BCH (aserti3-2d), activada el 15-nov-2020.
const ASERT_ANCHOR_HEIGHT = 661647;
const HALFLIFE = 172800n;        // 2 dias
const IDEAL_SPACING = 600n;      // 10 minutos
const POW_LIMIT = 0x00000000FFFF0000000000000000000000000000000000000000000000000000n;

const dataDir = path.join(os.tmpdir(), 'ghostwallet-verify-tor', 'data');
let torProcess = null;

function sha256d(buf) {
  return crypto.createHash('sha256').update(
    crypto.createHash('sha256').update(buf).digest()
  ).digest();
}

// --- Lectura de cabeceras (80 bytes, campos little-endian) ---

function headerPrevHash(buf) {
  return Buffer.from(buf.subarray(4, 36)).reverse().toString('hex');
}
function headerTime(buf) {
  return buf.readUInt32LE(68);
}
function headerBits(buf) {
  return buf.readUInt32LE(72);
}
function headerHashHex(buf) {
  return Buffer.from(sha256d(buf)).reverse().toString('hex');
}

// --- Conversion bits <-> target ---

function bitsToTarget(bits) {
  const exponent = bits >>> 24;
  const mantissa = BigInt(bits & 0x007fffff);
  return exponent <= 3
    ? mantissa >> BigInt(8 * (3 - exponent))
    : mantissa << BigInt(8 * (exponent - 3));
}

function targetToBits(target) {
  if (target === 0n) return 0;
  let size = 0;
  for (let t = target; t > 0n; t >>= 8n) size++;
  let compact = size <= 3
    ? Number(target << BigInt(8 * (3 - size)))
    : Number(target >> BigInt(8 * (size - 3)));
  // El bit alto significaria signo negativo: se corre un byte.
  if (compact & 0x00800000) {
    compact >>= 8;
    size++;
  }
  return (compact | (size << 24)) >>> 0;
}

// --- ASERT (aserti3-2d), portado de la implementacion de referencia ---
//
// target = anchorTarget * 2^((tiempo_transcurrido - 600*(bloques+1)) / 172800)
//
// La exponenciacion se hace con enteros: la parte entera del exponente son
// corrimientos de bits, y la fraccionaria sale de una aproximacion cubica.
function calculateASERT(anchorTarget, timeDiff, heightDiff) {
  let exponent = ((timeDiff - IDEAL_SPACING * (heightDiff + 1n)) * 65536n) / HALFLIFE;

  const shifts = exponent >> 16n;
  exponent -= shifts * 65536n;
  // Aca 0 <= exponent < 65536.

  const factor = 65536n + ((195766423245049n * exponent +
                            971821376n * exponent * exponent +
                            5127n * exponent * exponent * exponent +
                            (1n << 47n)) >> 48n);

  let next = anchorTarget * factor;
  next = shifts < 0n ? next >> -shifts : next << shifts;
  next >>= 16n;

  if (next === 0n) return 1n;
  if (next > POW_LIMIT) return POW_LIMIT;
  return next;
}

// --- Tor / red (igual que los otros probes) ---

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
      if (!settled) { settled = true; try { ws.close(); } catch {} reject(new Error('timeout ' + host)); }
    }, 30000);
    ws.on('open', () => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      resolve({
        host,
        request(method, ...params) {
          return new Promise((res, rej) => {
            const id = nextId++;
            const t = setTimeout(() => { pending.delete(id); rej(new Error('timeout ' + method)); }, 60000);
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

async function conLimite(tareas, limite) {
  const out = new Array(tareas.length);
  let siguiente = 0;
  await Promise.all(Array.from({ length: Math.min(limite, tareas.length) }, async () => {
    while (true) {
      const i = siguiente++;
      if (i >= tareas.length) return;
      out[i] = await tareas[i]();
    }
  }));
  return out;
}

async function main() {
  const socksPort = await startTor();

  const clients = [];
  for (const host of HOSTS) {
    try { clients.push(await connect(host, socksPort)); } catch { /* fuera */ }
  }
  if (clients.length < 2) throw new Error('Necesito al menos 2 servidores.');
  console.log(`Conectado a ${clients.length} operadores.`);

  const tip = await clients[0].request('blockchain.headers.subscribe');
  // Se arranca en anchor-1: ASERT necesita el timestamp del padre del ancla.
  const desde = ASERT_ANCHOR_HEIGHT - 1;
  const total = tip.height - desde + 1;
  console.log(`Rango: ${desde} → ${tip.height}  (${total} cabeceras)\n`);

  // --- 1. Descargar ---
  const tramos = [];
  for (let c = desde; c <= tip.height; c += CHUNK) {
    tramos.push({ start: c, count: Math.min(CHUNK, tip.height - c + 1) });
  }
  const porServidor = clients.map(() => []);
  tramos.forEach((t, i) => porServidor[i % clients.length].push(t));

  // Cache por tramo, no por rango completo: el tip se mueve entre corridas, y
  // un tramo que falla no debe tirar abajo los 150 que ya salieron bien.
  const cacheDir = path.join(os.tmpdir(), 'ghostwallet-headers-cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  const sinCache = process.argv.includes('--no-cache');

  // Un tramo que falla se reintenta contra otro operador: sobre Tor, un
  // circuito lento es normal y no significa que el servidor este mal.
  async function bajarTramo(tramo, clienteBase) {
    const cachePath = path.join(cacheDir, `${tramo.start}-${tramo.count}.hex`);
    if (!sinCache && fs.existsSync(cachePath)) {
      return { start: tramo.start, hex: fs.readFileSync(cachePath, 'utf8'), cacheado: true };
    }
    let ultimoError;
    for (let intento = 0; intento < clients.length; intento++) {
      const client = clients[(clienteBase + intento) % clients.length];
      try {
        const lote = await client.request('blockchain.block.headers', tramo.start, tramo.count);
        fs.writeFileSync(cachePath, lote.hex);
        return { start: tramo.start, hex: lote.hex, cacheado: false };
      } catch (e) { ultimoError = e; }
    }
    throw new Error(`tramo ${tramo.start} fallo en los ${clients.length} operadores: ${ultimoError.message}`);
  }

  const t0 = Date.now();
  const grupos = await Promise.all(clients.map((_client, i) =>
    conLimite(porServidor[i].map(t => () => bajarTramo(t, i)), EN_VUELO)
  ));
  const planos = grupos.flat().sort((a, b) => a.start - b.start);
  const hexTotal = planos.map(r => r.hex).join('');
  const desdeCache = planos.filter(r => r.cacheado).length;
  const msDescarga = desdeCache === planos.length ? 0 : Date.now() - t0;

  const cabeceras = Buffer.from(hexTotal, 'hex');
  const cantidad = cabeceras.length / 80;
  console.log(`  1. Descarga          ${msDescarga > 0 ? (msDescarga / 1000).toFixed(1).padStart(6) + 's' : '  cache'}   ` +
    `${cantidad} cabeceras, ${(cabeceras.length / 1024 / 1024).toFixed(1)} MB` +
    (desdeCache > 0 && msDescarga > 0 ? `  (${desdeCache}/${planos.length} tramos ya cacheados)` : ''));

  const vista = i => cabeceras.subarray(i * 80, (i + 1) * 80);

  // --- 2. Encadenamiento ---
  const t1 = Date.now();
  let rotas = 0;
  let hashPrevio = headerHashHex(vista(0));
  for (let i = 1; i < cantidad; i++) {
    if (headerPrevHash(vista(i)) !== hashPrevio) rotas++;
    hashPrevio = headerHashHex(vista(i));
  }
  const msCadena = Date.now() - t1;
  console.log(`  2. Encadenamiento    ${(msCadena / 1000).toFixed(1).padStart(6)}s   ` +
    `${rotas === 0 ? 'todas enganchan' : rotas + ' ROTAS'}`);

  // --- 3. Proof-of-work ---
  const t2 = Date.now();
  let powMalos = 0;
  for (let i = 0; i < cantidad; i++) {
    const h = vista(i);
    const target = bitsToTarget(headerBits(h));
    const hash = BigInt('0x' + headerHashHex(h));
    if (hash > target) powMalos++;
  }
  const msPow = Date.now() - t2;
  console.log(`  3. Proof-of-work     ${(msPow / 1000).toFixed(1).padStart(6)}s   ` +
    `${powMalos === 0 ? 'todas cumplen su target' : powMalos + ' NO CUMPLEN'}`);

  // --- 4. ASERT ---
  // El ancla: bits del bloque 661647, timestamp de su padre (661646).
  const anchorIdx = 1; // desde = anchor - 1, asi que el ancla esta en indice 1
  const anchorBits = headerBits(vista(anchorIdx));
  const anchorParentTime = BigInt(headerTime(vista(anchorIdx - 1)));
  const anchorTarget = bitsToTarget(anchorBits);
  console.log(`\n  Ancla ASERT: altura ${ASERT_ANCHOR_HEIGHT}  bits 0x${anchorBits.toString(16)}  ` +
    `parentTime ${anchorParentTime}`);

  const t3 = Date.now();
  let asertOk = 0, asertMal = 0;
  const ejemplos = [];
  for (let i = anchorIdx + 1; i < cantidad; i++) {
    const h = vista(i);
    // ASERT calcula la dificultad del bloque N a partir del bloque N-1: el
    // timestamp y la altura que entran en la formula son los del padre.
    const padre = vista(i - 1);
    const alturaPadre = desde + i - 1;
    const heightDiff = BigInt(alturaPadre - ASERT_ANCHOR_HEIGHT);
    const timeDiff = BigInt(headerTime(padre)) - anchorParentTime;

    const altura = desde + i;
    const esperado = targetToBits(calculateASERT(anchorTarget, timeDiff, heightDiff));
    const declarado = headerBits(h);

    if (esperado === declarado) asertOk++;
    else {
      asertMal++;
      if (ejemplos.length < 3) {
        ejemplos.push(`altura ${altura}: esperado 0x${esperado.toString(16)}, declarado 0x${declarado.toString(16)}`);
      }
    }
  }
  const msAsert = Date.now() - t3;
  console.log(`  4. ASERT             ${(msAsert / 1000).toFixed(1).padStart(6)}s   ` +
    `${asertOk} coinciden, ${asertMal} no`);
  for (const e of ejemplos) console.log(`       ${e}`);

  const msTotal = msDescarga + msCadena + msPow + msAsert;
  console.log(`\n  TOTAL                ${(msTotal / 1000).toFixed(1).padStart(6)}s   ` +
    `(${(msDescarga / 1000).toFixed(1)}s red + ${((msCadena + msPow + msAsert) / 1000).toFixed(1)}s CPU)`);

  if (asertMal === 0 && rotas === 0 && powMalos === 0) {
    console.log('\n  La cadena entera valida: encadena, cumple PoW, y cada dificultad');
    console.log('  es exactamente la que ASERT exige desde el ancla de 2020.\n');
  } else {
    console.log('\n  Hay discrepancias — revisar antes de sacar conclusiones.\n');
  }

  clients.forEach(c => c.close());
  stopTor();
  process.exit(0);
}

main().catch((e) => {
  console.error('\nError:', e.message);
  stopTor();
  process.exit(1);
});
