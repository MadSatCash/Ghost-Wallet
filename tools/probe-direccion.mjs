// Que ve la wallet de UNA direccion, operador por operador.
//
// Existe porque la lista y el detalle de una wallet dan saldos distintos para
// la misma direccion: la lista consulta el saldo directo, el detalle primero
// pregunta el historial y se saltea el saldo de lo que vio "sin actividad".
// Si el historial pierde una transaccion, el detalle muestra cero.
//
// Muestra las tres capas:
//   1. lo que devolvio CADA operador, crudo, sin consenso
//   2. lo que quedo del historial despues de consensus.resolveHistory
//   3. lo que quedaria del saldo despues de consensus.resolveBalance
//
// Se corre con:  node tools/probe-direccion.mjs <cashaddr> [mas direcciones...]

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const network = require('../src/core/network.js');
const consensus = require('../src/core/consensus.js');

const DIRECCIONES = process.argv.slice(2).filter(Boolean);
if (DIRECCIONES.length === 0) {
  console.error('Uso: node tools/probe-direccion.mjs <cashaddr> [mas...]');
  process.exit(1);
}

const dataDir = path.join(os.tmpdir(), 'ghostwallet-probe-tor', 'data');
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
      settled = true; stopTor();
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
        settled = true; clearTimeout(timer);
        console.log(' listo.\n');
        resolve(socksPort);
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

// Las respuestas crudas no salen de network.js. Pero los resolvers se leen del
// modulo consensus en cada consulta, asi que envolverlos deja pasar el array
// entero de respuestas antes de que el consenso lo recorte.
let ultimasRespuestas = null;
const resolvers = {};
function espiarResolver(nombre) {
  const original = consensus[nombre];
  resolvers[nombre] = original;
  consensus[nombre] = (responses) => {
    ultimasRespuestas = responses;
    return original(responses);
  };
}
espiarResolver('resolveHistory');
espiarResolver('resolveBalance');
espiarResolver('resolveUtxos');

// La implementacion vieja de resolveHistory, replicada tal cual estaba: se
// quedaba con el historial de UN miembro del grupo ganador y le recortaba todo
// lo que estuviera por encima de la altura de corte. Esta aca para que la
// sonda muestre el bug, no solo su ausencia.
function resolveHistoryViejo(responses) {
  const cutoffHeight = consensus.commonCutoffHeight(responses.map(r => r.height));
  const { winner } = consensus.tally(responses, r => consensus.historyFingerprint(r.value, cutoffHeight));
  const entries = (winner && winner.members[0].value) || [];
  return {
    cutoffHeight,
    value: [
      ...entries.filter(e => e.height > 0 && e.height <= cutoffHeight),
      ...entries.filter(e => e.height === 0 || e.height === -1),
    ],
  };
}

function alturaDe(e) {
  if (e.height > 0) return 'bloque ' + e.height;
  if (e.height === 0) return 'MEMPOOL';
  if (e.height === -1) return 'MEMPOOL (padre sin confirmar)';
  return 'height=' + e.height;
}

