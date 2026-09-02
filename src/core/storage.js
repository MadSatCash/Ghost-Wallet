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
// Donde se aparta el archivo de las versiones con una contrasena por billetera.
const LEGACY_PATH = path.join(userDataPath, 'wallets.v1.json');

// Solo el dueño puede leer el archivo. En Windows el modo POSIX es simbolico,
// pero en Linux/macOS evita que otros usuarios locales lean los secretos.
const FILE_MODE = 0o600;

// 3 = el cuerpo cifrado dejo de ser la lista pelada de billeteras y paso a ser
// { wallets, groups }. Un vault de la version 2 se lee igual (ver leerContenido)
// y se reescribe con el formato nuevo en el primer cambio que se guarde.
const VERSION = 3;

// Parametros de derivacion actuales. Se guardan DENTRO del archivo para poder
// subirlos mas adelante sin dejar ilegible un vault ya creado.
const KDF = { algo: 'pbkdf2', hash: 'sha256', iterations: 600000, keyLength: 32 };

// Estado del vault abierto. Vive SOLO en memoria del proceso principal: ni la
// clave ni los secretos descifrados cruzan el puente IPC ni tocan el disco.
let vaultKey = null;
let vaultSalt = null;
let vaultKdf = null;
let wallets = null;
let groups = null;

// Se prende cuando encontramos un archivo de la epoca de una contrasena por
// billetera. La UI lo usa para avisar donde quedaron: si no, esas billeteras
// simplemente desaparecen de la lista y parece que se perdieron.
let legadoApartado = false;

