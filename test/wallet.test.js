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

  console.log('\n== Semilla hexadecimal HD (BCH, m/44h/145h/0h/0/i) ==');
  const hexHdSeed = '466d0b53493912bc2b319bcfb6803a78d417a06d95c7050f6a2fbfc88afb471c';
  const hexHdAddresses = w.addressesFromHexHd(hexHdSeed, { count: 3 });
  eq('HD hex deriva 3 direcciones', hexHdAddresses.length, 3);
  eq('HD hex usa la ruta BCH esperada', hexHdAddresses[0].path, "m/44'/145'/0'/0/0");
  eq('HD hex direccion 0 determinista', hexHdAddresses[0].address, 'bitcoincash:qz08xensr7ufqa2twdulaylxw7antazr2un4f5qxup');
  eq('HD hex direccion 1 determinista', hexHdAddresses[1].address, 'bitcoincash:qr7e2st2lygev2qum948y0a39evng4vdy5fm77zpq9');
  eq('HD hex direccion 2 determinista', hexHdAddresses[2].address, 'bitcoincash:qr0gzatl2cmxmkpfav6w0zm5xys4nnqcxg3gv8pa6w');

  const hexHdXpub = w.getXPubFromHexHd(hexHdSeed);
  eq(
    'HD hex xpub determinista',
    hexHdXpub,
    'xpub6BrzmJsercYhyNUQt2pjJPon3Q5jAWMQtPgFKAaTL5SDuaptVUJZ1MmuvkLoizj5PMWSR4BRx875yUP52KoM4i3koceCtii5qFsFuyNcg7t'
  );
  const fromXpub = w.getAddressesFromXPub(hexHdXpub, 0, 0, 3);
  eq('xpub reproduce la direccion 0', fromXpub[0].address, hexHdAddresses[0].address);
  eq('xpub reproduce la direccion 2', fromXpub[2].address, hexHdAddresses[2].address);

  const child0Secret = w.getPrivateKeyHexForHexHdPath(hexHdSeed, 0, 0, 0);
  const child0Candidates = await w.candidatesFromHexSecret(child0Secret);
  eq(
    'privada hija firma para la direccion 0',
    child0Candidates.find((candidate) => candidate.recipe === 'compressed').address,
    hexHdAddresses[0].address
  );
  const legacyFromSameSecret = await w.candidatesFromHexSecret(hexHdSeed);
  eq(
    'la direccion Legacy existente permanece sin cambios',
    legacyFromSameSecret.find((candidate) => candidate.recipe === 'compressed').address,
    'bitcoincash:qrv7g523vn6jejwrndqjzdm2n0y5cg9cqsecznhr9k'
  );
  ok('la direccion 0 HD no reemplaza a la Legacy', legacyFromSameSecret[0].address !== hexHdAddresses[0].address);

  const change0 = w.addressesFromHexHd(hexHdSeed, { change: 1, count: 1 })[0];
  const rawHdTx = w.buildAndSignTx({
    inputs: [
      {
        tx_hash: '11'.repeat(32),
        tx_pos: 0,
        address: hexHdAddresses[0].address,
        value: 10000,
        privKeyHex: w.getPrivateKeyHexForHexHdPath(hexHdSeed, 0, 0, 0)
      },
      {
        tx_hash: '22'.repeat(32),
        tx_pos: 1,
        address: hexHdAddresses[1].address,
        value: 10000,
        privKeyHex: w.getPrivateKeyHexForHexHdPath(hexHdSeed, 0, 0, 1)
      }
    ],
    toAddress: hexHdAddresses[2].address,
    changeAddress: change0.address,
    amountSats: 15000
  });
  const bitcore = require('bitcore-lib-cash');
  const parsedHdTx = new bitcore.Transaction(rawHdTx);
  eq('transaccion HD incluye sus 2 inputs', parsedHdTx.inputs.length, 2);
  ok('cada input HD lleva su firma', parsedHdTx.inputs.every((input) => input.script.toBuffer().length > 0));
  eq('transaccion HD crea salida de cambio', parsedHdTx.outputs.length, 2);

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
  eq('Legacy no recibe xpub', savedList[0].xpub, null);
  eq('Legacy no recibe indice de recepcion', savedList[0].receiveIndex, undefined);

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

  // 5. Guardar la nueva variante HD con semilla hexadecimal
  const savedWithHd = storage.saveWallet({
    name: 'Test HD Hex',
    address: hexHdAddresses[0].address,
    type: 'hex_hd',
    secret: hexHdSeed,
    password: testPass
  });
  eq('lista tiene tambien la HD hexadecimal', savedWithHd.length, 2);
  const savedHd = savedWithHd.find((wallet) => wallet.type === 'hex_hd');
  eq('HD hexadecimal guarda su xpub', savedHd.xpub, hexHdXpub);
  eq('HD hexadecimal inicia receiveIndex en 0', savedHd.receiveIndex, 0);
  eq('HD hexadecimal inicia changeIndex en 0', savedHd.changeIndex, 0);
  eq('semilla HD descifrada coincide', storage.getDecryptedSecret(savedHd.id, testPass), hexHdSeed);

  // 6. Borrar wallets
  storage.deleteWallet(savedHd.id);
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
