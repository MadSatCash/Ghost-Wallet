// Sonda de servidores Fulcrum (Electrum) de BCH, por Tor.
//
// Para que sirve: la lista de SERVERS en src/core/network.js no se puede
// mantener de memoria — los servidores publicos aparecen y desaparecen. Esto
// prueba de verdad cada candidato y dice cual sigue vivo, a que altura esta y
// si soporta las llamadas que necesita la verificacion.
//
// Se corre con:  node tools/probe-servers.mjs
//
// Levanta su propio Tor con un DataDirectory aparte, asi se puede correr con
// la wallet abierta sin pelearse por el lock.

import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { SocksProxyAgent } from 'socks-proxy-agent';
import WebSocket from 'ws';

// Candidatos: los 5 que ya usa la wallet, mas los publicos que se conocen.
// Los que no respondan quedan afuera de la lista final: no se adivina.
const CANDIDATES = [
  'bch.imaginary.cash',
  'electrum.imaginary.cash',
  'fulcrum.fountainhead.cash',
  'bch.loping.net',
  'blackie.c3-soft.com',
  'electroncash.de',
  'bch.soul-dev.com',
  'electrum.bitcoinverde.org',
  'cashnode.bch.ninja',
  'fulcrum.jettscythe.xyz',
  'bch.cyberbits.eu',
  'fulcrum.criptolayer.net',
  'bitcoincash.network',
  'electrum.bitcoinunlimited.info',
  'bch.stitthappens.com',
  'fulcrum.aglauck.com',
  'electrs.bitcoinunlimited.info',
  'bch0.kister.net',
  'node.minisatoshi.cash',
  'electrum.imaginary.cash',
];

const PORT = 50004; // WSS, el mismo que usa la wallet
const CONNECT_TIMEOUT_MS = 25000;
const REQUEST_TIMEOUT_MS = 20000;

const torDir = path.join(os.tmpdir(), 'ghostwallet-probe-tor');
const dataDir = path.join(torDir, 'data');

function findTorExe() {
  const roaming = process.env.APPDATA || path.join(os.homedir(), '.config');
  const candidates = [
    path.join(roaming, 'bch-wallet', 'tor-bin', 'tor', 'tor.exe'),
    path.join(roaming, 'bch-wallet', 'tor-bin', 'tor', 'tor'),
    path.join(os.homedir(), '.config', 'bch-wallet', 'tor-bin', 'tor', 'tor'),
    path.join(os.homedir(), 'Library', 'Application Support', 'bch-wallet', 'tor-bin', 'tor', 'tor'),
  ];
  return candidates.find(p => fs.existsSync(p)) || null;
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

let torProcess = null;

async function startTor() {
  const torExe = findTorExe();
  if (!torExe) throw new Error('No encontre tor.exe. Abri la wallet una vez para que lo descargue.');

  fs.mkdirSync(dataDir, { recursive: true });
  if (process.platform !== 'win32') {
    try { fs.chmodSync(torExe, 0o755); } catch { /* noop */ }
  }

  const socksPort = await getFreePort();
  process.stdout.write(`Levantando Tor (SOCKS ${socksPort})`);

  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      stopTor();
      reject(new Error('Tor no llego a Bootstrap 100% en 90s.'));
    }, 90000);

    torProcess = spawn(torExe, [
      '--SocksPort', `127.0.0.1:${socksPort}`,
      '--DataDirectory', dataDir,
      '--ClientOnly', '1',
    ]);

    torProcess.stdout.on('data', (buf) => {
      const line = buf.toString();
      const pct = line.match(/Bootstrapped (\d+)%/);
      if (pct) process.stdout.write('.');
      if (line.includes('Bootstrapped 100%')) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        console.log(' listo.\n');
        resolve(socksPort);
      }
    });
    torProcess.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });
  });
}

function stopTor() {
  if (torProcess) {
    try { torProcess.kill(); } catch { /* noop */ }
    torProcess = null;
  }
}

