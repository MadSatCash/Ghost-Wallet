// Benchmark: ¿cuanto se puede acelerar la bajada de cabeceras por Tor?
//
// El baseline (34s por un año de cabeceras) era secuencial contra un solo
// servidor. Eso deja dos cosas sobre la mesa: el RTT de cada request, y el
// ancho de banda de un unico circuito Tor. Este script mide cual de las dos
// pesa, probando cuatro estrategias sobre el MISMO rango.
//
// Se corre con:  node tools/bench-headers.mjs [meses]
//
// Ademas verifica que las cuatro devuelvan exactamente lo mismo y que el
// resultado encadene por prev_hash — si repartir entre servidores rompiera
// algo, se veria aca.

import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { SocksProxyAgent } from 'socks-proxy-agent';
import WebSocket from 'ws';

// Un host por operador: repartir entre dos servidores del mismo dueño no suma
// circuitos independientes de verdad.
const HOSTS = [
  'bch.imaginary.cash',
  'bch.loping.net',
  'bch.soul-dev.com',
  'fulcrum.jettscythe.xyz',
  'cashnode.bch.ninja',
  'fulcrum.criptolayer.net',
];
const PORT = 50004;
const CHUNK = 2016;               // maximo que acepta Fulcrum por request

// Altura del ancla ASERT de BCH (15-nov-2020): el punto mas atras al que hay
// que ir si no hay checkpoint. `full` mide ese caso completo.
const ASERT_ANCHOR = 661647;

const MODO_FULL = process.argv[2] === 'full';
const MESES = Number(process.argv[2] || 12);
const BLOQUES = Math.round(4320 * MESES);

const dataDir = path.join(os.tmpdir(), 'ghostwallet-bench-tor', 'data');
let torProcess = null;

function sha256d(buf) {
  return crypto.createHash('sha256').update(
    crypto.createHash('sha256').update(buf).digest()
  ).digest();
}

function prevHashFromHeader(hex) {
  return Buffer.from(Buffer.from(hex, 'hex').subarray(4, 36)).reverse().toString('hex');
}

