// Genera el checkpoint de src/core/chain.js, verificandolo de punta a punta.
//
// Que hace: baja la cadena entera de cabeceras desde el ancla ASERT de 2020,
// verifica CADA UNA (encadenamiento, proof-of-work y dificultad ASERT), y recien
// entonces emite el bloque de constantes para pegar en chain.js.
//
// El checkpoint que sale de aca no es "un bloque que me dijo un servidor": es un
// bloque al que se llega por una cadena de 300.000 cabeceras con proof-of-work
// verificado desde un ancla que esta en el codigo.
//
// Usa el codigo de produccion (src/core/network.js y src/core/chain.js), no una
// copia — asi este script tambien es una prueba de esa implementacion.
//
// Se corre con:  node tools/make-checkpoint.mjs

import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const network = require('../src/core/network.js');
const chain = require('../src/core/chain.js');

// Margen bajo el tip: un checkpoint no debe quedar a merced de una reorg.
// Mil bloques son ~7 dias; una reorg de esa profundidad en BCH no ocurre.
const MARGEN_REORG = 1000;
// Se redondea a multiplos de esto para que el numero quede prolijo y estable.
const REDONDEO = 10000;

const dataDir = path.join(os.tmpdir(), 'ghostwallet-checkpoint-tor', 'data');
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
      if (!settled) { settled = true; stopTor(); reject(new Error('Tor no llego a Bootstrap 100% en 90s.')); }
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

async function main() {
  const socksPort = await startTor();
  network.setUseTor(true);
  network.setTorPort(socksPort);

  const tip = await network.getTipHeight();
  const pool = network.poolStatus();
  console.log(`Operadores: ${pool.operators.map(o => o.operator).join(', ')}`);
  console.log(`Tip: ${tip}\n`);

  // Se arranca en anchor-1 porque ASERT necesita el timestamp del padre del
  // ancla para calcular la dificultad del primer bloque posterior.
  const desde = chain.ASERT_ANCHOR.height - 1;
  const objetivo = Math.floor((tip - MARGEN_REORG) / REDONDEO) * REDONDEO;

  if (objetivo <= chain.ASERT_ANCHOR.height) {
    throw new Error('El tip esta demasiado cerca del ancla como para elegir un checkpoint.');
  }

  console.log(`Bajando ${objetivo - desde + 1} cabeceras (${desde} → ${objetivo})...`);
  const t0 = Date.now();
  let ultimoAviso = 0;
  const headers = await network.getBlockHeaders(desde, objetivo, (hechos, total) => {
    const pct = Math.floor((hechos / total) * 100);
    if (pct >= ultimoAviso + 10) {
      ultimoAviso = pct;
      process.stdout.write(`  ${pct}%`);
    }
  });
  const msDescarga = Date.now() - t0;
  console.log(`\n  Descarga: ${(msDescarga / 1000).toFixed(1)}s, ${(headers.length / 1024 / 1024).toFixed(1)} MB\n`);

  const cantidad = headers.length / chain.HEADER_SIZE;
  if (cantidad !== objetivo - desde + 1) {
    throw new Error(`Falta gente: esperaba ${objetivo - desde + 1} cabeceras y llegaron ${cantidad}.`);
  }

  console.log('Verificando encadenamiento, proof-of-work y ASERT en cada cabecera...');
  const t1 = Date.now();
  const veredicto = chain.verifyHeaders(headers, desde, null);
  const msVerificacion = Date.now() - t1;

  if (!veredicto.ok) {
    console.error(`\n  RECHAZADA en la cabecera ${desde + veredicto.checked}: ${veredicto.error}\n`);
    stopTor();
    process.exit(1);
  }
  console.log(`  ${veredicto.checked} cabeceras validas en ${(msVerificacion / 1000).toFixed(1)}s\n`);

  const indiceCheckpoint = objetivo - desde;
  const headerCheckpoint = headers.subarray(
    indiceCheckpoint * chain.HEADER_SIZE,
    (indiceCheckpoint + 1) * chain.HEADER_SIZE
  );
  const hashCheckpoint = chain.headerHash(headerCheckpoint);
  const fecha = new Date(chain.headerTime(headerCheckpoint) * 1000).toISOString().slice(0, 10);

  console.log('='.repeat(70));
  console.log('Pegar en src/core/chain.js, reemplazando la constante CHECKPOINT:\n');
  console.log('const CHECKPOINT = {');
  console.log(`  height: ${objetivo},`);
  console.log(`  hash: '${hashCheckpoint}',`);
  console.log('};');
  console.log(`\n// Bloque del ${fecha}. Verificado desde el ancla ASERT recorriendo`);
  console.log(`// ${veredicto.checked} cabeceras con proof-of-work y dificultad validados.`);
  console.log('='.repeat(70));

  // Constantes del ancla, releidas de la cadena: sirven para confirmar que las
  // que estan en chain.js son las correctas y no algo recordado de memoria.
  const anclaIdx = chain.ASERT_ANCHOR.height - desde;
  const ancla = headers.subarray(anclaIdx * chain.HEADER_SIZE, (anclaIdx + 1) * chain.HEADER_SIZE);
  const padre = headers.subarray((anclaIdx - 1) * chain.HEADER_SIZE, anclaIdx * chain.HEADER_SIZE);
  const bitsReal = chain.headerBits(ancla);
  const parentTimeReal = chain.headerTime(padre);

  console.log('\nControl del ancla ASERT contra la cadena:');
  console.log(`  bits        en chain.js 0x${chain.ASERT_ANCHOR.bits.toString(16)}   en la cadena 0x${bitsReal.toString(16)}   ` +
    (bitsReal === chain.ASERT_ANCHOR.bits ? 'OK' : 'NO COINCIDE'));
  console.log(`  parentTime  en chain.js ${chain.ASERT_ANCHOR.parentTime}     en la cadena ${parentTimeReal}     ` +
    (parentTimeReal === chain.ASERT_ANCHOR.parentTime ? 'OK' : 'NO COINCIDE'));

  network.disconnect();
  stopTor();
  process.exit(0);
}

main().catch((e) => {
  console.error('\nError:', e.message);
  stopTor();
  process.exit(1);
});
