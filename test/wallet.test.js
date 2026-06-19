// Tests del nucleo de la wallet, con vectores CONOCIDOS y verificables.
// Se corre con:  npm test
//
// La idea: nunca confiar "porque si" en el calculo de direcciones.
// Si algo aca falla, NO se sigue construyendo.

const assert = require('node:assert');
const w = require('../src/core/wallet');

let passed = 0;
function ok(name, cond) {
  assert.ok(cond, 'FALLO: ' + name);
  console.log('  OK  ' + name);
  passed++;
}
function eq(name, actual, expected) {
  assert.strictEqual(actual, expected, `FALLO: ${name}\n   esperado: ${expected}\n   obtenido: ${actual}`);
  console.log('  OK  ' + name);
  passed++;
}

async function main() {
  console.log('\n== Vector conocido: clave privada = 1 (estandar BIP173) ==');
  // hash160 de la pubkey comprimida de privkey=1 es un valor canonico documentado.
  const priv1 = '0000000000000000000000000000000000000000000000000000000000000001';
  const cands = await w.candidatesFromHexSecret(priv1);
  const comp = cands.find((c) => c.recipe === 'compressed').address;
  const unc = cands.find((c) => c.recipe === 'uncompressed').address;
  eq('direccion comprimida', comp, 'bitcoincash:qp63uahgrxged4z5jswyt5dn5v3lzsem6cy4spdc2h');
  eq('direccion sin comprimir', unc, 'bitcoincash:qzgmyjle755g2v5kptrg02asx5f8k8fg55zdx7hd4l');
  ok('comprimida y sin comprimir son distintas', comp !== unc);

  console.log('\n== Validacion de entradas ==');
  eq('detecta hex de 64', w.detectInputType(priv1), 'hex');
  eq('detecta hex con 0x', w.detectInputType('0x' + priv1), 'hex');
  eq('rechaza hex corto', w.isHexSecret('abc123'), false);

  console.log('\n== BIP39: seed contra vector oficial (mnemonic abandon...about) ==');
  const M = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  eq('detecta frase valida', w.detectInputType(M), 'mnemonic');
  const bip39 = require('bip39');
  const seedHex = Buffer.from(bip39.mnemonicToSeedSync(M, 'TREZOR')).toString('hex');
  eq(
    'seed BIP39 (passphrase TREZOR) coincide con vector oficial',
    seedHex,
    'c55257c360c07c72029aebc1b53c05ed0362ada38ead3e3e9efa3708e53495531f09a6987599d18264c1e1c92f2cf141630c7a3c4ab7c81b2f001698e7463b04',
  );

  console.log('\n== Derivacion de direcciones desde frase (BCH, m/44h/145h/0h/0/i) ==');
  const addrs = await w.addressesFromMnemonic(M, { count: 3 });
  ok('deriva 3 direcciones', addrs.length === 3);
  for (const a of addrs) {
    ok('direccion ' + a.index + ' tiene formato cashaddr', /^bitcoincash:q[0-9a-z]{41,}$/.test(a.address));
    console.log('       ' + a.path + '  ->  ' + a.address);
  }
  // Determinismo: derivar dos veces da lo mismo.
  const addrs2 = await w.addressesFromMnemonic(M, { count: 3 });
  ok('derivacion es determinista', addrs[0].address === addrs2[0].address);

  console.log('\n== Generacion de frases nuevas ==');
  for (const n of [12, 15, 18, 21, 24]) {
    const m = w.generateMnemonic(n);
    eq(`frase de ${n} palabras tiene ${n} palabras`, m.split(' ').length, n);
    ok(`frase de ${n} es valida`, w.validateMnemonic(m));
  }

  console.log('\n== Generacion de secretos de 64 hex (estilo secrets.token_hex(32)) ==');
  const s1 = w.generateHexSecret();
  const s2 = w.generateHexSecret();
  ok('secreto tiene 64 caracteres hex', /^[0-9a-f]{64}$/.test(s1));
  ok('dos secretos son distintos', s1 !== s2);
  const c = await w.candidatesFromHexSecret(s1);
  ok('del secreto sale una direccion valida', /^bitcoincash:q/.test(c[0].address));

  console.log('\n== Formateo de saldos (satoshis -> BCH) ==');
  const net = require('../src/core/network');
  eq('1 BCH', net.formatBch(100000000), '1 BCH');
  eq('0.5 BCH', net.formatBch(50000000), '0.5 BCH');
  eq('1.23456789 BCH', net.formatBch(123456789), '1.23456789 BCH');
  eq('0 BCH', net.formatBch(0), '0 BCH');
  eq('1 satoshi', net.formatBch(1), '0.00000001 BCH');

  console.log('\n== Persistencia y Encriptacion (storage.js) ==');
  const storage = require('../src/core/storage');
  const fs = require('node:fs');
  const path = require('node:path');

  // Limpieza inicial por si quedo algun residuo
  if (fs.existsSync(storage.filePath)) {
    fs.unlinkSync(storage.filePath);
  }

  // 1. Empezar vacio
  eq('lista inicial vacia', storage.listWalletsPublic().length, 0);

  // 2. Guardar wallet
  const testSecret = '466d0b53493912bc2b319bcfb6803a78d417a06d95c7050f6a2fbfc88afb471c';
  const testAddr = 'bitcoincash:qrv7g523vn6jejwrndqjzdm2n0y5cg9cqsecznhr9k';
  const testPass = 'segura123';
  
  const savedList = storage.saveWallet({
    name: 'Test Wallet',
    address: testAddr,
    type: 'hex',
    secret: testSecret,
    password: testPass
  });

  eq('lista tiene 1 wallet', savedList.length, 1);
  eq('nombre coincide', savedList[0].name, 'Test Wallet');
  eq('direccion coincide', savedList[0].address, testAddr);
  eq('tipo coincide', savedList[0].type, 'hex');

  // 3. Desencriptar
  const decrypted = storage.getDecryptedSecret(savedList[0].id, testPass);
  eq('secreto descifrado coincide', decrypted, testSecret);

  // 4. Intentar descifrar con contrasenia incorrecta
  assert.throws(
    () => storage.getDecryptedSecret(savedList[0].id, 'incorrecta'),
    /Contraseña incorrecta/
  );
  console.log('  OK  error lanzado al descifrar con clave incorrecta');
  passed++;

  // 5. Borrar wallet
  const afterDelete = storage.deleteWallet(savedList[0].id);
  eq('lista vuelve a estar vacia', afterDelete.length, 0);

  // Limpieza final
  if (fs.existsSync(storage.filePath)) {
    fs.unlinkSync(storage.filePath);
  }
  const testDataDir = path.dirname(storage.filePath);
  if (fs.existsSync(testDataDir)) {
    try { fs.rmdirSync(testDataDir); } catch {}
  }

  console.log(`\nTODO OK (${passed} comprobaciones)\n`);
}

main().catch((e) => {
  console.error('\nERROR EN TESTS:\n', e);
  process.exit(1);
});
