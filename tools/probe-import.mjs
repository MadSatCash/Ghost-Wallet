// Cuanto cuesta importar una wallet, medido contra la red de verdad.
//
// La pantalla de importar dice "conectando con la red" y despues muestra el
// saldo. Entre esas dos cosas hay un barrido BIP44 completo. Este script mide
// cuanto tarda y cuantas consultas cuesta.
//
// Corre el handler de produccion, no una copia: levanta un stub minimo de
// Electron, deja que src/main/main.js registre sus canales IPC y llama a
// 'net:mnemonicReport' como lo llamaria la pantalla. Asi la sonda tambien es
// una prueba de esa implementacion — si el filtro de saldos se rompe, el saldo
// que sale de aca deja de coincidir con el de la referencia.
//
// La referencia es el flujo viejo, replicado abajo tal como estaba antes:
// barrer las dos ramas y pedir el saldo de TODAS las direcciones, incluidas
// las que el barrido acababa de ver sin una sola transaccion.
//
// Se corre con:  node tools/probe-import.mjs [mnemonic]
//
// Sin argumento genera una seed nueva (wallet vacia) — el caso del usuario que
// creo su wallet en otro lado y la trae aca.

import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const network = require('../src/core/network.js');
const wallet = require('../src/core/wallet.js');
const storage = require('../src/core/storage.js');

// Mismas constantes que main.js, para la referencia.
const GAP_LIMIT = 20;
const DISCOVERY_BATCH_SIZE = 20;
const DISCOVERY_HARD_CAP = 2000;

const MNEMONIC = process.argv.slice(2).join(' ').trim() || wallet.generateMnemonic(12);

const dataDir = path.join(os.tmpdir(), 'ghostwallet-smoke-tor', 'data');
let torProcess = null;

function userDataPath() {
  const roaming = process.env.APPDATA || path.join(os.homedir(), '.config');
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'bch-wallet');
  }
  return path.join(roaming, 'bch-wallet');
}

