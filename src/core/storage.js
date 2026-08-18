const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

let userDataPath;
try {
  const { app } = require('electron');
  userDataPath = app.getPath('userData');
} catch {
  // Carpeta de fallback para entornos de pruebas sin Electron
  userDataPath = path.join(__dirname, '..', '..', 'test_data');
}

const FILE_PATH = path.join(userDataPath, 'wallets.json');
const TMP_PATH = FILE_PATH + '.tmp';
const BAK_PATH = FILE_PATH + '.bak';

// Solo el dueño puede leer el archivo. En Windows el modo POSIX es simbolico,
// pero en Linux/macOS evita que otros usuarios locales lean los secretos.
const FILE_MODE = 0o600;

// Parametros de derivacion actuales. Se guardan DENTRO de cada registro para
// poder subirlos mas adelante sin dejar ilegibles las wallets ya guardadas.
const KDF = { algo: 'pbkdf2', hash: 'sha256', iterations: 600000, keyLength: 32 };

// Registros viejos (sin campo kdf) usaban estos parametros.
const LEGACY_KDF = { algo: 'pbkdf2', hash: 'sha256', iterations: 100000, keyLength: 32 };

function ensureDirectoryExists() {
  const dir = path.dirname(FILE_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// Lee y parsea el archivo de billeteras.
//
// IMPORTANTE: un archivo ilegible NO puede convertirse en "no hay billeteras".
// Si devolvieramos [] ante un JSON corrupto, el proximo saveWallet escribiria
// encima y borraria los secretos cifrados para siempre. Ante la duda,
// explotamos: es preferible un error visible a una perdida silenciosa.
function readRawWallets() {
  ensureDirectoryExists();
  // Archivo ausente = instalacion nueva (o el usuario lo borro a proposito).
  // NO se recupera del .bak aca: la escritura atomica nunca deja el principal
  // ausente (el backup se hace con el original todavia en su lugar, y el
  // rename lo reemplaza de una), asi que resucitar del backup solo lograria
  // revivir billeteras que alguien borro adrede.
  if (!fs.existsSync(FILE_PATH)) {
    return [];
  }

  const raw = fs.readFileSync(FILE_PATH, 'utf8');
  try {
    return parseWallets(raw, FILE_PATH);
  } catch (e) {
    // El archivo existe pero no se puede leer. Antes de fallar, probamos el
    // backup: cubre el caso de un corte de luz a mitad de escritura.
    if (fs.existsSync(BAK_PATH)) {
      try {
        const recovered = parseWallets(fs.readFileSync(BAK_PATH, 'utf8'), BAK_PATH);
        console.warn('wallets.json estaba corrupto; se recupero desde el backup.');
        return recovered;
      } catch { /* el backup tampoco sirve */ }
    }
    throw new Error(
      'El archivo de billeteras esta danado y no se pudo recuperar del backup. ' +
      'NO crees ni importes billeteras nuevas (sobrescribirian lo que queda). ' +
      'Hace una copia de ' + FILE_PATH + ' antes de seguir. Detalle: ' + e.message
    );
  }
}

function parseWallets(raw, origin) {
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error('El contenido de ' + origin + ' no es una lista de billeteras.');
  }
  return parsed;
}

// Escritura atomica: temporal -> fsync -> rename, con backup del estado previo.
// Un corte de luz en cualquier punto deja siempre un archivo integro (el viejo
// o el nuevo), nunca uno a medias.
function writeRawWallets(wallets) {
  ensureDirectoryExists();

  const payload = JSON.stringify(wallets, null, 2);

  // 1. Backup del estado actual, para poder volver si el rename se corta.
  if (fs.existsSync(FILE_PATH)) {
    try {
      fs.copyFileSync(FILE_PATH, BAK_PATH);
      fs.chmodSync(BAK_PATH, FILE_MODE);
    } catch (e) {
      throw new Error('No se pudo respaldar el archivo de billeteras: ' + e.message);
    }
  }

  // 2. Escribir el temporal y forzarlo a disco antes de reemplazar nada.
  let fd;
  try {
    fd = fs.openSync(TMP_PATH, 'w', FILE_MODE);
    fs.writeFileSync(fd, payload, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* noop */ }
    }
  }

  // 3. Reemplazo atomico.
  fs.renameSync(TMP_PATH, FILE_PATH);
  try { fs.chmodSync(FILE_PATH, FILE_MODE); } catch { /* Windows */ }

  return true;
}

// --- Cifrado AES-256-GCM ---

function deriveKey(password, salt, params) {
  return crypto.pbkdf2Sync(password, salt, params.iterations, params.keyLength, params.hash);
}

