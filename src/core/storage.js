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

function ensureDirectoryExists() {
  const dir = path.dirname(FILE_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function readRawWallets() {
  ensureDirectoryExists();
  if (!fs.existsSync(FILE_PATH)) {
    return [];
  }
  try {
    const raw = fs.readFileSync(FILE_PATH, 'utf8');
    return JSON.parse(raw) || [];
  } catch (e) {
    console.error('Error leyendo el archivo de billeteras:', e);
    return [];
  }
}

function writeRawWallets(wallets) {
  ensureDirectoryExists();
  try {
    fs.writeFileSync(FILE_PATH, JSON.stringify(wallets, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('Error escribiendo el archivo de billeteras:', e);
    return false;
  }
}

// Encriptación AES-256-GCM
function encrypt(text, password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  return {
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
    encryptedText: encrypted
  };
}

// Desencriptación AES-256-GCM
function decrypt(encryptedObj, password) {
  const salt = Buffer.from(encryptedObj.salt, 'hex');
  const iv = Buffer.from(encryptedObj.iv, 'hex');
  const tag = Buffer.from(encryptedObj.tag, 'hex');
  const key = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  let decrypted = decipher.update(encryptedObj.encryptedText, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
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
  if (type === 'mnemonic' && !finalXpub) {
    const wallet = require('./wallet');
    finalXpub = wallet.getXPubFromMnemonic(secret);
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
    receiveIndex: type === 'mnemonic' ? 0 : undefined,
    changeIndex: type === 'mnemonic' ? 0 : undefined,
    salt: encrypted.salt,
    iv: encrypted.iv,
    tag: encrypted.tag,
    encryptedText: encrypted.encryptedText
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
  try {
    return decrypt(wallet, password);
  } catch (e) {
    throw new Error('Contraseña incorrecta.');
  }
}

module.exports = {
  listWalletsPublic,
  saveWallet,
  deleteWallet,
  updateWallet,
  getDecryptedSecret,
  filePath: FILE_PATH, // Para testeo y depuración
};
