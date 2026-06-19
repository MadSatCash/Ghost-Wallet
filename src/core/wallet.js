// Nucleo de la wallet: creacion / importacion y calculo de direcciones BCH.
//
// La criptografia la hacen librerias auditadas (libauth + bip39).
// Aca NO inventamos criptografia: solo la orquestamos. En una billetera,
// un error de calculo = plata perdida, por eso todo esto esta cubierto por
// tests con vectores conocidos (ver test/wallet.test.js).

const bip39 = require('bip39');

// libauth es un modulo ESM; lo cargamos con import() dinamico y lo cacheamos.
let _lib = null;
async function lib() {
  if (!_lib) _lib = await import('@bitauth/libauth');
  return _lib;
}

const BCH_PREFIX = 'bitcoincash';

// Ruta de derivacion estandar de BCH (BIP44, coin type 145).
const bchPath = (account, change, index) => `m/44'/145'/${account}'/${change}/${index}`;

// Cantidad de palabras -> bits de entropia (BIP39).
const WORDS_TO_BITS = { 12: 128, 15: 160, 18: 192, 21: 224, 24: 256 };
const VALID_WORD_COUNTS = Object.keys(WORDS_TO_BITS).map(Number);

function normalizeMnemonic(m) {
  return String(m).trim().toLowerCase().replace(/\s+/g, ' ');
}

function isHexSecret(input) {
  const s = String(input).trim().replace(/^0x/i, '');
  return /^[0-9a-fA-F]{64}$/.test(s);
}

// Genera una frase nueva de 12, 15, 18, 21 o 24 palabras.
function generateMnemonic(words = 12) {
  const strength = WORDS_TO_BITS[words];
  if (!strength) throw new Error(`Cantidad de palabras no soportada: ${words}`);
  return bip39.generateMnemonic(strength);
}

function validateMnemonic(mnemonic) {
  return bip39.validateMnemonic(normalizeMnemonic(mnemonic));
}

// Detecta que tipo de cosa pego el usuario, para guiar la importacion.
function detectInputType(input) {
  const s = String(input).trim();
  if (isHexSecret(s)) return 'hex';
  const norm = normalizeMnemonic(s);
  const count = norm.split(' ').filter(Boolean).length;
  if (VALID_WORD_COUNTS.includes(count)) {
    return bip39.validateMnemonic(norm) ? 'mnemonic' : 'mnemonic-invalid';
  }
  return 'unknown';
}

// Clave privada (32 bytes) -> direccion CashAddr.
async function addressFromPrivateKey(privKey, { compressed = true } = {}) {
  const L = await lib();
  const pub = compressed
    ? L.secp256k1.derivePublicKeyCompressed(privKey)
    : L.secp256k1.derivePublicKeyUncompressed(privKey);
  if (typeof pub === 'string') throw new Error('Clave privada invalida: ' + pub);
  const res = L.publicKeyToP2pkhCashAddress({ publicKey: pub, prefix: BCH_PREFIX });
  return typeof res === 'string' ? res : res.address;
}

// Importar un secreto de 64 hex como clave privada directa.
// Devuelve las dos "recetas" posibles (comprimida / sin comprimir) para que
// luego se auto-detecte cual tiene saldo (las wallets viejas usaban la sin
// comprimir; las modernas, la comprimida).
async function candidatesFromHexSecret(input) {
  const L = await lib();
  const hex = String(input).trim().replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('El secreto debe tener 64 caracteres hexadecimales (32 bytes).');
  }
  const priv = L.hexToBin(hex);
  if (!L.secp256k1.validatePrivateKey(priv)) {
    throw new Error('Ese secreto no es una clave privada valida.');
  }
  return [
    { recipe: 'compressed', label: 'Estandar (comprimida)', address: await addressFromPrivateKey(priv, { compressed: true }) },
    { recipe: 'uncompressed', label: 'Antigua (sin comprimir)', address: await addressFromPrivateKey(priv, { compressed: false }) },
  ];
}