function blockHashFromHeader(hex) {
  return Buffer.from(sha256d(Buffer.from(hex, 'hex'))).reverse().toString('hex');
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

// Lista de tramos a bajar: [{ start, count }]
function planificarTramos(desde, hasta) {
  const tramos = [];
  for (let cursor = desde; cursor <= hasta; cursor += CHUNK) {
    tramos.push({ start: cursor, count: Math.min(CHUNK, hasta - cursor + 1) });
  }
  return tramos;
}

// Junta los tramos en un solo string hex ordenado por altura.
function ensamblar(resultados) {
  return resultados
    .slice()
    .sort((x, y) => x.start - y.start)
    .map(r => r.hex)
    .join('');
}

// Corre `tareas` con como mucho `limite` en vuelo a la vez.
async function conLimite(tareas, limite) {
  const resultados = new Array(tareas.length);
  let siguiente = 0;
  const trabajadores = Array.from({ length: Math.min(limite, tareas.length) }, async () => {
    while (true) {
      const i = siguiente++;
      if (i >= tareas.length) return;
      resultados[i] = await tareas[i]();
    }
  });
  await Promise.all(trabajadores);
  return resultados;
}

async function bajarTramo(client, tramo) {
  const lote = await client.request('blockchain.block.headers', tramo.start, tramo.count);
  return { start: tramo.start, hex: lote.hex, count: lote.count };
}

// --- Estrategias ---

async function secuencialUnServidor(clients, tramos) {
  const out = [];
  for (const tramo of tramos) out.push(await bajarTramo(clients[0], tramo));
  return out;
}

async function pipelineUnServidor(clients, tramos, enVuelo) {
  return conLimite(tramos.map(t => () => bajarTramo(clients[0], t)), enVuelo);
}

async function repartidoSecuencial(clients, tramos) {
  // Cada servidor se lleva un tercio, y dentro de su tercio va uno por uno.
  const porServidor = clients.map(() => []);
  tramos.forEach((t, i) => porServidor[i % clients.length].push(t));
  const grupos = await Promise.all(
    clients.map(async (client, i) => {
      const out = [];
      for (const tramo of porServidor[i]) out.push(await bajarTramo(client, tramo));
      return out;
    })
  );
  return grupos.flat();
}

async function repartidoPipeline(clients, tramos, enVuelo) {
  const porServidor = clients.map(() => []);
  tramos.forEach((t, i) => porServidor[i % clients.length].push(t));
  const grupos = await Promise.all(
    clients.map((client, i) =>
      conLimite(porServidor[i].map(t => () => bajarTramo(client, t)), enVuelo))
  );
  return grupos.flat();
}

function verificarEncadenado(hexTotal) {
  const total = hexTotal.length / 160;
  let previo = null;
  for (let i = 0; i < total; i++) {
    const h = hexTotal.slice(i * 160, (i + 1) * 160);
    if (previo && prevHashFromHeader(h) !== previo) return { ok: false, roto: i };
    previo = blockHashFromHeader(h);
  }
  return { ok: true, total };
}

async function main() {
  const socksPort = await startTor();

  const clients = [];
  for (const host of HOSTS) {
    try { clients.push(await connect(host, socksPort)); }
    catch { console.log(`  (${host} no respondio)`); }
  }
  if (clients.length < 2) throw new Error('Necesito al menos 2 servidores.');
  console.log(`Conectado a ${clients.length} servidores: ${clients.map(c => c.host).join(', ')}`);

  const tip = await clients[0].request('blockchain.headers.subscribe');
  const desde = MODO_FULL ? ASERT_ANCHOR : tip.height - BLOQUES;
  const tramos = planificarTramos(desde, tip.height);
  console.log(`Rango: ${desde} → ${tip.height}  (${tip.height - desde} bloques, ${tramos.length} tramos de ${CHUNK})\n`);

  // En modo full solo interesa el mejor caso: correr las cinco estrategias
  // sobre 300k cabeceras seria bajar 24 MB cinco veces sin aprender nada nuevo.
  const estrategias = MODO_FULL
    ? [[`repartido en ${clients.length} + pipeline x4`, () => repartidoPipeline(clients, tramos, 4)]]
    : [
      ['secuencial, 1 servidor',        () => secuencialUnServidor(clients, tramos)],
      ['pipeline x4, 1 servidor',       () => pipelineUnServidor(clients, tramos, 4)],
      ['pipeline x8, 1 servidor',       () => pipelineUnServidor(clients, tramos, 8)],
      [`repartido en ${clients.length}, secuencial`,  () => repartidoSecuencial(clients, tramos)],
      [`repartido en ${clients.length} + pipeline x4`, () => repartidoPipeline(clients, tramos, 4)],
    ];

  let referencia = null;
  const medidas = [];

  for (const [nombre, correr] of estrategias) {
    process.stdout.write(`  ${nombre.padEnd(30)} `);
    const t0 = Date.now();
    let hexTotal, ms, error = null;
    try {
      const resultados = await correr();
      ms = Date.now() - t0;
      hexTotal = ensamblar(resultados);
    } catch (e) {
      ms = Date.now() - t0;
      error = e.message;
    }

    if (error) {
      console.log(`FALLO tras ${(ms / 1000).toFixed(1)}s — ${error}`);
      medidas.push({ nombre, error });
      continue;
    }

    const mb = hexTotal.length / 2 / 1024 / 1024;
    const kbs = (hexTotal.length / 1024) / (ms / 1000); // hex sobre el cable
    if (referencia === null) referencia = ms;
    const speedup = referencia / ms;

    console.log(`${(ms / 1000).toFixed(1).padStart(6)}s   ${mb.toFixed(1)} MB   ` +
      `${Math.round(kbs)} KB/s cable   ${speedup.toFixed(2)}x`);

    medidas.push({ nombre, ms, hexTotal, speedup });
  }

  console.log('\n== Verificacion: ¿todas dan lo mismo y encadena? ==');
  const buenas = medidas.filter(m => m.hexTotal);
  const primera = buenas[0].hexTotal;
  for (const m of buenas) {
    const igual = m.hexTotal === primera;
    console.log(`  ${igual ? 'OK  ' : 'FALLA'} ${m.nombre.padEnd(30)} ${igual ? 'identico al baseline' : 'DIFIERE'}`);
  }

  const cadena = verificarEncadenado(primera);
  console.log(`  ${cadena.ok ? 'OK  ' : 'FALLA'} encadenamiento por prev_hash` +
    (cadena.ok ? ` — ${cadena.total} cabeceras seguidas` : ` — se rompe en la ${cadena.roto}`));

  const mejor = buenas.slice().sort((a, b) => a.ms - b.ms)[0];
  console.log(`\nMejor: ${mejor.nombre} — ${(mejor.ms / 1000).toFixed(1)}s (${mejor.speedup.toFixed(2)}x vs baseline)\n`);

  clients.forEach(c => c.close());
  stopTor();
  process.exit(0);
}

main().catch((e) => {
  console.error('\nError:', e.message);
  stopTor();
  process.exit(1);
});