async function sondear(address) {
  console.log('='.repeat(78));
  console.log(address);
  console.log('='.repeat(78));

  // --- Historial: es lo que decide si el detalle consulta el saldo ---
  ultimasRespuestas = null;
  let historial = null;
  try {
    historial = await network.getHistoryVerified(address);
  } catch (e) {
    console.log('  get_history fallo: ' + e.message);
  }
  const crudoHist = ultimasRespuestas || [];

  console.log('\n-- blockchain.scripthash.get_history, crudo por operador --');
  for (const r of crudoHist) {
    const entries = Array.isArray(r.value) ? r.value : [];
    console.log('  ' + String(r.operator).padEnd(18) + ' tip=' + String(r.height).padStart(8) +
      '  ' + String(entries.length).padStart(2) + ' entradas' +
      (entries.length ? ': ' + entries.map(alturaDe).join(', ') : ''));
  }
  const cutoff = consensus.commonCutoffHeight(crudoHist.map(r => r.height));
  console.log('  corte de altura comun: ' + cutoff +
    (crudoHist.length ? '  (tips: ' + crudoHist.map(r => r.height).join(', ') + ')' : ''));

  if (historial) {
    console.log('\n-- lo que devuelve getHistoryVerified (post-consenso) --');
    console.log('  ' + historial.entries.length + ' entradas' +
      (historial.entries.length ? ': ' + historial.entries.map(alturaDe).join(', ') : ''));
    console.log('  ' + historial.verification.detail);
    console.log('  => el barrido anota historyLength=' + historial.entries.length +
      (historial.entries.length === 0
        ? '  ==> SE SALTEA LA CONSULTA DE SALDO (la da por vacia)'
        : ''));
  }

  // --- El mismo historial, con un operador atrasado un bloque ---
  //
  // Es la condicion exacta que rompia el detalle de la billetera, y en la red
  // dura lo que tarda un bloque en propagarse: no se puede esperar a que pase
  // sola. Se reproduce sobre los datos reales de arriba bajandole el tip a un
  // operador y moviendo su copia de las tx de ese bloque al mempool, que es lo
  // que ese operador estaria reportando.
  const alturas = crudoHist.flatMap(r => (r.value || []).map(e => e.height)).filter(h => h > 0);
  if (crudoHist.length >= 2 && alturas.length > 0) {
    // El corte tiene que caer POR DEBAJO de la tx mas nueva: ese es el unico
    // desfase que la esconde. Atrasar un bloque cuando la tx tiene diez
    // encima no reproduce nada.
    const alturaTx = Math.max(...alturas);
    const atrasado = alturaTx - 1;
    const esperadas = historial ? historial.entries.length : 0;

    console.log('\n-- simulacion: un operador atrasado hasta el bloque ' + atrasado + ' --');
    console.log('  (la tx del bloque ' + alturaTx + ' le queda arriba del corte comun)');

    // Se prueba atrasando a cada uno por turno: en la implementacion vieja el
    // resultado dependia de a quien le tocara ir primero en el grupo ganador,
    // y por eso el sintoma iba y venia. El que va adelante reporta la tx en un
    // bloque que el corte deja afuera; el atrasado la tiene en el mempool. Si
    // el primero es el adelantado, la tx no entra por ninguna de las dos vias.
    let peorViejo = Infinity;
    let peorNuevo = Infinity;
    for (let i = 0; i < crudoHist.length; i++) {
      const conDesfase = crudoHist.map((r, j) => j !== i ? r : {
        ...r,
        height: atrasado,
        value: (r.value || []).map(e => e.height > atrasado ? { ...e, height: 0 } : e),
      });
      const viejo = resolveHistoryViejo(conDesfase);
      const nuevo = resolvers.resolveHistory(conDesfase);
      peorViejo = Math.min(peorViejo, viejo.value.length);
      peorNuevo = Math.min(peorNuevo, nuevo.value.length);

      console.log('  atrasa ' + String(crudoHist[i].operator).padEnd(18) +
        ' vieja=' + viejo.value.length + ' entradas' +
        (viejo.value.length === 0 ? ' (==> el barrido la da por vacia y saltea el saldo)' : '') +
        '   nueva=' + nuevo.value.length + ' entradas' +
        (nuevo.value.length ? ' [' + nuevo.value.map(alturaDe).join(', ') + ']' : ''));
    }

    console.log('  peor caso vieja: ' + peorViejo + ' de ' + esperadas + ' transacciones' +
      (peorViejo < esperadas ? '  <== ROTO' : ''));
    console.log('  peor caso nueva: ' + peorNuevo + ' de ' + esperadas + ' transacciones' +
      (peorNuevo < esperadas ? '  <== ROTO' : '  <== OK'));
  }

  // --- Saldo: es lo que usa la lista ---
  ultimasRespuestas = null;
  let saldo = null;
  try {
    saldo = await network.getBalance(address);
  } catch (e) {
    console.log('\n  get_balance fallo: ' + e.message);
  }
  const crudoBal = ultimasRespuestas || [];

  console.log('\n-- blockchain.scripthash.get_balance, crudo por operador --');
  for (const r of crudoBal) {
    console.log('  ' + String(r.operator).padEnd(18) +
      ' confirmed=' + String(r.value.confirmed).padStart(10) +
      '  unconfirmed=' + String(r.value.unconfirmed).padStart(10));
  }
  if (saldo) {
    const total = saldo.confirmed + saldo.unconfirmed;
    console.log('\n-- lo que devuelve getBalance (post-consenso) --');
    console.log('  confirmed=' + saldo.confirmed + '  unconfirmed=' + saldo.unconfirmed +
      '  total=' + total + ' sats');
    console.log('  ' + saldo.verification.detail);
  }

  // --- UTXOs: lo unico que se puede firmar ---
  //
  // Es otro camino y otra regla: aca el recorte por altura SI es deliberado
  // (no se firma sobre monedas que no todos ven). Interesa saber cuanto del
  // saldo queda afuera, porque eso es lo que el usuario ve como "no hay fondos
  // suficientes" teniendo plata en pantalla.
  ultimasRespuestas = null;
  let utxos = null;
  try {
    utxos = await network.getUtxos(address);
  } catch (e) {
    console.log('\n  getUtxos fallo: ' + e.message);
  }
  const crudoUtxo = ultimasRespuestas || [];

  console.log('\n-- blockchain.scripthash.listunspent, crudo por operador --');
  for (const r of crudoUtxo) {
    const lista = Array.isArray(r.value) ? r.value : [];
    const total = lista.reduce((s, u) => s + u.value, 0);
    console.log('  ' + String(r.operator).padEnd(18) + ' tip=' + String(r.height).padStart(8) +
      '  ' + lista.length + ' utxo  ' + total + ' sats' +
      (lista.length ? '  [' + lista.map(u => alturaDe(u) + ':' + u.value).join(', ') + ']' : ''));
  }
  if (utxos) {
    const gastable = utxos.reduce((s, u) => s + u.value, 0);
    const tieneSaldo = saldo ? saldo.confirmed + saldo.unconfirmed : 0;
    const delMempool = utxos.filter(u => !(u.height > 0));
    console.log('\n-- lo que devuelve getUtxos (lo unico gastable) --');
    console.log('  ' + utxos.length + ' utxo   ' + gastable + ' sats gastables de ' +
      tieneSaldo + ' sats de saldo');
    if (delMempool.length) {
      console.log('  ' + delMempool.length + ' del mempool (' +
        delMempool.reduce((s, u) => s + u.value, 0) + ' sats), con quorum de operadores');
    }
    if (gastable < tieneSaldo) {
      console.log('  OJO: ' + (tieneSaldo - gastable) + ' sats visibles en pantalla pero NO enviables.');
    }
  }

  // El mismo desfase, sobre los UTXOs.
  const alturasUtxo = crudoUtxo.flatMap(r => (r.value || []).map(u => u.height)).filter(h => h > 0);
  if (crudoUtxo.length >= 2 && alturasUtxo.length > 0) {
    const atrasado = Math.max(...alturasUtxo) - 1;
    let peor = Infinity;
    for (let i = 0; i < crudoUtxo.length; i++) {
      const conDesfase = crudoUtxo.map((r, j) => j !== i ? r : {
        ...r,
        height: atrasado,
        value: (r.value || []).map(u => u.height > atrasado ? { ...u, height: 0 } : u),
      });
      const v = resolvers.resolveUtxos(conDesfase);
      peor = Math.min(peor, (v.value || []).reduce((s, u) => s + u.value, 0));
    }
    console.log('\n-- simulacion: un operador atrasado hasta el bloque ' + atrasado + ' (UTXOs) --');
    console.log('  peor caso gastable: ' + peor + ' sats' +
      (utxos && peor < utxos.reduce((s, u) => s + u.value, 0)
        ? '  <== el desfase deja plata sin poder enviar'
        : '  <== el desfase no cambia lo enviable'));
  }

  // --- El veredicto ---
  if (historial && saldo) {
    const total = saldo.confirmed + saldo.unconfirmed;
    console.log('\n-- veredicto --');
    if (total > 0 && historial.entries.length === 0) {
      console.log('  ROTO: tiene ' + total + ' sats pero el historial post-consenso vino vacio.');
      console.log('  La lista (que pregunta el saldo) muestra ' + total + '; el detalle (que');
      console.log('  se guia por el historial) la saltea y muestra 0.');
    } else if (total > 0) {
      console.log('  OK: saldo ' + total + ' sats y el historial lo respalda.');
    } else {
      console.log('  Sin fondos en esta direccion.');
    }
  }
  console.log('');
}

async function main() {
  const socksPort = await startTor();
  network.setUseTor(true);
  network.setTorPort(socksPort);

  for (const dir of DIRECCIONES) {
    await sondear(dir);
  }

  const pool = network.poolStatus();
  console.log('Pool: ' + pool.connected + '/' + pool.target + ' operadores — ' +
    pool.operators.map(o => o.operator + '@' + o.height).join(', '));

  network.disconnect();
  stopTor();
  process.exit(0);
}

main().catch((e) => {
  console.error('\nError:', e.message);
  stopTor();
  process.exit(1);
});