// Deriva las primeras `count` direcciones de recepcion de una frase.
async function addressesFromMnemonic(mnemonic, { passphrase = '', account = 0, change = 0, count = 5 } = {}) {
  const L = await lib();
  const norm = normalizeMnemonic(mnemonic);
  if (!bip39.validateMnemonic(norm)) {
    throw new Error('La frase no es valida (revisa las palabras o el orden).');
  }
  const seed = bip39.mnemonicToSeedSync(norm, passphrase);
  const root = L.deriveHdPrivateNodeFromSeed(seed);
  const out = [];
  for (let i = 0; i < count; i++) {
    const path = bchPath(account, change, i);
    const node = L.deriveHdPath(root, path);
    if (typeof node === 'string') throw new Error('Error derivando ' + path + ': ' + node);
    out.push({ index: i, path, address: await addressFromPrivateKey(node.privateKey, { compressed: true }) });
  }
  return out;
}

// Genera un secreto nuevo de 64 hex (32 bytes), identico a Python:
// secrets.token_hex(32). Usa el generador criptografico seguro del sistema
// operativo (igual nivel de seguridad que el de Python).
function generateHexSecret() {
  return require('node:crypto').randomBytes(32).toString('hex');
}

// Extrae la Clave Pública Extendida (xPub) para la cuenta m/44'/145'/account'
function getXPubFromMnemonic(mnemonic, account = 0) {
  const bitcore = require('bitcore-lib-cash');
  const norm = normalizeMnemonic(mnemonic);
  const seed = bip39.mnemonicToSeedSync(norm);
  const hdPrivateKey = bitcore.HDPrivateKey.fromSeed(seed);
  const accountNode = hdPrivateKey.deriveChild(`m/44'/145'/${account}'`);
  return accountNode.xpubkey;
}

// Deriva direcciones públicas a partir de un xPub (sin necesidad de semilla)
function getAddressesFromXPub(xpub, change = 0, startIndex = 0, count = 20) {
  const bitcore = require('bitcore-lib-cash');
  const hdPublicKey = new bitcore.HDPublicKey(xpub);
  const changeNode = hdPublicKey.deriveChild(change);
  
  const out = [];
  for (let i = 0; i < count; i++) {
    const index = startIndex + i;
    const childNode = changeNode.deriveChild(index);
    const address = new bitcore.Address(childNode.publicKey).toString();
    out.push({ index, change, address });
  }
  return out;
}

// Devuelve la clave privada (en hex) de la direccion especificada de la frase.
function getPrivateKeyHexForPath(mnemonic, account = 0, change = 0, index = 0) {
  const bitcore = require('bitcore-lib-cash');
  const norm = normalizeMnemonic(mnemonic);
  const seed = bip39.mnemonicToSeedSync(norm);
  const hdPrivateKey = bitcore.HDPrivateKey.fromSeed(seed);
  const child = hdPrivateKey.deriveChild(`m/44'/145'/${account}'/${change}/${index}`);
  return child.privateKey.toString();
}

// Construye y firma una transaccion usando bitcore-lib-cash
function buildAndSignTx({ inputs, toAddress, changeAddress, amountSats, feeRate = 1 }) {
  const bitcore = require('bitcore-lib-cash');
  const privateKeys = inputs.map(i => new bitcore.PrivateKey(i.privKeyHex));

  const bchUtxos = inputs.map(u => new bitcore.Transaction.UnspentOutput({
    txid: u.tx_hash,
    vout: u.tx_pos,
    address: u.address,
    scriptPubKey: bitcore.Script.buildPublicKeyHashOut(u.address).toHex(),
    satoshis: u.value
  }));

  const tx = new bitcore.Transaction()
    .from(bchUtxos)
    .to(toAddress, amountSats)
    .change(changeAddress)
    .feePerByte(feeRate)
    .sign(privateKeys);

  return tx.uncheckedSerialize(); // Devuelve el hex en bruto listo para enviar
}

module.exports = {
  BCH_PREFIX,
  generateHexSecret,
  VALID_WORD_COUNTS,
  normalizeMnemonic,
  isHexSecret,
  generateMnemonic,
  validateMnemonic,
  detectInputType,
  addressFromPrivateKey,
  candidatesFromHexSecret,
  addressesFromMnemonic,
  getXPubFromMnemonic,
  getAddressesFromXPub,
  getPrivateKeyHexForPath,
  buildAndSignTx,
};
