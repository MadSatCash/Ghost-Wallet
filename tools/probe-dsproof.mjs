// Que soportan los operadores del pool para poder confiar en 0-conf.
//
// BCH no tiene RBF, asi que una tx sin confirmar no se puede reemplazar por
// otra con mas fee: gastar en mempool es parte del diseño. Lo que si puede
// pasar es un doble gasto lanzado en simultaneo, y para eso BCH tiene Double
// Spend Proofs: el nodo que ve las dos versiones emite una prueba.
//
// Esta sonda pregunta a los operadores que usa la wallet si soportan las
// llamadas de dsproof. Sin eso, aceptar 0-conf es a ciegas.

import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { SocksProxyAgent } from 'socks-proxy-agent';
import WebSocket from 'ws';

const OPERADORES = [
  { host: 'bch.imaginary.cash', operator: 'imaginary.cash' },
  { host: 'bch.loping.net', operator: 'loping.net' },
  { host: 'bch.soul-dev.com', operator: 'soul-dev.com' },
  { host: 'fulcrum.jettscythe.xyz', operator: 'jettscythe.xyz' },
  { host: 'cashnode.bch.ninja', operator: 'bch.ninja' },
  { host: 'fulcrum.criptolayer.net', operator: 'criptolayer.net' },
];

const PORT = 50004;
const CONNECT_TIMEOUT_MS = 25000;
const REQUEST_TIMEOUT_MS = 20000;

const dataDir = path.join(os.tmpdir(), 'ghostwallet-probe-tor', 'data');
let torProcess = null;

function findTorExe() {
  const roaming = process.env.APPDATA || path.join(os.homedir(), '.config');
  return [
    path.join(roaming, 'bch-wallet', 'tor-bin', 'tor', 'tor.exe'),
    path.join(roaming, 'bch-wallet', 'tor-bin', 'tor', 'tor'),
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
  process.stdout.write('Levantando Tor');
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true; stopTor(); reject(new Error('Tor no bootstrapeo'));
    }, 90000);
    torProcess = spawn(torExe, ['--SocksPort', '127.0.0.1:' + socksPort,
      '--DataDirectory', dataDir, '--ClientOnly', '1']);
    torProcess.stdout.on('data', (buf) => {
      const line = buf.toString();
      if (/Bootstrapped \d+%/.test(line)) process.stdout.write('.');
      if (line.includes('Bootstrapped 100%')) {
        if (settled) return;
        settled = true; clearTimeout(timer);
        console.log(' listo.\n'); resolve(socksPort);
      }
    });
    torProcess.on('error', (e) => {
      if (settled) return;
      settled = true; clearTimeout(timer); reject(e);
    });
  });
}

function stopTor() {
  if (torProcess) { try { torProcess.kill(); } catch { /* noop */ } torProcess = null; }
}

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
      reject(new Error('timeout de conexion'));
    }, CONNECT_TIMEOUT_MS);

    ws.on('open', () => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      resolve({
        request(method, ...params) {
          return new Promise((res, rej) => {
            const id = nextId++;
            const reqTimer = setTimeout(() => {
              pending.delete(id);
              rej(new Error('timeout de ' + method));
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
      settled = true; clearTimeout(timer); reject(e);
    });
  });
}

async function probar(entry, socksPort) {
  let client = null;
  const fila = { ...entry };
  try {
    client = await connectElectrum(entry.host, socksPort);
    const version = await client.request('server.version', 'GhostWalletProbe', '1.4.1');
    fila.version = Array.isArray(version) ? version[0] : String(version);

    // dsproof.list: los txid con prueba de doble gasto en el mempool ahora.
    // Que responda (aunque sea vacio) prueba que el servidor la soporta.
    try {
      const lista = await client.request('blockchain.transaction.dsproof.list');
      fila.dsproofList = Array.isArray(lista) ? 'OK (' + lista.length + ' en mempool)' : 'respondio raro';
    } catch (e) {
      fila.dsproofList = 'NO: ' + String(e.message || e).slice(0, 40);
    }

    // dsproof.get sobre un txid inexistente: si el metodo existe devuelve null;
    // si no existe, el servidor contesta "unknown method".
    try {
      const r = await client.request('blockchain.transaction.dsproof.get',
        '0000000000000000000000000000000000000000000000000000000000000000');
      fila.dsproofGet = 'OK (' + JSON.stringify(r) + ')';
    } catch (e) {
      const msg = String(e.message || e);
      fila.dsproofGet = /unknown method|not found|no such/i.test(msg)
        ? 'NO: metodo desconocido'
        : 'OK-ish: ' + msg.slice(0, 40);
    }

    // Cuantas tx encadenadas sin confirmar deja el mempool: si BCH quito el
    // limite, gastar 0-conf en cadena no se topea.
    try {
      const info = await client.request('mempool.get_fee_histogram');
      fila.mempool = Array.isArray(info) ? 'OK' : 'raro';
    } catch (e) {
      fila.mempool = 'NO';
    }
  } catch (e) {
    fila.error = String(e.message || e).slice(0, 50);
  } finally {
    if (client) client.close();
  }
  return fila;
}

async function main() {
  const socksPort = await startTor();
  const filas = await Promise.all(OPERADORES.map(o => probar(o, socksPort)));

  console.log('operador'.padEnd(18) + 'dsproof.list'.padEnd(26) + 'dsproof.get'.padEnd(28) + 'version');
  console.log('-'.repeat(90));
  for (const f of filas) {
    if (f.error) {
      console.log(f.operator.padEnd(18) + 'no conecto: ' + f.error);
      continue;
    }
    console.log(f.operator.padEnd(18) +
      String(f.dsproofList).padEnd(26) +
      String(f.dsproofGet).padEnd(28) +
      String(f.version));
  }

  const soportan = filas.filter(f => !f.error && String(f.dsproofList).startsWith('OK')).length;
  console.log('\n' + soportan + ' de ' + filas.length + ' operadores soportan Double Spend Proofs.');

  stopTor();
  process.exit(0);
}

main().catch((e) => { console.error('\nError:', e.message); stopTor(); process.exit(1); });
