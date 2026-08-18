// Prueba de humo del cruce entre operadores, contra la red de verdad.
//
// Los tests de test/wallet.test.js prueban el comparador con vectores fijos.
// Esto prueba lo otro: que el pool levante varias conexiones por Tor, que las
// respuestas reales de servidores distintos coincidan, y que el veredicto salga
// verificado. Si esto falla, el comparador puede estar perfecto igual.
//
// Se corre con:  node tools/smoke-consensus.mjs [direccion]
//
// Por defecto usa la direccion de clave privada = 1, que es publica, conocida y
// suele tener polvo encima — sirve para ejercitar el camino de UTXOs.

import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const network = require('../src/core/network.js');

const ADDRESS = process.argv[2] || 'bitcoincash:qp63uahgrxged4z5jswyt5dn5v3lzsem6cy4spdc2h';

const dataDir = path.join(os.tmpdir(), 'ghostwallet-smoke-tor', 'data');
let torProcess = null;

function findTorExe() {
  const roaming = process.env.APPDATA || path.join(os.homedir(), '.config');
  return [
    path.join(roaming, 'bch-wallet', 'tor-bin', 'tor', 'tor.exe'),
    path.join(roaming, 'bch-wallet', 'tor-bin', 'tor', 'tor'),
    path.join(os.homedir(), '.config', 'bch-wallet', 'tor-bin', 'tor', 'tor'),
    path.join(os.homedir(), 'Library', 'Application Support', 'bch-wallet', 'tor-bin', 'tor', 'tor'),
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
      if (/Bootstrapped \d+%/.test(line)) process.stdout.write('.');
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

let fallas = 0;
function check(nombre, condicion, detalle) {
  console.log(`  ${condicion ? 'OK  ' : 'FALLA'} ${nombre}${detalle ? ' — ' + detalle : ''}`);
  if (!condicion) fallas++;
}

async function main() {
  const socksPort = await startTor();
  network.setUseTor(true);
  network.setTorPort(socksPort);

  console.log('== Pool ==');
  const t0 = Date.now();
  const balance = await network.getBalance(ADDRESS);
  const msPrimera = Date.now() - t0;

  const pool = network.poolStatus();
  console.log(`  Conectado a ${pool.connected}/${pool.target} operadores en ${msPrimera}ms:`);
  for (const op of pool.operators) console.log(`    · ${op.operator.padEnd(18)} ${op.host.padEnd(28)} h=${op.height}`);

  const operadoresUnicos = new Set(pool.operators.map(o => o.operator));
  check('el pool tiene al menos 2 operadores', pool.connected >= 2, `${pool.connected} conectados`);
  check('no hay operadores repetidos en el pool', operadoresUnicos.size === pool.operators.length);
  check('todos reportan una altura sensata', pool.operators.every(o => o.height > 900000));

  console.log('\n== Saldo ==');
  console.log(`  ${ADDRESS}`);
  console.log(`  confirmado=${balance.confirmed} sats  sin confirmar=${balance.unconfirmed} sats`);
  console.log(`  ${balance.verification.detail}`);
  check('el saldo salio verificado', balance.verification.verified === true);
  check('coincidieron al menos 2 operadores', balance.verification.agreedBy.length >= 2);
  check('nadie discrepo', balance.verification.dissentBy.length === 0);

  console.log('\n== UTXOs ==');
  try {
    const utxos = await network.getUtxos(ADDRESS);
    const total = utxos.reduce((s, u) => s + u.value, 0);
    console.log(`  ${utxos.length} UTXOs confirmados, ${total} sats`);
    check('getUtxos devolvio sin lanzar (hubo consenso)', true);
    check('el total de UTXOs coincide con el saldo confirmado', total === balance.confirmed,
      `utxos=${total} balance=${balance.confirmed}`);
  } catch (e) {
    check('getUtxos devolvio sin lanzar (hubo consenso)', false, e.message);
  }

  console.log('\n== Cache de conexion ==');
  const t1 = Date.now();
  await network.getBalance(ADDRESS);
  const msSegunda = Date.now() - t1;
  console.log(`  Segunda consulta: ${msSegunda}ms (primera: ${msPrimera}ms)`);
  check('la segunda consulta reutiliza el pool', msSegunda < msPrimera);

  network.disconnect();
  stopTor();

  console.log(fallas === 0 ? '\nTODO OK\n' : `\n${fallas} COMPROBACIONES FALLARON\n`);
  process.exit(fallas === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('\nError:', e.message);
  stopTor();
  process.exit(1);
});
