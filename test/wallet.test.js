// Tests del nucleo de la wallet, con vectores CONOCIDOS y verificables.
// Se corre con:  npm test
//
// La idea: nunca confiar "porque si" en el calculo de direcciones.
// Si algo aca falla, NO se sigue construyendo.

const assert = require('node:assert');
const w = require('../src/core/wallet');
const consensus = require('../src/core/consensus');
const chain = require('../src/core/chain');
const spv = require('../src/core/spv');
const coinselect = require('../src/core/coinselect');
const utxoscan = require('../src/core/utxoscan');

let passed = 0;
function ok(name, cond) {
  assert.ok(cond, 'FALLO: ' + name);
  console.log('  OK  ' + name);
  passed++;
}

// Para las reglas que se cumplen NO devolviendo nada: comprueba que lanza, y
// que el mensaje dice por que. Un throw con el texto equivocado no sirve de
// nada cuando lo que hay que decidir es si reintentar o llamar al soporte.
async function lanza(name, fn, fragmentoEsperado) {
  let error = null;
  try { await fn(); } catch (e) { error = e; }
  assert.ok(error, `FALLO: ${name}\n   esperado: que lanzara\n   obtenido: devolvio sin error`);
  if (fragmentoEsperado) {
    assert.ok(error.message.includes(fragmentoEsperado),
      `FALLO: ${name}\n   el mensaje no menciona "${fragmentoEsperado}"\n   mensaje: ${error.message}`);
  }
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
  const parsedHdTx = new bitcore.Transaction(rawHdTx.hex);
  eq('transaccion HD incluye sus 2 inputs', parsedHdTx.inputs.length, 2);
  ok('cada input HD lleva su firma', parsedHdTx.inputs.every((input) => input.script.toBuffer().length > 0));
  eq('transaccion HD crea salida de cambio', parsedHdTx.outputs.length, 2);
  ok('devuelve la comision calculada', Number.isInteger(rawHdTx.feeSats) && rawHdTx.feeSats > 0);
  ok('devuelve el vuelto calculado', Number.isInteger(rawHdTx.changeSats));

  console.log('\n== Validacion de destino y monto ==');
  const tira = (nombre, fn, re) => {
    try { fn(); ok(nombre, false); }
    catch (e) { ok(nombre + ' -> ' + e.message, re.test(e.message)); }
  };
  const enviar = (over) => w.buildAndSignTx(Object.assign({
    inputs: [{
      tx_hash: '11'.repeat(32), tx_pos: 0,
      address: hexHdAddresses[0].address, value: 100000,
      privKeyHex: w.getPrivateKeyHexForHexHdPath(hexHdSeed, 0, 0, 0)
    }],
    toAddress: hexHdAddresses[2].address,
    changeAddress: change0.address,
    amountSats: 50000
  }, over));

  tira('rechaza destino de testnet', () => enviar({ toAddress: 'mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn' }), /mainnet|no es valida/);
  tira('rechaza destino basura', () => enviar({ toAddress: 'no-es-una-direccion' }), /no es valida|vacia/);
  tira('rechaza monto NaN', () => enviar({ amountSats: NaN }), /no es un numero/);
  tira('rechaza monto por debajo de dust', () => enviar({ amountSats: 100 }), /dust/);
  tira('rechaza sin UTXOs', () => enviar({ inputs: [] }), /UTXOs/);

  console.log('\n== Conversion BCH -> satoshis (sin error de flotante) ==');
  eq('0.29 BCH', w.bchToSats('0.29'), 29000000);
  eq('0.07 BCH', w.bchToSats('0.07'), 7000000);
  eq('1.1 BCH', w.bchToSats('1.1'), 110000000);
  eq('1 satoshi', w.bchToSats('0.00000001'), 1);
  tira('rechaza texto', () => w.bchToSats('abc'), /no es un numero/);
  tira('rechaza negativo', () => w.bchToSats('-1'), /no es un numero/);
  tira('rechaza 9 decimales', () => w.bchToSats('0.123456789'), /8 decimales/);

  console.log('\n== Consistencia entre libauth y bitcore ==');
  // Las direcciones que se le MUESTRAN al usuario salen de libauth; las que se
  // GASTAN salen de bitcore via xpub. Si divergen, se reciben fondos en una
  // direccion y se firma con la clave de otra.
  const MNEMO = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  const porLibauth = await w.addressesFromMnemonic(MNEMO, { count: 5 });
  const porBitcore = w.getAddressesFromXPub(w.getXPubFromMnemonic(MNEMO, 0), 0, 0, 5);
  ok('las 5 primeras direcciones coinciden entre libauth y bitcore',
    porLibauth.every((a, i) => a.address === porBitcore[i].address));
  const privDeFirma = w.getPrivateKeyHexForPath(MNEMO, 0, 0, 0);
  const addrDeLaPriv = await w.addressFromPrivateKey(Buffer.from(privDeFirma, 'hex'), { compressed: true });
  eq('la clave de firma corresponde a la direccion mostrada', addrDeLaPriv, porLibauth[0].address);

  console.log('\n== Formateo de saldos (satoshis -> BCH) ==');
  const net = require('../src/core/network');
  eq('1 BCH', net.formatBch(100000000), '1 BCH');
  eq('0.5 BCH', net.formatBch(50000000), '0.5 BCH');
  eq('1.23456789 BCH', net.formatBch(123456789), '1.23456789 BCH');
  eq('0 BCH', net.formatBch(0), '0 BCH');
  eq('1 satoshi', net.formatBch(1), '0.00000001 BCH');

  console.log('\n== Vault con contrasena maestra (storage.js) ==');
  const storage = require('../src/core/storage');
  const fs = require('node:fs');
  const path = require('node:path');

  // Limpieza inicial por si quedo algun residuo
  for (const f of [storage.filePath, storage.filePath + '.bak', storage.legacyPath]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }

  const testSecret = '466d0b53493912bc2b319bcfb6803a78d417a06d95c7050f6a2fbfc88afb471c';
  const testAddr = 'bitcoincash:qrv7g523vn6jejwrndqjzdm2n0y5cg9cqsecznhr9k';
  const maestra = 'contrasena-maestra-123';

  // 1. Sin vault creado no hay nada que listar, y pedirlo tiene que fallar
  //    fuerte: una lista vacia se leeria como "no tenes billeteras".
  eq('arranca sin vault', storage.estado().inicializado, false);
  await lanza('listar con el vault cerrado explota', () => storage.listWalletsPublic(), 'bloqueado');

  // 2. Crear el vault con la contrasena maestra
  storage.crearVault(maestra);
  eq('el vault queda inicializado', storage.estado().inicializado, true);
  eq('el vault queda abierto', storage.estado().desbloqueado, true);
  eq('lista inicial vacia', storage.listWalletsPublic().length, 0);
  await lanza('crear un vault encima de otro explota', () => storage.crearVault('otra'), 'Ya existe');

  // 3. Guardar wallet: sin contrasena propia, la maestra ya autorizo la sesion
  const savedList = storage.saveWallet({
    name: 'Test Wallet',
    address: testAddr,
    type: 'hex',
    secret: testSecret
  });

  eq('lista tiene 1 wallet', savedList.length, 1);
  eq('nombre coincide', savedList[0].name, 'Test Wallet');
  eq('direccion coincide', savedList[0].address, testAddr);
  eq('tipo coincide', savedList[0].type, 'hex');
  eq('Legacy no recibe xpub', savedList[0].xpub, null);
  eq('Legacy no recibe indice de recepcion', savedList[0].receiveIndex, undefined);
  eq('la semilla sale del vault sin pedir nada mas', storage.getSecret(savedList[0].id), testSecret);

  // 4. En disco no queda NADA legible: ni la semilla, ni la direccion, ni el
  //    nombre. El archivo entero va cifrado, asi que robarlo sin la maestra no
  //    dice ni cuantas billeteras hay.
  const enDisco = fs.readFileSync(storage.filePath, 'utf8');
  ok('el secreto no esta en claro en el archivo', !enDisco.includes(testSecret));
  ok('la direccion no esta en claro en el archivo', !enDisco.includes(testAddr));
  ok('el nombre no esta en claro en el archivo', !enDisco.includes('Test Wallet'));

  // 5. Cerrar y volver a abrir
  storage.bloquear();
  eq('el vault queda cerrado', storage.estado().desbloqueado, false);
  await lanza('la semilla no sale con el vault cerrado', () => storage.getSecret(savedList[0].id), 'bloqueado');
  await lanza('abrir con la contrasena equivocada explota',
    () => storage.desbloquear('incorrecta'), 'Contraseña incorrecta');

  storage.desbloquear(maestra);
  eq('reabierto, la wallet sigue ahi', storage.listWalletsPublic().length, 1);
  eq('reabierto, la semilla coincide', storage.getSecret(savedList[0].id), testSecret);

  // 6. Guardar la variante HD con semilla hexadecimal
  const savedWithHd = storage.saveWallet({
    name: 'Test HD Hex',
    address: hexHdAddresses[0].address,
    type: 'hex_hd',
    secret: hexHdSeed
  });
  eq('lista tiene tambien la HD hexadecimal', savedWithHd.length, 2);
  const savedHd = savedWithHd.find((wallet) => wallet.type === 'hex_hd');
  eq('HD hexadecimal guarda su xpub', savedHd.xpub, hexHdXpub);
  eq('HD hexadecimal inicia receiveIndex en 0', savedHd.receiveIndex, 0);
  eq('HD hexadecimal inicia changeIndex en 0', savedHd.changeIndex, 0);
  eq('semilla HD descifrada coincide', storage.getSecret(savedHd.id), hexHdSeed);

  // 7. Grupos: carpetas para juntar billeteras y ver el saldo de cada conjunto.
  //    Un grupo no toca claves ni direcciones, pero SI decide que se suma con
  //    que, asi que un error aca se lee como plata que aparece o desaparece.
  eq('el vault arranca sin grupos', storage.listGroups().length, 0);

  const ahorros = storage.createGroup('  Ahorros  ');
  eq('el nombre del grupo se guarda sin espacios de sobra', ahorros.name, 'Ahorros');
  eq('el grupo aparece en la lista', storage.listGroups().length, 1);
  await lanza('un grupo sin nombre explota', () => storage.createGroup('   '), 'necesita un nombre');
  // Dos grupos con el mismo nombre son indistinguibles en pantalla, y mover una
  // billetera al equivocado es justo el error que despues cuesta ver.
  await lanza('repetir el nombre de un grupo explota', () => storage.createGroup('ahorros'), 'Ya hay un grupo');

  eq('una billetera guardada arranca sin grupo', storage.listWalletsPublic()[0].groupId, null);
  const conGrupo = storage.assignWalletGroup(savedList[0].id, ahorros.id);
  eq(
    'la billetera queda en el grupo',
    conGrupo.find((wallet) => wallet.id === savedList[0].id).groupId,
    ahorros.id
  );
  await lanza(
    'mover una billetera a un grupo inexistente explota',
    () => storage.assignWalletGroup(savedList[0].id, 'grupo-que-no-existe'),
    'Grupo no encontrado'
  );
  await lanza(
    'guardar una billetera en un grupo inexistente explota',
    () => storage.saveWallet({
      name: 'Fantasma',
      address: 'bitcoincash:qq0000000000000000000000000000000000000000',
      type: 'hex',
      secret: testSecret,
      groupId: 'grupo-que-no-existe',
    }),
    'Grupo no encontrado'
  );
  eq('y la billetera rechazada no quedo guardada', storage.listWalletsPublic().length, 2);

  storage.renameGroup(ahorros.id, 'Ahorros largo plazo');
  eq('renombrar cambia el nombre', storage.listGroups()[0].name, 'Ahorros largo plazo');
  await lanza(
    'renombrar un grupo que no existe explota',
    () => storage.renameGroup('grupo-que-no-existe', 'Otro'),
    'Grupo no encontrado'
  );

  // Los grupos viajan cifrados con todo lo demas: el archivo robado tampoco
  // dice como tiene organizada la plata el dueño.
  const enDiscoConGrupos = fs.readFileSync(storage.filePath, 'utf8');
  ok('el nombre del grupo no esta en claro en el archivo', !enDiscoConGrupos.includes('Ahorros'));

  storage.bloquear();
  storage.desbloquear(maestra);
  eq('reabierto, el grupo sigue ahi', storage.listGroups()[0].name, 'Ahorros largo plazo');
  eq(
    'reabierto, la billetera sigue en su grupo',
    storage.listWalletsPublic().find((wallet) => wallet.id === savedList[0].id).groupId,
    ahorros.id
  );

  // Lo que mas importa de borrar un grupo: NO se lleva puestas las billeteras.
  eq('borrar el grupo lo saca de la lista', storage.deleteGroup(ahorros.id).length, 0);
  eq('pero las billeteras siguen guardadas', storage.listWalletsPublic().length, 2);
  eq(
    'y quedan sin grupo, no invisibles',
    storage.listWalletsPublic().find((wallet) => wallet.id === savedList[0].id).groupId,
    null
  );
  eq('la semilla sobrevive al borrado del grupo', storage.getSecret(savedList[0].id), testSecret);
  await lanza(
    'borrar dos veces el mismo grupo explota',
    () => storage.deleteGroup(ahorros.id),
    'Grupo no encontrado'
  );

  // 8. Un vault de la version anterior guardaba la lista de billeteras pelada,
  //    sin grupos. Tiene que abrirse igual: si no, las billeteras del usuario
  //    parecen perdidas aunque el archivo este intacto.
  {
    const nodeCrypto = require('node:crypto');
    const archivo = JSON.parse(fs.readFileSync(storage.filePath, 'utf8'));
    const params = archivo.kdf;
    const key = nodeCrypto.pbkdf2Sync(
      maestra, Buffer.from(archivo.salt, 'hex'), params.iterations, params.keyLength, params.hash
    );

    const decipher = nodeCrypto.createDecipheriv('aes-256-gcm', key, Buffer.from(archivo.iv, 'hex'));
    decipher.setAuthTag(Buffer.from(archivo.tag, 'hex'));
    const plano = decipher.update(archivo.encryptedText, 'hex', 'utf8') + decipher.final('utf8');
    const listaPelada = JSON.stringify(JSON.parse(plano).wallets);

    const iv = nodeCrypto.randomBytes(12);
    const cipher = nodeCrypto.createCipheriv('aes-256-gcm', key, iv);
    const cifrado = cipher.update(listaPelada, 'utf8', 'hex') + cipher.final('hex');
    storage.bloquear();
    fs.writeFileSync(storage.filePath, JSON.stringify({
      version: 2,
      kdf: params,
      salt: archivo.salt,
      iv: iv.toString('hex'),
      tag: cipher.getAuthTag().toString('hex'),
      encryptedText: cifrado,
    }, null, 2));

    storage.desbloquear(maestra);
    eq('un vault de la version anterior se abre igual', storage.listWalletsPublic().length, 2);
    eq('y arranca sin grupos, no roto', storage.listGroups().length, 0);
    eq('con las semillas intactas', storage.getSecret(savedList[0].id), testSecret);
    // Y desde ahi se puede seguir: el formato nuevo se escribe al primer cambio.
    const migrado = storage.createGroup('Despues de migrar');
    storage.bloquear();
    storage.desbloquear(maestra);
    eq('el grupo creado sobre el vault migrado persiste', storage.listGroups()[0].name, 'Despues de migrar');
    storage.deleteGroup(migrado.id);
  }

  // 9. Borrar wallets
  storage.deleteWallet(savedHd.id);
  const afterDelete = storage.deleteWallet(savedList[0].id);
  eq('lista vuelve a estar vacia', afterDelete.length, 0);

  // Limpieza final
  storage.bloquear();
  // storage escribe un .bak al guardar: si no se borra, el rmdir de abajo falla
  // en silencio y queda test_data/ con wallets de prueba adentro.
  for (const f of [storage.filePath, storage.filePath + '.bak', storage.legacyPath]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  const testDataDir = path.dirname(storage.filePath);
  if (fs.existsSync(testDataDir)) {
    try { fs.rmdirSync(testDataDir); } catch {}
  }


  // ============================================================
  // Consenso entre servidores Electrum
  //
  // Lo que se prueba aca no es la red: es el comparador. Entran respuestas de
  // operadores distintos y tiene que decidir si el dato vale. Los casos que
  // mas importan son los falsos positivos — diferencias legitimas entre
  // servidores que NO tienen que disparar alarma.
  // ============================================================
  console.log('\n== Consenso entre operadores ==');

  const bal = (operator, confirmed, unconfirmed = 0, height = 964552) =>
    ({ operator, height, value: { confirmed, unconfirmed } });

  {
    const v = consensus.resolveBalance([bal('a', 5000), bal('b', 5000), bal('c', 5000)]);
    ok('tres operadores que coinciden dan dato verificado', v.verified === true);
    eq('el saldo de consenso es el que dijeron todos', v.value.confirmed, 5000);
    eq('nadie discrepa', v.dissentBy.length, 0);
  }

  {
    const v = consensus.resolveBalance([bal('a', 5000), bal('b', 5000), bal('c', 9999)]);
    ok('un operador mintiendo invalida la verificacion', v.verified === false);
    eq('motivo es discrepancia', v.reason, 'discrepancia');
    eq('gana la mayoria honesta', v.value.confirmed, 5000);
    eq('se identifica al que discrepa', v.dissentBy[0].operator, 'c');
  }

  {
    const v = consensus.resolveBalance([bal('a', 5000)]);
    ok('un solo operador nunca alcanza para verificar', v.verified === false);
    eq('motivo es pocos-operadores', v.reason, 'pocos-operadores');
  }

  {
    // Mempool: dos servidores ven la misma tx confirmada pero distinta cantidad
    // sin confirmar. Eso es propagacion, no fraude: no debe romper el consenso.
    const v = consensus.resolveBalance([bal('a', 5000, 700), bal('b', 5000, 0)]);
    ok('divergencia de mempool no invalida el saldo confirmado', v.verified === true);
    eq('el no confirmado se muestra conservador (el menor)', v.value.unconfirmed, 0);
  }

  {
    // Desfase de altura: `b` ya proceso un bloque que `a` todavia no tiene, y
    // por eso ve un UTXO de mas. Recortando a la altura comun, coinciden.
    const utxoViejo = { tx_hash: 'aa', tx_pos: 0, height: 964000, value: 1000 };
    const utxoNuevo = { tx_hash: 'bb', tx_pos: 0, height: 964553, value: 2000 };
    const v = consensus.resolveUtxos([
      { operator: 'a', height: 964552, value: [utxoViejo] },
      { operator: 'b', height: 964553, value: [utxoViejo, utxoNuevo] },
    ]);
    ok('un servidor un bloque adelantado no cuenta como discrepancia', v.verified === true);
    eq('la altura de corte es la mas baja', v.cutoffHeight, 964552);
    eq('solo entra el UTXO que ambos ven', v.value.length, 1);
    eq('y es el viejo', v.value[0].tx_hash, 'aa');
  }

  {
    // Mismo UTXO pero con distinto valor: eso ya no se explica por desfase.
    const v = consensus.resolveUtxos([
      { operator: 'a', height: 964552, value: [{ tx_hash: 'aa', tx_pos: 0, height: 964000, value: 1000 }] },
      { operator: 'b', height: 964552, value: [{ tx_hash: 'aa', tx_pos: 0, height: 964000, value: 5000 }] },
    ]);
    ok('un UTXO con monto alterado rompe el consenso', v.verified === false);
  }

  {
    // Un UTXO fantasma que solo ve un servidor, por debajo de la altura de corte.
    const real = { tx_hash: 'aa', tx_pos: 0, height: 964000, value: 1000 };
    const fantasma = { tx_hash: 'ff', tx_pos: 0, height: 964100, value: 99999 };
    const v = consensus.resolveUtxos([
      { operator: 'a', height: 964552, value: [real] },
      { operator: 'b', height: 964552, value: [real] },
      { operator: 'c', height: 964552, value: [real, fantasma] },
    ]);
    ok('un UTXO inventado por un solo operador no pasa', v.verified === false);
    ok('el UTXO fantasma queda afuera del resultado',
       v.value.every(u => u.tx_hash !== 'ff'));
  }

  {
    // 0-conf: en BCH no hay RBF, asi que una tx del mempool no se puede
    // reemplazar por otra que pague mas. Gastarla es parte del diseño de la
    // red, y no hacerlo dejaba plata visible en pantalla pero inmovil.
    const real = { tx_hash: 'aa', tx_pos: 0, height: 964000, value: 1000 };
    const fresca = { tx_hash: 'nn', tx_pos: 1, height: 0, value: 7000 };
    const v = consensus.resolveUtxos([
      { operator: 'a', height: 964552, value: [real, fresca] },
      { operator: 'b', height: 964552, value: [real, fresca] },
    ]);
    ok('un UTXO del mempool que ven dos operadores se puede gastar',
       v.value.some(u => u.tx_hash === 'nn'));
    eq('y se cuenta como sin confirmar', v.sinConfirmar, 1);
    ok('el mempool no rompe el consenso de lo confirmado', v.verified === true);
  }

  {
    // Un mempool que vio uno solo no alcanza: puede ser propagacion a medias o
    // puede ser un servidor inventando una moneda que no existe. Sin un segundo
    // testigo no hay forma de distinguirlas, y con esto se firma.
    const real = { tx_hash: 'aa', tx_pos: 0, height: 964000, value: 1000 };
    const soloUno = { tx_hash: 'zz', tx_pos: 0, height: 0, value: 500000 };
    const v = consensus.resolveUtxos([
      { operator: 'a', height: 964552, value: [real, soloUno] },
      { operator: 'b', height: 964552, value: [real] },
      { operator: 'c', height: 964552, value: [real] },
    ]);
    ok('un UTXO del mempool que ve un solo operador NO entra',
       v.value.every(u => u.tx_hash !== 'zz'));
    ok('y que uno vea de mas no invalida lo confirmado', v.verified === true);
  }

  {
    // El monto es parte de la identidad: el mismo outpoint por otra plata no
    // es el mismo UTXO, y sumarlos daria por bueno un monto que nadie confirmo.
    const v = consensus.resolveUtxos([
      { operator: 'a', height: 964552, value: [{ tx_hash: 'nn', tx_pos: 0, height: 0, value: 7000 }] },
      { operator: 'b', height: 964552, value: [{ tx_hash: 'nn', tx_pos: 0, height: 0, value: 9000 }] },
    ]);
    eq('el mismo outpoint con montos distintos no junta quorum', v.sinConfirmar, 0);
  }

  {
    // Dos hosts del mismo dueño son un testigo, tambien para el mempool.
    const fresca = { tx_hash: 'nn', tx_pos: 0, height: 0, value: 7000 };
    const v = consensus.utxosConQuorum([
      { operator: 'imaginary.cash', value: [fresca] },
      { operator: 'imaginary.cash', value: [fresca] },
    ]);
    eq('el mismo operador dos veces no hace quorum', v.length, 0);
  }

  {
    // -1 es mempool con padre sin confirmar: cadena de 0-conf. BCH la permite.
    const encadenada = { tx_hash: 'cc', tx_pos: 0, height: -1, value: 3000 };
    const v = consensus.utxosConQuorum([
      { operator: 'a', value: [encadenada] },
      { operator: 'b', value: [encadenada] },
    ]);
    eq('una cadena de sin confirmar tambien se puede gastar', v.length, 1);
  }

  {
    // Confirmarse no puede volver una moneda MENOS gastable.
    //
    // El operador `a` va un bloque atras y todavia ve la moneda en el mempool;
    // `b` y `c` ya procesaron el bloque y la reportan a una altura por encima
    // del corte comun. Con el recorte solo, la moneda se caia de los dos lados:
    // arriba del corte para los confirmados, y con un solo avistaje en el
    // mempool. Un segundo antes, sin confirmar, era gastable.
    const fresca = { tx_hash: 'nn', tx_pos: 0, value: 7000 };
    const v = consensus.resolveUtxos([
      { operator: 'a', height: 964552, value: [{ ...fresca, height: 0 }] },
      { operator: 'b', height: 964553, value: [{ ...fresca, height: 964553 }] },
      { operator: 'c', height: 964553, value: [{ ...fresca, height: 964553 }] },
    ]);
    ok('una moneda recien minada con un operador atrasado sigue siendo gastable',
       v.value.some(u => u.tx_hash === 'nn'));
    eq('y entra una sola vez', v.value.filter(u => u.tx_hash === 'nn').length, 1);
  }

  {
    // El orden en que cada servidor devuelve los UTXOs no debe importar.
    const u1 = { tx_hash: 'aa', tx_pos: 0, height: 964000, value: 1000 };
    const u2 = { tx_hash: 'bb', tx_pos: 1, height: 964001, value: 2000 };
    const v = consensus.resolveUtxos([
      { operator: 'a', height: 964552, value: [u1, u2] },
      { operator: 'b', height: 964552, value: [u2, u1] },
    ]);
    ok('el orden de los UTXOs no afecta la comparacion', v.verified === true);
  }

  {
    // Sin respuestas no se inventa un veredicto optimista.
    const v = consensus.resolveBalance([]);
    ok('cero respuestas nunca da verificado', v.verified === false);
    eq('motivo es sin-respuestas', v.reason, 'sin-respuestas');
    eq('y no hay valor', v.value, null);
  }

  {
    // El historial confirmado se compara; lo pendiente se conserva aparte.
    const v = consensus.resolveHistory([
      { operator: 'a', height: 964552, value: [{ tx_hash: 'aa', height: 964000 }, { tx_hash: 'pp', height: 0 }] },
      { operator: 'b', height: 964552, value: [{ tx_hash: 'aa', height: 964000 }] },
    ]);
    ok('el historial coincide ignorando el mempool', v.verified === true);
    eq('devuelve la confirmada y la pendiente', v.value.length, 2);
  }

  {
    // El caso que rompio la wallet: un pago recien confirmado desaparecia.
    //
    // El operador `a` ya proceso el bloque nuevo y reporta la tx a esa altura;
    // `b` todavia no y la sigue viendo en el mempool. La altura de corte se va
    // al tip mas bajo, y la tx queda por ENCIMA: fuera de la comparacion (bien,
    // el desfase no es una mentira) pero tambien fuera de la respuesta (mal, es
    // plata que existe). El barrido HD lee ese historial vacio como "esta
    // direccion nunca se uso", se saltea la consulta de saldo, y el detalle de
    // la billetera muestra 0 mientras la lista —que pregunta el saldo directo—
    // muestra el monto real.
    const v = consensus.resolveHistory([
      { operator: 'a', height: 964553, value: [{ tx_hash: 'vieja', height: 964000 }, { tx_hash: 'nueva', height: 964553 }] },
      { operator: 'b', height: 964552, value: [{ tx_hash: 'vieja', height: 964000 }, { tx_hash: 'nueva', height: 0 }] },
    ]);
    ok('un bloque de desfase sigue sin ser discrepancia', v.verified === true);
    eq('la altura de corte es la del mas atrasado', v.cutoffHeight, 964552);
    ok('la tx recien confirmada NO se pierde',
       v.value.some(e => e.tx_hash === 'nueva'));
    eq('y no se duplica por verla dos veces', v.value.filter(e => e.tx_hash === 'nueva').length, 1);
    eq('se queda con la altura confirmada, no con la del mempool',
       v.value.find(e => e.tx_hash === 'nueva').height, 964553);
  }

  {
    // El mismo desfase, en la direccion que estrena su primera transaccion:
    // ahi el historial recortado no queda corto, queda VACIO, que es la unica
    // respuesta que el barrido interpreta como certeza.
    const v = consensus.resolveHistory([
      { operator: 'a', height: 964553, value: [{ tx_hash: 'nueva', height: 964553 }] },
      { operator: 'b', height: 964552, value: [{ tx_hash: 'nueva', height: 0 }] },
    ]);
    eq('una direccion estrenada no se reporta como sin actividad', v.value.length, 1);
  }

  {
    // El otro lado del trato: sumar lo que vio cada uno no puede volverse una
    // puerta para meter transacciones inventadas por debajo del corte, que es
    // justo el tramo que el consenso si compara.
    const real = { tx_hash: 'aa', height: 964000 };
    const fantasma = { tx_hash: 'ff', height: 964100 };
    const v = consensus.resolveHistory([
      { operator: 'a', height: 964552, value: [real] },
      { operator: 'b', height: 964552, value: [real] },
      { operator: 'c', height: 964552, value: [real, fantasma] },
    ]);
    ok('el operador que inventa una tx confirmada queda afuera del grupo',
       v.value.every(e => e.tx_hash !== 'ff'));
    ok('y la discrepancia se reporta', v.verified === false);
  }

  {
    // Dos hosts del mismo dueño no son dos testigos. El pool ya conecta uno por
    // operador; este test fija el contrato de que se cuenta por `operator`,
    // para que una mayoria falsa no pase si eso se rompiera.
    const t = consensus.tally(
      [bal('imaginary.cash', 9999), bal('imaginary.cash', 9999), bal('loping.net', 5000)],
      r => consensus.balanceFingerprint(r.value)
    );
    eq('el operador repetido aporta dos entradas al tally', t.agreedBy.length, 2);
    ok('pero sigue siendo un solo dueño distinto',
       new Set(t.agreedBy).size === 1);
  }



  // ============================================================
  // Cadena de cabeceras: proof-of-work y ASERT
  //
  // Los vectores son cabeceras REALES de BCH alrededor del ancla ASERT
  // (bloques 661646 a 661651). No son inventadas: si la implementacion de
  // ASERT se desvia aunque sea en un bloque, estos numeros no cierran.
  // ============================================================
  console.log('\n== Cadena: dificultad y proof-of-work ==');

  // Cabeceras consecutivas desde 661646 (el padre del ancla ASERT).
  const HEADERS_REALES = [
    '00000020ac1d4c0fdf21cfcba41d0bb00802ed3020befbedb8bbd700000000000000000008979c37cc3ff63198dc807c3b710f9df37fdc843b0db9de41bc78dbe5279f14a430b15f3ec00418d1623dd0',
    '000000202df7a2e0562ebbbd8dc95ca6669c4f1ba888484c2cc7e403000000000000000067418c23d8901e49555725fb2e37adfb9ed29a05833eb4774d53b63b44ba457e8937b15ffeda04183c2b1978',
    '000000202fe6ee2db04b6575ad185521133598e3590d787a4bed8300000000000000000042faaa7bb98abdfb6f780417b1c0eb7873cd49e048feef273d5e270e1eb223855938b15fd0e0041888420330',
    '0000c020cea8b5f909054a0befc47110914cb7b8248d81411c479e020000000000000000039ea56fe7dfc4d384002372286a5c024853f44598a7ab6263c601744a51921a913cb15fdcde04186567266f',
    '00e0ff37c2797878686dcff9a6cb1a182f326d3dabe27195d52dcc040000000000000000cc93adc8a42a413b45697da36694ced25e00b6eeff1fd935cce243a13961ec47b03db15f45e10418a6d026a5',
    '000000205c93bb7e4caee647ff349ca4660a221be4344990c48ec004000000000000000010d825cdcb21f024ed723f3b3cfe80a5b3fbe10958d28be57ed1a29d865883497a42b15fb2df04189e864f51',
  ];
  const ALTURA_BASE = 661646;
  const cadenaReal = Buffer.from(HEADERS_REALES.join(''), 'hex');
  const cabecera = i => cadenaReal.subarray(i * 80, (i + 1) * 80);

  // --- Formato compacto de dificultad ---
  {
    const bits = chain.ASERT_ANCHOR.bits;
    eq('bits -> target -> bits vuelve al original', chain.targetToBits(chain.bitsToTarget(bits)), bits);
    ok('el target del ancla es positivo', chain.bitsToTarget(bits) > 0n);
    ok('el target del ancla esta bajo el limite', chain.bitsToTarget(bits) < chain.POW_LIMIT);
    // Dificultad 1 de Bitcoin: el target maximo permitido.
    ok('bits 0x1d00ffff da exactamente el POW_LIMIT',
      chain.bitsToTarget(0x1d00ffff) === chain.POW_LIMIT);
  }

  // --- El ancla del codigo coincide con la cadena real ---
  {
    eq('los bits del ancla son los del bloque 661647',
      chain.headerBits(cabecera(1)), chain.ASERT_ANCHOR.bits);
    eq('el parentTime del ancla es el timestamp de 661646',
      chain.headerTime(cabecera(0)), chain.ASERT_ANCHOR.parentTime);
  }

  // --- ASERT contra los bloques reales posteriores al ancla ---
  {
    // La dificultad del bloque N sale del timestamp y la altura de su PADRE.
    // Este es el detalle facil de equivocar: usar los del propio bloque da una
    // curva corrida en uno, que valida mal sin hacer ningun ruido.
    for (let i = 2; i < HEADERS_REALES.length; i++) {
      const altura = ALTURA_BASE + i;
      const esperado = chain.expectedBits(altura - 1, chain.headerTime(cabecera(i - 1)));
      eq('ASERT predice la dificultad del bloque ' + altura, esperado, chain.headerBits(cabecera(i)));
    }
  }

  // --- Verificacion de un tramo ---
  {
    const tramo = cadenaReal.subarray(80);
    const v = chain.verifyHeaders(tramo, ALTURA_BASE + 1, cabecera(0));
    ok('el tramo real de 5 cabeceras valida entero', v.ok === true);
    eq('verifico las 5', v.checked, 5);
  }

  {
    // Encadenamiento roto: se saltea una cabecera del medio.
    const salteado = Buffer.concat([cabecera(1), cabecera(3)]);
    const v = chain.verifyHeaders(salteado, ALTURA_BASE + 1, cabecera(0));
    ok('un tramo con una cabecera faltante se rechaza', v.ok === false);
    ok('el error menciona el enganche', /engancha/.test(v.error));
  }

  {
    // Proof-of-work roto: cambiar el nonce cambia el hash del bloque.
    const conNonceRoto = Buffer.from(cabecera(1));
    conNonceRoto.writeUInt32LE(999999, 76);
    const v = chain.verifyHeaders(conNonceRoto, ALTURA_BASE + 1, cabecera(0));
    ok('una cabecera con el nonce alterado se rechaza', v.ok === false);
    ok('el error menciona el proof-of-work', /proof-of-work/.test(v.error));
  }

  {
    // Un buffer cuyo largo no es multiplo de 80 no es una cadena de cabeceras.
    const cortado = cadenaReal.subarray(0, 100);
    const v = chain.verifyHeaders(cortado, ALTURA_BASE, null);
    ok('un buffer de largo invalido se rechaza', v.ok === false);
  }

  {
    // Sin padre no se puede verificar encadenamiento ni ASERT, pero el
    // proof-of-work se comprueba igual.
    const v = chain.verifyHeaders(cabecera(1), ALTURA_BASE + 1, null);
    ok('una cabecera suelta valida su PoW sin padre', v.ok === true);
  }

  console.log('\n== Cadena: merkle proofs (SPV) ==');

  // Arbol merkle armado a mano con cuatro hojas:
  //
  //          root
  //         /    \
  //     H(AB)    H(CD)
  //     /  \     /  \
  //    A    B   C    D
  //
  // Para probar que A esta en el arbol alcanza con la rama [B, H(CD)].
  {
    const hoja = h => Buffer.from(h, 'hex').reverse();
    const A = 'aa'.repeat(32), B = 'bb'.repeat(32), C = 'cc'.repeat(32), D = 'dd'.repeat(32);

    const hAB = chain.sha256d(Buffer.concat([hoja(A), hoja(B)]));
    const hCD = chain.sha256d(Buffer.concat([hoja(C), hoja(D)]));
    const rootEsperado = Buffer.from(chain.sha256d(Buffer.concat([hAB, hCD]))).reverse().toString('hex');
    const hCDdisplay = Buffer.from(hCD).reverse().toString('hex');

    eq('la rama de la hoja A reconstruye el root',
      spv.merkleRootFromProof(A, 0, [B, hCDdisplay]), rootEsperado);

    // La hoja B esta en posicion 1: el hermano va del otro lado.
    eq('la rama de la hoja B reconstruye el mismo root',
      spv.merkleRootFromProof(B, 1, [A, hCDdisplay]), rootEsperado);

    ok('una posicion equivocada da otro root',
      spv.merkleRootFromProof(A, 1, [B, hCDdisplay]) !== rootEsperado);

    ok('una rama adulterada da otro root',
      spv.merkleRootFromProof(A, 0, ['ff'.repeat(32), hCDdisplay]) !== rootEsperado);
  }

  {
    // Sin cabecera verificada para esa altura, no se afirma nada.
    const v = spv.verifyTransaction('ab'.repeat(32), 1, { merkle: [], pos: 0 });
    ok('sin cabecera verificada no se da por verificada', v.verified === false);
    eq('y el motivo lo dice', v.reason, 'sin-cabecera');
  }

  {
    // Una prueba mal formada se rechaza sin explotar.
    const v = spv.verifyTransaction('ab'.repeat(32), 961549, null);
    ok('una prueba ausente se rechaza', v.verified === false);
    eq('motivo prueba-invalida', v.reason, 'prueba-invalida');
  }

  {
    // Si el servidor dice una altura y el historial dice otra, no se sigue.
    const v = spv.verifyTransaction('ab'.repeat(32), 961549, { merkle: [], pos: 0, block_height: 900000 });
    ok('una altura discrepante se rechaza', v.verified === false);
    eq('motivo altura-discrepante', v.reason, 'altura-discrepante');
  }


  console.log('\n== Seleccion de monedas: que direcciones se exponen al gastar ==');
  {
    // Un UTXO de mentira, con lo unico que la seleccion mira: direccion y monto.
    let contador = 0;
    const utxo = (address, value) => ({
      address,
      value,
      tx_hash: String(++contador).padStart(64, '0'),
      tx_pos: 0,
    });

    const direcciones = (seleccion) => new Set(seleccion.inputs.map(i => i.address));

    {
      // Tres direcciones, cualquiera alcanza sola: se usa UNA, y la mas chica
      // que cubra, para no romper una moneda grande al pedo.
      const utxos = [utxo('addrA', 100000), utxo('addrB', 200000), utxo('addrC', 50000)];
      const sel = coinselect.selectCoins({ utxos, amountSats: 30000 });

      eq('gasta de una sola direccion', sel.addressCount, 1);
      eq('con una sola entrada', sel.inputCount, 1);
      ok('no marca direcciones unidas', sel.merged === false);
      eq('elige la mas chica que alcanza', sel.inputs[0].address, 'addrC');
      eq('y no toca las otras dos', direcciones(sel).size, 1);
    }

    {
      // Un grupo de 3 monedas chicas alcanza, y uno de 1 moneda grande tambien.
      // Gana el de 1: menos entradas es menos comision y menos huella on-chain.
      const utxos = [
        utxo('addrD', 20000), utxo('addrD', 20000), utxo('addrD', 20000),
        utxo('addrE', 70000),
      ];
      const sel = coinselect.selectCoins({ utxos, amountSats: 30000 });

      eq('prefiere menos entradas antes que menor total', sel.inputs[0].address, 'addrE');
      eq('y usa una sola entrada', sel.inputCount, 1);
    }

    {
      // El grupo de una direccion se gasta entero: gastar la mitad no protege
      // nada, porque al firmar ya revelaste que esa direccion es tuya.
      const utxos = [utxo('addrF', 30000), utxo('addrF', 40000)];
      const sel = coinselect.selectCoins({ utxos, amountSats: 25000 });

      eq('usa las dos monedas de la direccion', sel.inputCount, 2);
      eq('sigue siendo una sola direccion', sel.addressCount, 1);
    }

    {
      // Ninguna alcanza sola: recien ahi se unen, de mayor a menor, para
      // exponer la menor cantidad de direcciones posible.
      const utxos = [utxo('addrA', 40000), utxo('addrB', 30000), utxo('addrC', 20000)];
      const sel = coinselect.selectCoins({ utxos, amountSats: 70000 });

      ok('avisa que unio direcciones', sel.merged === true);
      eq('y dice cuantas', sel.addressCount, 3);
      ok('el total alcanza para monto mas comision',
        sel.totalIn >= 70000 + sel.feeSats);
    }

    {
      // Dust attack: te mandan polvo a una direccion tuya para que vos mismo lo
      // unas al resto. Una moneda que vale menos que su propia comision nunca
      // entra sola en un envio.
      const utxos = [utxo('addrA', 100000), utxo('addrDust', 100)];
      const sel = coinselect.selectCoins({ utxos, amountSats: 30000 });

      ok('el polvo no entra en la transaccion', !direcciones(sel).has('addrDust'));
      eq('y queda reportado como descartado', sel.skipped.length, 1);

      eq('149 sats no cubren su propia entrada', coinselect.isProfitable({ value: 149 }), false);
      eq('150 sats si', coinselect.isProfitable({ value: 150 }), true);
    }

    {
      // Los UTXOs llegan de consultas en paralelo: el orden puede cambiar entre
      // la pantalla de confirmacion y el envio. La seleccion no puede cambiar
      // con el, o el usuario firmaria algo distinto de lo que aprobo.
      const utxos = [
        utxo('addrA', 40000), utxo('addrB', 40000),
        utxo('addrC', 25000), utxo('addrD', 25000),
      ];
      const primera = coinselect.selectCoins({ utxos, amountSats: 60000 });
      const segunda = coinselect.selectCoins({ utxos: utxos.slice().reverse(), amountSats: 60000 });

      eq('la misma seleccion sin importar el orden de llegada',
        Array.from(direcciones(primera)).sort().join(','),
        Array.from(direcciones(segunda)).sort().join(','));
      eq('y la misma comision', primera.feeSats, segunda.feeSats);
    }

    {
      // Cuando el cambio quedaria por debajo del dust no se puede devolver:
      // se va en comision y la tx queda con una sola salida.
      const seleccionados = [{ value: 20527 }];
      const plan = coinselect.planFor(seleccionados, 20000);

      ok('el plan es viable', plan.ok === true);
      eq('sin salida de cambio', plan.changeSats, 0);
      eq('el remanente se va en comision', plan.feeSats, 527);
    }

    {
      const seleccionados = [{ value: 100000 }];
      const plan = coinselect.planFor(seleccionados, 20000);
      eq('con cambio, la comision es la de dos salidas', plan.feeSats, 10 + 149 + 68);
      eq('y el cambio es el resto', plan.changeSats, 100000 - 20000 - (10 + 149 + 68));
    }

    {
      // Saldo desparramado en muchas direcciones chicas. No hay tope propio de
      // entradas: si el saldo alcanza, el envio sale. Un tope inventado le
      // negaria al usuario una transaccion que la red si acepta.
      const muchas = [];
      for (let i = 0; i < 60; i++) muchas.push(utxo('addr' + i, 10000));

      const sel = coinselect.selectCoins({ utxos: muchas, amountSats: 550000 });

      ok('60 direcciones se unen sin toparse con un limite propio',
        sel.addressCount > 50);
      ok('y avisa que unio direcciones', sel.merged === true);
      ok('el total alcanza para monto mas comision',
        sel.totalIn >= 550000 + sel.feeSats);
    }

    {
      const utxos = [utxo('addrA', 5000)];
      assert.throws(
        () => coinselect.selectCoins({ utxos, amountSats: 100000 }),
        /No alcanza el saldo/,
        'FALLO: saldo insuficiente tiene que decirse asi'
      );
      console.log('  OK  saldo insuficiente: el error lo dice');
      passed++;
    }

    {
      // Vaciar la wallet SI barre todo: es lo que el usuario pidio. Pero el
      // polvo que resta valor sigue afuera, y se informa cuantas direcciones une.
      const utxos = [utxo('addrA', 100000), utxo('addrB', 50000), utxo('addrDust', 100)];
      const plan = coinselect.planMaxSend({ utxos });

      eq('barre las dos direcciones con fondos', plan.addressCount, 2);
      eq('sin arrastrar el polvo', plan.utxoCount, 2);
      eq('comision de dos entradas y una salida', plan.feeSats, 10 + 2 * 149 + 34);
      eq('el maximo es todo menos la comision', plan.maxSats, 150000 - (10 + 2 * 149 + 34));
    }

    {
      // Vaciar es vaciar: 80 monedas rentables se barren las 80. Dejar resto
      // convierte "enviar todo" en una operacion que no envia todo, y obliga a
      // una segunda tx al mismo destino —mas comision y mas huella temporal.
      const utxos = [];
      for (let i = 0; i < 80; i++) utxos.push(utxo('addr' + i, 10000));
      const plan = coinselect.planMaxSend({ utxos });

      eq('barre las 80 monedas', plan.utxoCount, 80);
      eq('y las 80 direcciones', plan.addressCount, 80);
      eq('sin dejar nada afuera', plan.totalSats, 800000);
    }
  }

  {
    // El puente entre las dos mitades: lo que la pantalla de confirmacion le
    // muestra al usuario tiene que ser exactamente lo que se firma. Si la
    // seleccion y la construccion calcularan distinto, el usuario aprobaria una
    // comision y pagaria otra.
    const utxosDeDosDirecciones = [
      { tx_hash: 'aa'.repeat(32), tx_pos: 0, address: hexHdAddresses[0].address, value: 60000 },
      { tx_hash: 'bb'.repeat(32), tx_pos: 0, address: hexHdAddresses[1].address, value: 90000 },
    ];
    const indicePorDireccion = { [hexHdAddresses[0].address]: 0, [hexHdAddresses[1].address]: 1 };

    const plan = w.planSend({
      utxos: utxosDeDosDirecciones,
      toAddress: hexHdAddresses[2].address,
      amountSats: 50000,
    });
    eq('el envio se cubre con una sola direccion', plan.addressCount, 1);

    const firmada = w.buildAndSignTx({
      inputs: plan.inputs.map(u => ({
        ...u,
        privKeyHex: w.getPrivateKeyHexForHexHdPath(hexHdSeed, 0, 0, indicePorDireccion[u.address]),
      })),
      toAddress: hexHdAddresses[2].address,
      changeAddress: change0.address,
      amountSats: 50000,
    });

    eq('la comision firmada es la que se mostro', firmada.feeSats, plan.feeSats);
    eq('el vuelto firmado es el que se mostro', firmada.changeSats, plan.changeSats);
    eq('se firman solo las entradas elegidas', firmada.inputCount, plan.inputCount);

    const parsed = new bitcore.Transaction(firmada.hex);
    const salidas = parsed.outputs.reduce((s, o) => s + o.satoshis, 0);
    eq('entradas = salidas + comision', plan.totalIn, salidas + firmada.feeSats);
    ok('la direccion no gastada sigue intacta',
      !plan.inputs.some(u => u.address === hexHdAddresses[1].address));
  }

  {
    console.log('\n== Barrido de UTXOs: "no se" no es "no hay" ==');
    // Regresion de un bug que llego a produccion en v0.10.0: la wallet decia
    // "No hay fondos suficientes (0 UTXOs)" con la plata intacta en la cadena.
    // El barrido toleraba fallos mientras no pasaran la mitad; con 75
    // direcciones y una sola con fondos, el timeout de esa unica direccion
    // contaba 1 de 75 y la lista salia vacia como si fuera un hecho.

    // Wallet realista: 75 direcciones, la del indice 0 tiene toda la plata.
    const direcciones = [];
    for (let i = 0; i < 30; i++) direcciones.push({ address: 'addr-r-' + i, change: 0, index: i });
    for (let i = 0; i < 45; i++) direcciones.push({ address: 'addr-c-' + i, change: 1, index: i });
    const CON_FONDOS = 'addr-r-0';
    const utxoDeLaPlata = { tx_hash: 'cc'.repeat(32), tx_pos: 0, value: 391493 };

    const todasResponden = async (address) => (address === CON_FONDOS ? [utxoDeLaPlata] : []);

    const { utxos } = await utxoscan.collectSpendableUtxos({
      addresses: direcciones, getUtxos: todasResponden,
    });
    eq('con todas las respuestas, encuentra la plata', utxos.length, 1);
    eq('y la ubica en su direccion', utxos[0].address, CON_FONDOS);
    eq('conservando el indice, que el envio necesita', utxos[0].index, 0);

    // El bug exacto: falla SOLO la direccion que tiene los fondos.
    let consultas = 0;
    const fallaLaQueImporta = async (address) => {
      consultas++;
      if (address === CON_FONDOS) throw new Error('socket hang up');
      return [];
    };
    await lanza(
      'un fallo aislado en la unica direccion con fondos NO se reporta como wallet vacia',
      () => utxoscan.collectSpendableUtxos({ addresses: direcciones, getUtxos: fallaLaQueImporta }),
      'no se firma nada'
    );
    ok('y antes de rendirse reintenta', consultas > direcciones.length);

    await lanza(
      'el error dice cuantas direcciones quedaron sin respuesta',
      () => utxoscan.collectSpendableUtxos({ addresses: direcciones, getUtxos: fallaLaQueImporta }),
      '1 de 75 direcciones'
    );

    // Un timeout suelto sí se arregla reintentando: no puede abortar el envio.
    let intentosDeLaQueFalla = 0;
    const fallaUnaVezYSeRecupera = async (address) => {
      if (address === CON_FONDOS) {
        intentosDeLaQueFalla++;
        if (intentosDeLaQueFalla === 1) throw new Error('timeout');
        return [utxoDeLaPlata];
      }
      return [];
    };
    const recuperado = await utxoscan.collectSpendableUtxos({
      addresses: direcciones, getUtxos: fallaUnaVezYSeRecupera,
    });
    eq('un fallo transitorio se resuelve reintentando', recuperado.utxos.length, 1);
    eq('y solo se reintenta lo que fallo', intentosDeLaQueFalla, 2);

    // Una discrepancia entre operadores no mejora reintentando: hay que verla.
    let vecesConsultadaLaDisputada = 0;
    const discrepan = async (address) => {
      if (address !== CON_FONDOS) return [];
      vecesConsultadaLaDisputada++;
      const e = new Error('imaginary.cash dice 391493 y loping.net dice 0');
      e.consensusFailure = true;
      throw e;
    };
    await lanza(
      'una discrepancia entre servidores frena la firma',
      () => utxoscan.collectSpendableUtxos({ addresses: direcciones, getUtxos: discrepan }),
      'no coinciden'
    );
    eq('y no se reintenta, porque no se arregla sola', vecesConsultadaLaDisputada, 1);

    // El barrido decide QUE direcciones se consultan. Si quedo corto, la lista
    // puede estar impecable sobre el universo equivocado.
    await lanza(
      'si la busqueda de direcciones fallo, no se firma aunque los UTXOs respondan',
      () => utxoscan.collectSpendableUtxos({
        addresses: direcciones, getUtxos: todasResponden, discoveryFailures: 1,
      }),
      'No se firma nada'
    );
    await lanza(
      'si la busqueda se corto por tope, tampoco',
      () => utxoscan.collectSpendableUtxos({
        addresses: direcciones, getUtxos: todasResponden, discoveryIncomplete: true,
      }),
      'No se firma nada'
    );

    // Una wallet de verdad vacia tiene que poder decirlo sin lanzar: el error
    // es para "no pude fijarme", no para "me fije y no hay".
    const vacia = await utxoscan.collectSpendableUtxos({
      addresses: direcciones, getUtxos: async () => [],
    });
    eq('una wallet realmente vacia devuelve cero sin lanzar', vacia.utxos.length, 0);
  }

  {
    console.log('\n== Cual direccion se ofrece para cobrar ==');
    // historyLength: 0 = la cadena confirmo que nunca se uso, >0 = se uso,
    // null = no se pudo preguntar. La diferencia entre 0 y null es la regla.
    const rama = (historiales) => historiales.map((h, index) => ({
      index, change: 0, address: 'addr' + index, historyLength: h,
    }));

    eq(
      'ofrece la primera que la cadena vio sin estrenar',
      w.firstUnusedReceiveAddress(rama([3, 1, 0, 0]), 0).index,
      2
    );
    eq(
      'una direccion sin respuesta no se ofrece como nueva',
      w.firstUnusedReceiveAddress(rama([1, null, 0]), 0).index,
      2
    );
    eq(
      'respeta el puntero: lo ya entregado no se vuelve a ofrecer',
      w.firstUnusedReceiveAddress(rama([0, 0, 0, 0]), 2).index,
      2
    );
    eq(
      'si el puntero quedo mas alto que lo barrido, vuelve a una confirmada',
      w.firstUnusedReceiveAddress(rama([1, 0, 0]), 99).index,
      1
    );
    eq(
      'sin ninguna confirmada sin estrenar no inventa una',
      w.firstUnusedReceiveAddress(rama([2, null, 1]), 0),
      null
    );
    eq('sin direcciones devuelve null', w.firstUnusedReceiveAddress([], 0), null);
  }

  console.log(`\nTODO OK (${passed} comprobaciones)\n`);
}

main().catch((e) => {
  console.error('\nERROR EN TESTS:\n', e);
  process.exit(1);
});