// Cliente Electrum minimo sobre WSS: JSON-RPC, un mensaje por frame.
function connectElectrum(host, socksPort) {
  return new Promise((resolve, reject) => {
    const agent = new SocksProxyAgent(`socks5h://127.0.0.1:${socksPort}`);
    const ws = new WebSocket(`wss://${host}:${PORT}`, undefined, { agent });
    const pending = new Map();
    let nextId = 1;
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch { /* noop */ }
      reject(new Error(`timeout de conexion (${CONNECT_TIMEOUT_MS / 1000}s)`));
    }, CONNECT_TIMEOUT_MS);

    ws.on('open', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        request(method, ...params) {
          return new Promise((res, rej) => {
            const id = nextId++;
            const reqTimer = setTimeout(() => {
              pending.delete(id);
              rej(new Error(`timeout de ${method}`));
            }, REQUEST_TIMEOUT_MS);
            pending.set(id, { res, rej, reqTimer });
            ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
          });
        },
        close() { try { ws.close(); } catch { /* noop */ } },
      });
    });

    ws.on('message', (data) => {
      for (const line of data.toString().split('\n')) {
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        const entry = pending.get(msg.id);
        if (!entry) continue;
        pending.delete(msg.id);
        clearTimeout(entry.reqTimer);
        if (msg.error) entry.rej(new Error(msg.error.message || JSON.stringify(msg.error)));
        else entry.res(msg.result);
      }
    });

    ws.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });
  });
}

async function probe(host, socksPort) {
  const started = Date.now();
  let client = null;
  try {
    client = await connectElectrum(host, socksPort);

    const version = await client.request('server.version', 'GhostWalletProbe', '1.4.1');
    const tip = await client.request('blockchain.headers.subscribe');

    // Soporte de cp_height: pedir 1 cabecera vieja con checkpoint en tip-10.
    // Si devuelve `root` + `branch`, se puede verificar una cabecera suelta
    // sin bajar la cadena entera.
    let cpHeight = null;
    try {
      const cp = await client.request('blockchain.block.headers', 700000, 1, tip.height - 10);
      cpHeight = cp && cp.root && Array.isArray(cp.branch)
        ? { ok: true, branchLen: cp.branch.length, rootPrefix: cp.root.slice(0, 16) }
        : { ok: false, why: 'respondio sin root/branch' };
    } catch (e) {
      cpHeight = { ok: false, why: String(e.message || e).slice(0, 60) };
    }

    // Cuantas cabeceras deja pedir de una: define el costo de la descarga.
    let maxPerRequest = null;
    try {
      const batch = await client.request('blockchain.block.headers', 700000, 4096);
      maxPerRequest = batch && batch.max ? batch.max : (batch ? batch.count : null);
    } catch { /* noop */ }

    return {
      host,
      ok: true,
      ms: Date.now() - started,
      version: Array.isArray(version) ? version[0] : String(version),
      height: tip.height,
      cpHeight,
      maxPerRequest,
    };
  } catch (e) {
    return { host, ok: false, ms: Date.now() - started, error: String(e.message || e).slice(0, 70) };
  } finally {
    if (client) client.close();
  }
}

async function main() {
  const socksPort = await startTor();

  const unique = [...new Set(CANDIDATES)];
  console.log(`Probando ${unique.length} candidatos por Tor (paralelo)...\n`);

  const results = await Promise.all(unique.map(h => probe(h, socksPort)));
  results.sort((a, b) => (b.ok - a.ok) || (a.ms - b.ms));

  const vivos = results.filter(r => r.ok);
  const muertos = results.filter(r => !r.ok);

  console.log('=== VIVOS ===');
  for (const r of vivos) {
    console.log(
      `  ${r.host.padEnd(32)} h=${r.height}  ${String(r.ms + 'ms').padEnd(8)} ` +
      `max=${r.maxPerRequest}  cp_height=${r.cpHeight.ok ? 'SI (branch ' + r.cpHeight.branchLen + ')' : 'NO — ' + r.cpHeight.why}  ${r.version}`
    );
  }

  console.log('\n=== NO RESPONDEN ===');
  for (const r of muertos) console.log(`  ${r.host.padEnd(32)} ${r.error}`);

  if (vivos.length) {
    const alturas = vivos.map(r => r.height);
    console.log(`\nAlturas: min=${Math.min(...alturas)} max=${Math.max(...alturas)} (desfase ${Math.max(...alturas) - Math.min(...alturas)} bloques)`);
  }

  stopTor();
  process.exit(0);
}

main().catch((e) => {
  console.error('\nError:', e.message);
  stopTor();
  process.exit(1);
});