function encrypt(text, password) {
  const salt = crypto.randomBytes(16);
  const key = deriveKey(password, salt, KDF);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  return {
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    tag: tag,
    encryptedText: encrypted,
    kdf: { ...KDF },
  };
}

function decrypt(encryptedObj, password) {
  // Sin campo kdf => registro viejo, derivado con los parametros originales.
  const params = encryptedObj.kdf || LEGACY_KDF;
  const salt = Buffer.from(encryptedObj.salt, 'hex');
  const iv = Buffer.from(encryptedObj.iv, 'hex');
  const tag = Buffer.from(encryptedObj.tag, 'hex');
  const key = deriveKey(password, salt, params);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  let decrypted = decipher.update(encryptedObj.encryptedText, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

function usesCurrentKdf(wallet) {
  const k = wallet.kdf;
  return Boolean(k && k.algo === KDF.algo && k.hash === KDF.hash && k.iterations >= KDF.iterations);
}

// --- API del Storage ---

function listWalletsPublic() {
  const wallets = readRawWallets();
  return wallets.map(w => ({
    id: w.id,
    name: w.name,
    address: w.address,
    type: w.type,
    xpub: w.xpub,
    receiveIndex: w.receiveIndex,
    changeIndex: w.changeIndex
  }));
}

function saveWallet({ name, address, type, secret, password, xpub = null }) {
  const wallets = readRawWallets();

  let finalXpub = xpub;
  if ((type === 'mnemonic' || type === 'hex_hd') && !finalXpub) {
    const wallet = require('./wallet');
    finalXpub = type === 'mnemonic'
      ? wallet.getXPubFromMnemonic(secret)
      : wallet.getXPubFromHexHd(secret);
  }

  // Evitar duplicados por dirección (o xpub)
  if (wallets.some(w => w.address === address || (finalXpub && w.xpub === finalXpub))) {
    throw new Error('Esta billetera ya está guardada.');
  }

  const encrypted = encrypt(secret, password);
  const newWallet = {
    id: crypto.randomUUID(),
    name: name || `Wallet ${wallets.length + 1}`,
    address,
    type,
    xpub: finalXpub,
    receiveIndex: (type === 'mnemonic' || type === 'hex_hd') ? 0 : undefined,
    changeIndex: (type === 'mnemonic' || type === 'hex_hd') ? 0 : undefined,
    salt: encrypted.salt,
    iv: encrypted.iv,
    tag: encrypted.tag,
    encryptedText: encrypted.encryptedText,
    kdf: encrypted.kdf
  };

  wallets.push(newWallet);
  writeRawWallets(wallets);
  return listWalletsPublic();
}

function deleteWallet(id) {
  let wallets = readRawWallets();
  wallets = wallets.filter(w => w.id !== id);
  writeRawWallets(wallets);
  return listWalletsPublic();
}

function updateWallet(id, updates) {
  const wallets = readRawWallets();
  const index = wallets.findIndex(w => w.id === id);
  if (index === -1) throw new Error('Billetera no encontrada para actualizar.');
  wallets[index] = { ...wallets[index], ...updates };
  writeRawWallets(wallets);
  return listWalletsPublic();
}

function getDecryptedSecret(id, password) {
  const wallets = readRawWallets();
  const wallet = wallets.find(w => w.id === id);
  if (!wallet) {
    throw new Error('Billetera no encontrada.');
  }

  let secret;
  try {
    secret = decrypt(wallet, password);
  } catch (e) {
    // GCM falla igual con contraseña incorrecta que con registro corrupto.
    // Distinguimos por los campos: si falta alguno, el registro esta roto.
    if (!wallet.salt || !wallet.iv || !wallet.tag || !wallet.encryptedText) {
      throw new Error('El registro de esta billetera esta incompleto o danado.');
    }
    throw new Error('Contraseña incorrecta.');
  }

  // Migracion transparente: si la wallet quedo con parametros viejos, la
  // reciframos con los actuales ahora que tenemos secreto y contraseña.
  if (!usesCurrentKdf(wallet)) {
    try {
      const re = encrypt(secret, password);
      updateWallet(id, {
        salt: re.salt, iv: re.iv, tag: re.tag,
        encryptedText: re.encryptedText, kdf: re.kdf
      });
    } catch (e) {
      // Migrar es una mejora, no una obligacion: nunca romper la operacion.
      console.error('No se pudo migrar el KDF de la billetera:', e.message);
    }
  }

  return secret;
}

module.exports = {
  listWalletsPublic,
  saveWallet,
  deleteWallet,
  updateWallet,
  getDecryptedSecret,
  filePath: FILE_PATH, // Para testeo y depuración
  KDF,
};
