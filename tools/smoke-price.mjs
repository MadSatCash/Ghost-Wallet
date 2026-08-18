// Smoke del precio: corre fetchBchPrice() de src/core/network.js tal cual, por
// Tor, y muestra que devuelve para las 15 monedas de la UI.
//
// A diferencia de tools/probe-price.mjs (que prueba los endpoints uno por uno
// con una copia del transporte), esto ejercita el codigo de produccion: si aca
// falta una moneda, en la wallet tambien falta.
//
// Se corre con:  node tools/smoke-price.mjs

import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const network = require('../src/core/network.js');

// Las mismas 15 que arma el renderer desde CURRENCIES.
const CURRENCIES = 'usd,eur,ars,brl,mxn,clp,cop,pen,uyu,pyg,bob,gbp,jpy,cad,aud';

const dataDir = path.join(os.tmpdir(), 'ghostwallet-smoke-tor-price', 'data');

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
      if (/Bootstrapped (\d+)%/.test(line)) process.stdout.write('.');
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

async function main() {
  const socksPort = await startTor();
  network.setUseTor(true);
  network.setTorPort(socksPort);

  const t0 = Date.now();
  const payload = await network.fetchBchPrice(CURRENCIES, { force: true });
  const ms = Date.now() - t0;

  console.log(`\nfetchBchPrice() en ${ms}ms — fuentes: ${payload.source}`);
  console.log(`Faltantes: ${payload.missing.length ? payload.missing.join(',') : 'ninguna'}`);
  if (payload.errors.length) console.log(`Errores: ${payload.errors.join(' | ')}`);

  console.log('\nCotizacion por moneda:');
  CURRENCIES.split(',').forEach(code => {
    const value = payload.prices[code];
    console.log(`  ${code.toUpperCase().padEnd(4)} ${value ? value.toFixed(2).padStart(16) : '(sin precio)'.padStart(16)}`);
  });

  const fallaron = payload.missing.length;
  console.log(fallaron ? `\nFALLA: ${fallaron} moneda(s) sin cotizacion.` : '\nOK: las 15 monedas con cotizacion.');

  stopTor();
  process.exit(fallaron ? 1 : 0);
}

main().catch(e => {
  console.error('\nError:', e.message);
  stopTor();
  process.exit(1);
});