function findTorExe() {
  return [
    path.join(userDataPath(), 'tor-bin', 'tor', 'tor.exe'),
    path.join(userDataPath(), 'tor-bin', 'tor', 'tor'),
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
  process.stdout.write('Levantando Tor (SOCKS ' + socksPort + ')');

  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      stopTor();
      reject(new Error('Tor no llego a Bootstrap 100% en 90s.'));
    }, 90000);

    torProcess = spawn(torExe, [
      '--SocksPort', '127.0.0.1:' + socksPort,
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

// ============================================================
// El main.js de verdad, sin Electron
// ============================================================
//
// main.js registra sus canales dentro de app.whenReady(). El stub resuelve eso
// al toque y despues deja morir a createWindow(): la ventana no hace falta, y
// que muera temprano evita que arranque la sincronizacion de cabeceras, que
// competiria por los mismos circuitos Tor y ensuciaria la medicion.
function cargarHandlersDeProduccion() {
  const handlers = new Map();
  const thenable = {
    then(cb) { try { cb(); } catch { /* la ventana no importa aca */ } return thenable; },
  };

  const electronStub = {
    app: {
      whenReady: () => thenable,
      on: () => {},
      quit: () => {},
      getPath: () => userDataPath(),
    },
    BrowserWindow: function () { throw new Error('sin ventana'); },
    ipcMain: { handle: (canal, fn) => handlers.set(canal, fn) },
    shell: { openExternal: () => {} },
    dialog: {},
  };
  electronStub.BrowserWindow.getAllWindows = () => [];
  electronStub.BrowserWindow.fromWebContents = () => null;

  const cargaOriginal = Module._load;
  Module._load = function (pedido, ...resto) {
    if (pedido === 'electron') return electronStub;
    return cargaOriginal.call(this, pedido, ...resto);
  };
  try {
    require('../src/main/main.js');
  } finally {
    Module._load = cargaOriginal;
  }

  if (!handlers.has('net:mnemonicReport')) {
    throw new Error('main.js no registro net:mnemonicReport — cambio el arranque?');
  }
  return handlers;
}

// El refresh de una wallet guardada (wallet:getHdBalance) sale del vault, que
// pide la contrasena del usuario. Para poder medirlo sin ella se le presta a
// main.js una wallet HD de mentira con el xpub que estamos sondeando: el vault
// no participa, la red si. Es el mismo objeto de modulo que requiere main.js,
// asi que alcanza con cambiarle los metodos.
function prestarWalletDeMentira(xpub) {
  const guardada = {
    id: 'sonda', type: 'mnemonic', name: 'sonda', xpub,
    receiveIndex: 0, changeIndex: 0,
  };
  storage.listWalletsPublic = () => [guardada];
  storage.updateWallet = (_id, cambios) => { Object.assign(guardada, cambios); };
  return guardada;
}

// ============================================================
// Referencia: el flujo viejo
// ============================================================

async function discoverHdChainViejo(xpub, branch) {
  const discovered = [];
  let cursor = 0;
  let consecutiveEmpty = 0;
  let stopWalking = false;

  while (!stopWalking && discovered.length < DISCOVERY_HARD_CAP) {
    const batch = wallet.getAddressesFromXPub(xpub, branch, cursor, DISCOVERY_BATCH_SIZE);
    const results = await Promise.all(batch.map(async (a) => {
      try {
        const h = await network.getHistory(a.address);
        return { address: a, historyLength: Array.isArray(h) ? h.length : 0, ok: true };
      } catch (e) {
        return { address: a, historyLength: 0, ok: false };
      }
    }));

    for (const r of results) {
      discovered.push(r.address);
      if (!r.ok) continue;
      if (r.historyLength > 0) consecutiveEmpty = 0;
      else if (++consecutiveEmpty >= GAP_LIMIT) { stopWalking = true; break; }
    }
    cursor += DISCOVERY_BATCH_SIZE;
  }
  return discovered;
}

async function sumBalancesViejo(addresses) {
  const results = await Promise.all(addresses.map(async (a) => {
    try { return await network.getBalance(a.address); }
    catch { return { confirmed: 0, unconfirmed: 0 }; }
  }));
  return results.reduce((s, b) => ({
    confirmed: s.confirmed + b.confirmed,
    unconfirmed: s.unconfirmed + b.unconfirmed,
  }), { confirmed: 0, unconfirmed: 0 });
}

async function reporteViejo(xpub) {
  const [receive, change] = await Promise.all([
    discoverHdChainViejo(xpub, 0),
    discoverHdChainViejo(xpub, 1),
  ]);
  const rBal = await sumBalancesViejo(receive);
  const cBal = await sumBalancesViejo(change);
  return {
    direcciones: receive.length + change.length,
    total: rBal.confirmed + cBal.confirmed + rBal.unconfirmed + cBal.unconfirmed,
  };
}

// ============================================================

const seg = (ms) => (ms / 1000).toFixed(1) + 's';
let fallas = 0;
function check(nombre, condicion, detalle) {
  console.log('  ' + (condicion ? 'OK  ' : 'FALLA') + ' ' + nombre + (detalle ? ' — ' + detalle : ''));
  if (!condicion) fallas++;
}

async function medir(fn) {
  const consultasAntes = network.estadoDeCola().totales;
  const t0 = Date.now();
  const valor = await fn();
  return { valor, ms: Date.now() - t0, consultas: network.estadoDeCola().totales - consultasAntes };
}

async function main() {
  const handlers = cargarHandlersDeProduccion();
  const socksPort = await startTor();
  network.setUseTor(true);
  network.setTorPort(socksPort);

  const xpub = wallet.getXPubFromMnemonic(MNEMONIC);
  const palabras = MNEMONIC.split(/\s+/).length;
  console.log('Seed de ' + palabras + ' palabras' + (process.argv[2] ? '' : ' (nueva, vacia)'));

  // Levantar el pool lo paga cualquier flujo; se mide aparte para no ensuciar
  // el numero del import.
  const pool0 = Date.now();
  await network.getBalance(wallet.getAddressesFromXPub(xpub, 0, 0, 1)[0].address);
  const pool = network.poolStatus();
  console.log('Pool: ' + pool.connected + '/' + pool.target + ' operadores, primera consulta ' + seg(Date.now() - pool0) + '\n');

  const viejo = await medir(() => reporteViejo(xpub));
  console.log('== Referencia: el flujo viejo (saldo de todas las direcciones) ==');
  console.log('  ' + String(viejo.consultas).padStart(4) + ' consultas  ' + seg(viejo.ms).padStart(7) +
    '   ' + viejo.valor.direcciones + ' direcciones   saldo=' + viejo.valor.total + ' sats');

  const nuevo = await medir(() => handlers.get('net:mnemonicReport')(null, MNEMONIC, 5));
  const r = nuevo.valor;
  const totalNuevo = r.total.confirmed + r.total.unconfirmed;
  console.log('\n== Produccion: net:mnemonicReport (src/main/main.js) ==');
  console.log('  ' + String(nuevo.consultas).padStart(4) + ' consultas  ' + seg(nuevo.ms).padStart(7) +
    '   ' + r.addressesQueried + ' saldos consultados   saldo=' + totalNuevo + ' sats');
  console.log('  ' + r.verification.detail);

  console.log('\n== Comprobaciones ==');
  check('el saldo es el mismo que el del flujo viejo', totalNuevo === viejo.valor.total,
    totalNuevo + ' vs ' + viejo.valor.total + ' sats');
  check('cuesta menos consultas', nuevo.consultas < viejo.consultas,
    nuevo.consultas + ' vs ' + viejo.consultas);
  check('no le pregunta el saldo a las direcciones vacias',
    r.addressesQueried < viejo.valor.direcciones,
    r.addressesQueried + ' de ' + viejo.valor.direcciones + ' direcciones');
  check('el saldo sale verificado por el cruce entre operadores',
    r.verification.verified === true, r.verification.detail);
  check('devuelve las 5 direcciones que pinta la pantalla', r.addresses.length === 5);
  check('no se reporta incompleto', r.incomplete === false,
    'failures=' + r.failures + ' discoveryFailures=' + r.discoveryFailures);

  console.log('\n  Ahorro: ' + (viejo.consultas - nuevo.consultas) + ' consultas, ' +
    seg(viejo.ms - nuevo.ms) + ' de ' + seg(viejo.ms) + '.');

  // El otro camino que saltea saldos: el refresh de una wallet ya guardada.
  const guardada = prestarWalletDeMentira(xpub);
  const getHdBalance = handlers.get('wallet:getHdBalance');

  const completo = await medir(() => getHdBalance(null, 'sonda', {}));
  console.log('\n== Produccion: wallet:getHdBalance, barrido completo ==');
  console.log('  ' + String(completo.consultas).padStart(4) + ' consultas  ' + seg(completo.ms).padStart(7) +
    '   ' + completo.valor.addressesQueried + ' saldos consultados   saldo=' +
    (completo.valor.confirmed + completo.valor.unconfirmed) + ' sats');
  console.log('  ' + completo.valor.verification.detail);

  // El camino rapido mira solo las direcciones anotadas, que vienen derivadas
  // sin historial: ahi NO se saltea nada, y ese es el punto — busca actividad
  // nueva justamente donde todavia no la hubo.
  const rapido = await medir(() => getHdBalance(null, 'sonda', { rapido: true }));
  console.log('\n== Produccion: wallet:getHdBalance, camino rapido ==');
  console.log('  ' + String(rapido.consultas).padStart(4) + ' consultas  ' + seg(rapido.ms).padStart(7) +
    '   ' + rapido.valor.addressesQueried + ' saldos consultados   saldo=' +
    (rapido.valor.confirmed + rapido.valor.unconfirmed) + ' sats');

  console.log('\n== Comprobaciones del refresh ==');
  check('el saldo del barrido completo coincide con el del import',
    completo.valor.confirmed + completo.valor.unconfirmed === totalNuevo,
    (completo.valor.confirmed + completo.valor.unconfirmed) + ' vs ' + totalNuevo + ' sats');
  check('el barrido completo tampoco consulta las vacias',
    completo.valor.addressesQueried < viejo.valor.direcciones,
    completo.valor.addressesQueried + ' de ' + viejo.valor.direcciones + ' direcciones');
  check('sigue saliendo verificado', completo.valor.verification.verified === true,
    completo.valor.verification.detail);
  check('el camino rapido SI consulta todas las que mira',
    rapido.valor.addressesQueried === Math.max(guardada.receiveIndex, 1) + guardada.changeIndex + 10,
    rapido.valor.addressesQueried + ' saldos');
  check('el camino rapido llega al mismo saldo',
    rapido.valor.confirmed + rapido.valor.unconfirmed === totalNuevo,
    (rapido.valor.confirmed + rapido.valor.unconfirmed) + ' vs ' + totalNuevo + ' sats');

  network.disconnect();
  stopTor();
  console.log(fallas === 0 ? '\nTODO OK\n' : '\n' + fallas + ' COMPROBACIONES FALLARON\n');
  process.exit(fallas === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('\nError:', e.message);
  stopTor();
  process.exit(1);
});