function ensureDirectoryExists() {
  const dir = path.dirname(FILE_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// --- Cifrado AES-256-GCM sobre el archivo entero ---
//
// No se cifra billetera por billetera sino el vault completo: asi los nombres,
// las direcciones y los xpub tampoco quedan legibles en disco. Un archivo
// robado sin la contrasena maestra no dice ni cuantas billeteras hay.

function deriveKey(password, salt, params) {
  return crypto.pbkdf2Sync(password, salt, params.iterations, params.keyLength, params.hash);
}

function encryptWithKey(text, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return {
    iv: iv.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
    encryptedText: encrypted,
  };
}

function decryptWithKey(payload, key) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(payload.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(payload.tag, 'hex'));
  let decrypted = decipher.update(payload.encryptedText, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

// --- Lectura y escritura del archivo ---

// Lee y parsea el envoltorio del vault (todavia cifrado).
//
// IMPORTANTE: un archivo ilegible NO puede convertirse en "no hay vault". Si
// devolvieramos null ante un JSON corrupto, crear un vault nuevo escribiria
// encima y borraria los secretos cifrados para siempre. Ante la duda,
// explotamos: es preferible un error visible a una perdida silenciosa.
function readVaultFile() {
  ensureDirectoryExists();
  // Archivo ausente = instalacion nueva (o el usuario lo borro a proposito).
  // NO se recupera del .bak aca: la escritura atomica nunca deja el principal
  // ausente (el backup se hace con el original todavia en su lugar, y el
  // rename lo reemplaza de una), asi que resucitar del backup solo lograria
  // revivir billeteras que alguien borro adrede.
  if (!fs.existsSync(FILE_PATH)) {
    return null;
  }

  let parsed = null;
  try {
    parsed = parseVault(fs.readFileSync(FILE_PATH, 'utf8'), FILE_PATH);
  } catch (e) {
    // El archivo existe pero no se puede leer. Antes de fallar, probamos el
    // backup: cubre el caso de un corte de luz a mitad de escritura.
    if (fs.existsSync(BAK_PATH)) {
      try {
        parsed = parseVault(fs.readFileSync(BAK_PATH, 'utf8'), BAK_PATH);
        console.warn('wallets.json estaba corrupto; se recupero desde el backup.');
      } catch { /* el backup tampoco sirve */ }
    }
    if (!parsed) {
      throw new Error(
        'El archivo de billeteras esta danado y no se pudo recuperar del backup. ' +
        'NO crees ni importes billeteras nuevas (sobrescribirian lo que queda). ' +
        'Hace una copia de ' + FILE_PATH + ' antes de seguir. Detalle: ' + e.message
      );
    }
  }

  // Formato viejo: una lista plana, con una contrasena distinta por billetera.
  // No se puede migrar sin pedir cada una de esas contrasenas, asi que se
  // aparta INTACTO en vez de pisarlo, y el vault arranca vacio.
  if (Array.isArray(parsed)) {
    apartarVaultLegado();
    return null;
  }

  return parsed;
}

function parseVault(raw, origin) {
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('El contenido de ' + origin + ' no es un vault valido.');
  }
  return parsed;
}

function apartarVaultLegado() {
  const destino = fs.existsSync(LEGACY_PATH) ? LEGACY_PATH + '.' + process.pid : LEGACY_PATH;
  fs.renameSync(FILE_PATH, destino);
  if (fs.existsSync(BAK_PATH)) {
    try { fs.unlinkSync(BAK_PATH); } catch { /* noop */ }
  }
  legadoApartado = true;
  console.warn('Billeteras de la version anterior apartadas en ' + destino + '.');
}

// Escritura atomica: temporal -> fsync -> rename, con backup del estado previo.
// Un corte de luz en cualquier punto deja siempre un archivo integro (el viejo
// o el nuevo), nunca uno a medias.
function writeVaultFile(vault) {
  ensureDirectoryExists();

  const payload = JSON.stringify(vault, null, 2);

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

// --- Cuerpo del vault ---
//
// Los grupos se guardan como entidad propia y no como un simple nombre colgado
// de cada billetera: asi un grupo recien creado, o uno que se quedo sin
// billeteras, sigue existiendo en vez de evaporarse.

function serializarContenido() {
  return JSON.stringify({ wallets, groups });
}

// Acepta los dos formatos: la lista pelada de la version 2 y el objeto actual.
// Un vault viejo NO se reescribe al abrirlo, solo cuando algo cambie: abrir el
// archivo no es motivo suficiente para tocarlo.
function leerContenido(plano) {
  const contenido = JSON.parse(plano);
  if (Array.isArray(contenido)) {
    return { wallets: contenido, groups: [] };
  }
  if (contenido && typeof contenido === 'object' && Array.isArray(contenido.wallets)) {
    return {
      wallets: contenido.wallets,
      groups: Array.isArray(contenido.groups) ? contenido.groups : [],
    };
  }
  throw new Error('El contenido del vault no tiene el formato esperado.');
}

// Una billetera que apunta a un grupo que ya no existe quedaria invisible en la
// pantalla de grupos. Se la manda a "sin grupo" en memoria; se baja a disco
// recien con el proximo cambio.
function descolgarGruposFantasma() {
  const existentes = new Set(groups.map(g => g.id));
  wallets.forEach(w => {
    if (w.groupId && !existentes.has(w.groupId)) w.groupId = null;
  });
}

// Cifra el contenido completo con la clave en memoria y lo baja a disco.
function persistir() {
  const cuerpo = encryptWithKey(serializarContenido(), vaultKey);
  writeVaultFile({
    version: VERSION,
    kdf: { ...vaultKdf },
    salt: vaultSalt.toString('hex'),
    iv: cuerpo.iv,
    tag: cuerpo.tag,
    encryptedText: cuerpo.encryptedText,
  });
}

// --- Contraseña maestra ---

function estaInicializado() {
  return readVaultFile() !== null;
}

function estaDesbloqueado() {
  return vaultKey !== null;
}

function requerirDesbloqueado() {
  if (!estaDesbloqueado()) {
    throw new Error('El vault esta bloqueado.');
  }
}

function estado() {
  return {
    inicializado: estaInicializado(),
    desbloqueado: estaDesbloqueado(),
    legadoApartado,
    legacyPath: LEGACY_PATH,
  };
}

// Crea el vault por primera vez. Falla si ya existe uno: crear encima seria
// borrar todas las billeteras guardadas sin decirlo.
function crearVault(password) {
  validarPassword(password);
  if (estaInicializado()) {
    throw new Error('Ya existe un vault en esta compu.');
  }

  vaultSalt = crypto.randomBytes(16);
  vaultKdf = { ...KDF };
  vaultKey = deriveKey(password, vaultSalt, vaultKdf);
  wallets = [];
  groups = [];
  persistir();
  return true;
}

// Abre el vault con la contrasena maestra. Es la unica vez que la app pide una
// contrasena: a partir de aca la clave queda en memoria hasta que se cierre.
function desbloquear(password) {
  validarPassword(password);
  const archivo = readVaultFile();
  if (!archivo) {
    throw new Error('Todavia no hay un vault en esta compu.');
  }
  if (!archivo.salt || !archivo.iv || !archivo.tag || !archivo.encryptedText) {
    throw new Error('El archivo de billeteras esta incompleto o danado.');
  }

  const params = archivo.kdf || KDF;
  const salt = Buffer.from(archivo.salt, 'hex');
  const key = deriveKey(password, salt, params);

  let plano;
  try {
    plano = decryptWithKey(archivo, key);
  } catch {
    // GCM falla igual con contrasena incorrecta que con archivo manipulado.
    // Lo primero es incomparablemente mas probable, asi que es lo que se dice.
    throw new Error('Contraseña incorrecta.');
  }

  const contenido = leerContenido(plano);

  vaultKey = key;
  vaultSalt = salt;
  vaultKdf = params;
  wallets = contenido.wallets;
  groups = contenido.groups;
  descolgarGruposFantasma();

  migrarKdfSiHaceFalta(password);
  return true;
}

function bloquear() {
  if (vaultKey) vaultKey.fill(0);
  vaultKey = null;
  vaultSalt = null;
  vaultKdf = null;
  wallets = null;
  groups = null;
  return true;
}

function validarPassword(password) {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('La contraseña maestra es obligatoria.');
  }
}

function usaKdfActual() {
  const k = vaultKdf;
  return Boolean(k && k.algo === KDF.algo && k.hash === KDF.hash && k.iterations >= KDF.iterations);
}

// Si el vault quedo con parametros viejos, se rederiva con los actuales ahora
// que tenemos la contrasena. Migrar es una mejora, no una obligacion: si falla,
// el vault sigue abierto con lo que ya tenia.
function migrarKdfSiHaceFalta(password) {
  if (usaKdfActual()) return;
  const saltPrevio = vaultSalt;
  const kdfPrevio = vaultKdf;
  const keyPrevia = vaultKey;
  try {
    vaultSalt = crypto.randomBytes(16);
    vaultKdf = { ...KDF };
    vaultKey = deriveKey(password, vaultSalt, vaultKdf);
    persistir();
    keyPrevia.fill(0);
  } catch (e) {
    vaultSalt = saltPrevio;
    vaultKdf = kdfPrevio;
    vaultKey = keyPrevia;
    console.error('No se pudo migrar el KDF del vault:', e.message);
  }
}

// --- API del Storage ---

// Lo que se le muestra al frontend: todo menos el secreto.
function listWalletsPublic() {
  requerirDesbloqueado();
  return wallets.map(w => ({
    id: w.id,
    name: w.name,
    address: w.address,
    type: w.type,
    xpub: w.xpub,
    groupId: w.groupId || null,
    receiveIndex: w.receiveIndex,
    changeIndex: w.changeIndex
  }));
}

// --- Grupos ---
//
// Un grupo es una carpeta y nada mas: no toca claves ni direcciones, solo dice
// que billeteras se suman juntas en la pantalla de inicio. Borrarlo NUNCA borra
// billeteras.

const GROUP_NAME_MAX = 40;

function normalizarNombreGrupo(name) {
  const limpio = String(name == null ? '' : name).trim().replace(/\s+/g, ' ');
  if (!limpio) {
    throw new Error('El grupo necesita un nombre.');
  }
  if (limpio.length > GROUP_NAME_MAX) {
    throw new Error('El nombre del grupo no puede pasar de ' + GROUP_NAME_MAX + ' caracteres.');
  }
  return limpio;
}

// Dos grupos con el mismo nombre son indistinguibles en pantalla, y mover una
// billetera al equivocado es justo el error que despues cuesta ver.
function exigirNombreLibre(nombre, exceptoId) {
  const chocado = groups.some(g => g.id !== exceptoId && g.name.toLowerCase() === nombre.toLowerCase());
  if (chocado) {
    throw new Error('Ya hay un grupo con ese nombre.');
  }
}

function listGroups() {
  requerirDesbloqueado();
  return groups.map(g => ({ id: g.id, name: g.name }));
}

function createGroup(name) {
  requerirDesbloqueado();
  const nombre = normalizarNombreGrupo(name);
  exigirNombreLibre(nombre, null);
  const grupo = { id: crypto.randomUUID(), name: nombre };
  groups.push(grupo);
  persistir();
  return grupo;
}

function renameGroup(id, name) {
  requerirDesbloqueado();
  const grupo = groups.find(g => g.id === id);
  if (!grupo) {
    throw new Error('Grupo no encontrado.');
  }
  const nombre = normalizarNombreGrupo(name);
  exigirNombreLibre(nombre, id);
  grupo.name = nombre;
  persistir();
  return listGroups();
}

// Borra la carpeta, no lo que hay adentro: las billeteras del grupo quedan sin
// grupo y se siguen viendo en el inicio.
function deleteGroup(id) {
  requerirDesbloqueado();
  if (!groups.some(g => g.id === id)) {
    throw new Error('Grupo no encontrado.');
  }
  groups = groups.filter(g => g.id !== id);
  wallets.forEach(w => {
    if (w.groupId === id) w.groupId = null;
  });
  persistir();
  return listGroups();
}

// groupId null saca la billetera de cualquier grupo.
function assignWalletGroup(walletId, groupId) {
  requerirDesbloqueado();
  const wallet = wallets.find(w => w.id === walletId);
  if (!wallet) {
    throw new Error('Billetera no encontrada.');
  }
  if (groupId != null && !groups.some(g => g.id === groupId)) {
    throw new Error('Grupo no encontrado.');
  }
  wallet.groupId = groupId == null ? null : groupId;
  persistir();
  return listWalletsPublic();
}

function saveWallet({ name, address, type, secret, xpub = null, groupId = null }) {
  requerirDesbloqueado();

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

  if (groupId != null && !groups.some(g => g.id === groupId)) {
    throw new Error('Grupo no encontrado.');
  }

  wallets.push({
    id: crypto.randomUUID(),
    name: name || `Wallet ${wallets.length + 1}`,
    address,
    type,
    xpub: finalXpub,
    groupId: groupId == null ? null : groupId,
    receiveIndex: (type === 'mnemonic' || type === 'hex_hd') ? 0 : undefined,
    changeIndex: (type === 'mnemonic' || type === 'hex_hd') ? 0 : undefined,
    secret,
  });

  persistir();
  return listWalletsPublic();
}

function deleteWallet(id) {
  requerirDesbloqueado();
  wallets = wallets.filter(w => w.id !== id);
  persistir();
  return listWalletsPublic();
}

function updateWallet(id, updates) {
  requerirDesbloqueado();
  const index = wallets.findIndex(w => w.id === id);
  if (index === -1) throw new Error('Billetera no encontrada para actualizar.');
  wallets[index] = { ...wallets[index], ...updates };
  persistir();
  return listWalletsPublic();
}

// La semilla en claro. Con el vault abierto no hace falta ninguna contrasena
// mas: la contrasena maestra del arranque ya autorizo esta sesion.
function getSecret(id) {
  requerirDesbloqueado();
  const wallet = wallets.find(w => w.id === id);
  if (!wallet) {
    throw new Error('Billetera no encontrada.');
  }
  if (typeof wallet.secret !== 'string' || !wallet.secret) {
    throw new Error('El registro de esta billetera esta incompleto o danado.');
  }
  return wallet.secret;
}

module.exports = {
  estado,
  crearVault,
  desbloquear,
  bloquear,
  listWalletsPublic,
  saveWallet,
  deleteWallet,
  updateWallet,
  getSecret,
  listGroups,
  createGroup,
  renameGroup,
  deleteGroup,
  assignWalletGroup,
  GROUP_NAME_MAX,
  filePath: FILE_PATH, // Para testeo y depuración
  legacyPath: LEGACY_PATH,
  KDF,
};
