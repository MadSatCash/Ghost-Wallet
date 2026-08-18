// Prueba de humo del blindaje completo, contra la red de verdad.
//
// Recorre el camino entero tal como lo hace la wallet:
//
//   sincronizar desde el checkpoint → verificar PoW y ASERT de cada cabecera
//   → pedir la prueba de inclusion de una transaccion real → verificarla contra
//   el merkle root de una cabecera validada → y comprobar que una prueba
//   adulterada se rechaza.
//
// Se corre con:  node tools/smoke-chain.mjs

import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const network = require('../src/core/network.js');
const chain = require('../src/core/chain.js');
const chainsync = require('../src/core/chainsync.js');
const spv = require('../src/core/spv.js');

const DIRECCION = 'bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a';

const dataDir = path.join(os.tmpdir(), 'ghostwallet-smokechain-tor', 'data');
let torProcess = null;

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

let fallas = 0;
function check(nombre, cond, detalle) {
  console.log(`  ${cond ? 'OK  ' : 'FALLA'} ${nombre}${detalle ? ' — ' + detalle : ''}`);
  if (!cond) fallas++;
}

async function main() {
  const socksPort = await startTor();
  network.setUseTor(true);
  network.setTorPort(socksPort);

  // Arrancar de cero para medir el caso real de una instalacion nueva.
  chain.reset();

  console.log('== 1. Sincronizacion desde el checkpoint ==');
  console.log(`  Checkpoint: ${chain.CHECKPOINT.height} (${chain.CHECKPOINT.hash.slice(0, 20)}...)`);

  const t0 = Date.now();
  const resultado = await chainsync.sync();
  const ms = Date.now() - t0;

  if (resultado.error) {
    check('la sincronizacion termino sin error', false, resultado.error);
    stopTor();
    process.exit(1);
  }

  const tipRed = await network.getTipHeight();
  console.log(`  ${resultado.count} cabeceras verificadas en ${(ms / 1000).toFixed(1)}s`);
  check('la fase termino en listo', resultado.fase === 'listo', resultado.fase);
  check('la cadena arranca en el checkpoint', resultado.baseHeight === chain.CHECKPOINT.height);
  check('el checkpoint del codigo coincide con el de la red', chain.checkpointMatches());
  check('llego hasta la punta de la cadena', resultado.tipHeight >= tipRed - 2,
    `local ${resultado.tipHeight}, red ${tipRed}`);

  console.log('\n== 2. Sincronizacion incremental (segunda corrida) ==');
  const t1 = Date.now();
  const segunda = await chainsync.sync();
  const msSegunda = Date.now() - t1;
  console.log(`  ${(msSegunda / 1000).toFixed(1)}s`);
  check('la segunda corrida es mucho mas rapida', msSegunda < ms / 2,
    `${(msSegunda / 1000).toFixed(1)}s vs ${(ms / 1000).toFixed(1)}s`);
  check('no perdio cabeceras', segunda.count >= resultado.count);

  console.log('\n== 3. Prueba de inclusion de una transaccion real ==');
  const hist = await network.getHistory(DIRECCION);
  const candidatas = hist
    .filter(h => h.height >= chain.CHECKPOINT.height && h.height <= chain.tipHeight())
    .sort((a, b) => b.height - a.height);

  if (candidatas.length === 0) {
    console.log('  (sin transacciones en el rango verificado — se omite)');
  } else {
    const tx = candidatas[0];
    console.log(`  Tx ${tx.tx_hash.slice(0, 24)}... en bloque ${tx.height}`);

    const proof = await network.getMerkleProof(tx.tx_hash, tx.height);
    const veredicto = spv.verifyTransaction(tx.tx_hash, tx.height, proof);
    check('la prueba legitima verifica', veredicto.verified === true, veredicto.detail);
    check('la rama tiene un largo razonable', proof.merkle.length > 0 && proof.merkle.length < 40,
      `${proof.merkle.length} hashes`);

    // Prueba adulterada: cambiar un hash de la rama tiene que hacerla fallar.
    const adulterada = { ...proof, merkle: [...proof.merkle] };
    adulterada.merkle[0] = 'ff'.repeat(32);
    const rechazo = spv.verifyTransaction(tx.tx_hash, tx.height, adulterada);
    check('una prueba adulterada se rechaza', rechazo.verified === false, rechazo.reason);

    // Una tx real pero declarada en otro bloque tampoco debe pasar.
    const otroBloque = spv.verifyTransaction(tx.tx_hash, tx.height - 1, proof);
    check('la misma tx en el bloque equivocado se rechaza', otroBloque.verified === false,
      otroBloque.reason);
  }

  console.log('\n== 4. Rechazo de cabeceras invalidas ==');
  const buena = chain.headerAt(chain.tipHeight() - 5);
  const previa = chain.headerAt(chain.tipHeight() - 6);

  const sinTocar = chain.verifyHeaders(buena, chain.tipHeight() - 5, previa);
  check('una cabecera legitima pasa', sinTocar.ok === true, sinTocar.error || '');

  // Cambiar el nonce rompe el proof-of-work.
  const nonceRoto = Buffer.from(buena);
  nonceRoto.writeUInt32LE(12345, 76);
  const conNonceRoto = chain.verifyHeaders(nonceRoto, chain.tipHeight() - 5, previa);
  check('una cabecera con el nonce cambiado se rechaza', conNonceRoto.ok === false,
    conNonceRoto.error);

  // Tocar los bits tambien cambia el hash de la cabecera, asi que la caza el
  // PoW antes de llegar a ASERT. Igual vale como prueba de que ningun byte de
  // la cabecera se puede alterar sin que algo lo note.
  const bitsFalsos = Buffer.from(buena);
  bitsFalsos.writeUInt32LE(0x1d00ffff, 72);
  const conBitsFalsos = chain.verifyHeaders(bitsFalsos, chain.tipHeight() - 5, previa);
  check('una cabecera con la dificultad reescrita se rechaza', conBitsFalsos.ok === false,
    conBitsFalsos.error);

  // Desenganchada de su padre.
  const huerfana = chain.verifyHeaders(buena, chain.tipHeight() - 5, chain.headerAt(chain.tipHeight() - 20));
  check('una cabecera que no engancha se rechaza', huerfana.ok === false, huerfana.error);

  console.log(`\n  Cadena en disco: ${chain.status().count} cabeceras desde ${chain.status().baseHeight}`);

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
