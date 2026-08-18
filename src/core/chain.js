// Cadena de cabeceras verificada por proof-of-work.
//
// Por que existe: el resto de la wallet le pregunta cosas a servidores
// Electrum. consensus.js compara varias respuestas para que un servidor solo no
// pueda mentir, pero eso sigue siendo una votacion — si los operadores se
// coordinan, la votacion no vale.
//
// Esto es lo unico que no es una votacion. Una cabecera de bloque valida cuesta
// trabajo real: hay que minarla. Verificando que cada cabecera encadena con la
// anterior, que cumple su proof-of-work, y que su dificultad es exactamente la
// que ASERT exige, la wallet deja de preguntar cual es la cadena real y pasa a
// comprobarla.
//
// Tres cosas se verifican por cabecera:
//
//   1. Encadenamiento — el campo prev_hash apunta al hash de la anterior.
//   2. Proof-of-work  — el hash de la cabecera cumple el target que declara.
//   3. ASERT          — el target declarado es el que corresponde.
//
// La 3 no es opcional. Sin ella un atacante declara la dificultad que quiera y
// la 2 pasa igual: minar a dificultad 1 lo hace cualquier notebook.

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

// ============================================================
// Constantes de consenso de BCH
// ============================================================

// Ancla del algoritmo de dificultad ASERT (aserti3-2d), activo desde el
// 15-nov-2020. Estos tres valores definen toda la curva de dificultad
// posterior. Verificados contra la cadena real por tools/make-checkpoint.mjs.
const ASERT_ANCHOR = {
  height: 661647,
  bits: 0x1804dafe,
  parentTime: 1605447844,   // timestamp del bloque 661646
};

const HALFLIFE = 172800n;    // 2 dias
const IDEAL_SPACING = 600n;  // 10 minutos
const POW_LIMIT = 0x00000000FFFF0000000000000000000000000000000000000000000000000000n;

const HEADER_SIZE = 80;

// Checkpoint: altura y hash de un bloque que ya fue verificado desde el ancla.
//
// No es una optimizacion, es lo que ancla la ALTURA. ASERT sola no alcanza:
// un atacante puede tomar el ancla real de 2020 y minar el bloque siguiente con
// timestamp de hoy; la formula lee "pasaron 5,7 años y un solo bloque, la red
// viene lentisima", desploma la dificultad al piso, y desde ahi fabrica la
// cadena que quiera gratis. El checkpoint corta eso porque llega por un canal
// que los servidores no controlan: este archivo, que viene de tu repo.
//
// Envejecer no lo rompe. Un checkpoint viejo solo hace bajar mas cabeceras —
// con los 6 operadores repartiendose el trabajo, la cadena entera desde 2020
// tarda menos de un minuto. Se puede dejar años sin tocar.
//
// Para regenerarlo:  node tools/make-checkpoint.mjs
const CHECKPOINT = {
  height: 960000,
  hash: '000000000000000002559a63f4975fb3c2203ca1e4f24725bb71d6cb3fcd29ae',
};
// Bloque del 2026-07-17. Verificado desde el ancla ASERT recorriendo
// 298355 cabeceras con proof-of-work y dificultad validados.

// ============================================================
// Lectura de cabeceras (80 bytes, campos little-endian)
// ============================================================

function sha256d(buf) {
  return crypto.createHash('sha256').update(
    crypto.createHash('sha256').update(buf).digest()
  ).digest();
}

function headerHash(header) {
  return Buffer.from(sha256d(header)).reverse().toString('hex');
}

function headerPrevHash(header) {
  return Buffer.from(header.subarray(4, 36)).reverse().toString('hex');
}

function headerMerkleRoot(header) {
  return Buffer.from(header.subarray(36, 68)).reverse().toString('hex');
}

function headerTime(header) {
  return header.readUInt32LE(68);
}

function headerBits(header) {
  return header.readUInt32LE(72);
}

// ============================================================
// Dificultad: formato compacto <-> target de 256 bits
// ============================================================

// El campo `bits` empaqueta un numero de 256 bits en 4 bytes: un exponente y
// una mantisa de 3 bytes.
function bitsToTarget(bits) {
  const exponent = bits >>> 24;
  const mantissa = BigInt(bits & 0x007fffff);
  return exponent <= 3
    ? mantissa >> BigInt(8 * (3 - exponent))
    : mantissa << BigInt(8 * (exponent - 3));
}

function targetToBits(target) {
  if (target === 0n) return 0;
  let size = 0;
  for (let rest = target; rest > 0n; rest >>= 8n) size++;

  let compact = size <= 3
    ? Number(target << BigInt(8 * (3 - size)))
    : Number(target >> BigInt(8 * (size - 3)));

  // El bit alto de la mantisa significaria signo negativo: se corre un byte.
  if (compact & 0x00800000) {
    compact >>= 8;
    size++;
  }
  return (compact | (size << 24)) >>> 0;
}

// ============================================================
// ASERT (aserti3-2d)
// ============================================================

// target = target_ancla · 2^((tiempo_transcurrido − 600·(bloques+1)) / 2_dias)
//
// La exponenciacion va con enteros: la parte entera del exponente son
// corrimientos de bits, y la fraccionaria sale de una aproximacion cubica.
// Portado de la implementacion de referencia de Bitcoin Cash Node.
//
// OJO con el desfase de un bloque: la dificultad del bloque N se calcula con el
// timestamp y la altura de su PADRE, no con los propios. Equivocarse ahi da una
// curva entera corrida en uno, que valida mal sin hacer ruido.
function calculateASERT(anchorTarget, timeDiff, heightDiff) {
  let exponent = ((timeDiff - IDEAL_SPACING * (heightDiff + 1n)) * 65536n) / HALFLIFE;

  const shifts = exponent >> 16n;
  exponent -= shifts * 65536n;
  // Aca 0 <= exponent < 65536.

  const factor = 65536n + ((195766423245049n * exponent +
                            971821376n * exponent * exponent +
                            5127n * exponent * exponent * exponent +
                            (1n << 47n)) >> 48n);

  let next = anchorTarget * factor;
  next = shifts < 0n ? next >> -shifts : next << shifts;
  next >>= 16n;

  if (next === 0n) return 1n;
  if (next > POW_LIMIT) return POW_LIMIT;
  return next;
}

// Los `bits` que le corresponden al bloque `height`, dado su padre.
function expectedBits(parentHeight, parentTime) {
  const anchorTarget = bitsToTarget(ASERT_ANCHOR.bits);
  const heightDiff = BigInt(parentHeight - ASERT_ANCHOR.height);
  const timeDiff = BigInt(parentTime) - BigInt(ASERT_ANCHOR.parentTime);
  return targetToBits(calculateASERT(anchorTarget, timeDiff, heightDiff));
}

// ============================================================
// Verificacion de un tramo de cabeceras
// ============================================================

// headers: Buffer con N cabeceras de 80 bytes, consecutivas desde `startHeight`.
// previous: la cabecera anterior a la primera (Buffer de 80), o null si
//           `startHeight` es el primer bloque que se verifica.
//
// Devuelve { ok, checked, error }. El primer fallo corta: una cadena rota no se
// verifica "parcialmente", se rechaza.
function verifyHeaders(headers, startHeight, previous) {
  if (headers.length % HEADER_SIZE !== 0) {
    return { ok: false, checked: 0, error: `El lote no es multiplo de ${HEADER_SIZE} bytes.` };
  }
  const count = headers.length / HEADER_SIZE;
  const at = i => headers.subarray(i * HEADER_SIZE, (i + 1) * HEADER_SIZE);

  let prevHeader = previous;
  let prevHash = previous ? headerHash(previous) : null;

  for (let i = 0; i < count; i++) {
    const header = at(i);
    const height = startHeight + i;

    // 1. Encadenamiento.
    if (prevHash !== null && headerPrevHash(header) !== prevHash) {
      return { ok: false, checked: i, error: `La cabecera ${height} no engancha con la anterior.` };
    }

    // 2. Proof-of-work: el hash tiene que caer por debajo del target.
    const bits = headerBits(header);
    const target = bitsToTarget(bits);
    if (target === 0n || target > POW_LIMIT) {
      return { ok: false, checked: i, error: `La cabecera ${height} declara un target fuera de rango.` };
    }
    if (BigInt('0x' + headerHash(header)) > target) {
      return { ok: false, checked: i, error: `La cabecera ${height} no cumple su proof-of-work.` };
    }

    // 3. ASERT: el target declarado tiene que ser el que corresponde.
    //    Solo aplica despues del ancla, y necesita conocer al padre.
    if (height > ASERT_ANCHOR.height && prevHeader) {
      const esperado = expectedBits(height - 1, headerTime(prevHeader));
      if (bits !== esperado) {
        return {
          ok: false,
          checked: i,
          error: `La cabecera ${height} declara dificultad 0x${bits.toString(16)} ` +
                 `pero ASERT exige 0x${esperado.toString(16)}.`,
        };
      }
    }

    prevHeader = header;
    prevHash = headerHash(header);
  }

  return { ok: true, checked: count, error: null };
}

// ============================================================
// Almacen en disco
// ============================================================

let userDataPath;
try {
  const { app } = require('electron');
  userDataPath = app.getPath('userData');
} catch {
  // Carpeta de fallback para entornos de pruebas sin Electron
  userDataPath = path.join(__dirname, '..', '..', 'test_data');
}

const HEADERS_PATH = path.join(userDataPath, 'headers.bin');
const META_PATH = path.join(userDataPath, 'headers.json');

// De donde arranca la cadena guardada. Con checkpoint, desde ahi; sin
// checkpoint, desde el ancla ASERT.
function baseHeight() {
  return CHECKPOINT.hash ? CHECKPOINT.height : ASERT_ANCHOR.height;
}

let _headers = null;    // Buffer con la cadena desde baseHeight()
let _meta = null;       // { baseHeight, count }

function ensureDirectoryExists() {
  const dir = path.dirname(HEADERS_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// Carga lo guardado. Si el archivo no corresponde a las constantes actuales
// (cambio el checkpoint tras un git pull), se descarta y se baja de nuevo: es
// preferible re-sincronizar a verificar contra un ancla que ya no es la nuestra.
function load() {
  if (_headers) return { headers: _headers, meta: _meta };

  try {
    if (fs.existsSync(HEADERS_PATH) && fs.existsSync(META_PATH)) {
      const meta = JSON.parse(fs.readFileSync(META_PATH, 'utf8'));
      const buf = fs.readFileSync(HEADERS_PATH);
      const coincideBase = meta.baseHeight === baseHeight();
      const tamanoCoherente = buf.length === meta.count * HEADER_SIZE;
      if (coincideBase && tamanoCoherente && meta.count > 0) {
        _headers = buf;
        _meta = meta;
        return { headers: _headers, meta: _meta };
      }
    }
  } catch {
    // Archivo corrupto o ilegible: se descarta. No hay nada que perder — las
    // cabeceras son publicas y se vuelven a bajar.
  }

  _headers = Buffer.alloc(0);
  _meta = { baseHeight: baseHeight(), count: 0 };
  return { headers: _headers, meta: _meta };
}

function persist() {
  ensureDirectoryExists();
  const tmpHeaders = HEADERS_PATH + '.tmp';
  fs.writeFileSync(tmpHeaders, _headers);
  fs.renameSync(tmpHeaders, HEADERS_PATH);
  fs.writeFileSync(META_PATH, JSON.stringify(_meta));
}

// Agrega un tramo ya verificado al final de la cadena guardada.
function append(headers, startHeight) {
  load();
  const esperado = _meta.baseHeight + _meta.count;
  if (startHeight !== esperado) {
    throw new Error(`Tramo fuera de lugar: empieza en ${startHeight} y se esperaba ${esperado}.`);
  }
  _headers = Buffer.concat([_headers, headers]);
  _meta = { baseHeight: _meta.baseHeight, count: _meta.count + headers.length / HEADER_SIZE };
  persist();
}

function reset() {
  _headers = Buffer.alloc(0);
  _meta = { baseHeight: baseHeight(), count: 0 };
  try {
    if (fs.existsSync(HEADERS_PATH)) fs.unlinkSync(HEADERS_PATH);
    if (fs.existsSync(META_PATH)) fs.unlinkSync(META_PATH);
  } catch { /* noop */ }
}

// Descarta las ultimas `cuantas` cabeceras. Se usa cuando la punta guardada
// dejo de enganchar con lo que sirve la red: en una reorg, los ultimos bloques
// que teniamos ya no son los de la cadena buena.
function truncate(cuantas) {
  load();
  const quedan = Math.max(0, _meta.count - cuantas);
  _headers = _headers.subarray(0, quedan * HEADER_SIZE);
  _meta = { baseHeight: _meta.baseHeight, count: quedan };
  persist();
  return quedan;
}

// ============================================================
// Consultas sobre la cadena guardada
// ============================================================

function tipHeight() {
  load();
  return _meta.count === 0 ? 0 : _meta.baseHeight + _meta.count - 1;
}

function headerAt(height) {
  load();
  const index = height - _meta.baseHeight;
  if (index < 0 || index >= _meta.count) return null;
  return _headers.subarray(index * HEADER_SIZE, (index + 1) * HEADER_SIZE);
}

// El merkle root de un bloque, tomado de una cabecera que ya paso PoW y ASERT.
// Es el dato contra el que se verifica un merkle proof: si sale de aca, no vino
// de la palabra de un servidor.
function merkleRootAt(height) {
  const header = headerAt(height);
  return header ? headerMerkleRoot(header) : null;
}

function hasHeight(height) {
  return headerAt(height) !== null;
}

function status() {
  load();
  return {
    baseHeight: _meta.baseHeight,
    count: _meta.count,
    tipHeight: tipHeight(),
    hasCheckpoint: Boolean(CHECKPOINT.hash),
    checkpointHeight: CHECKPOINT.height,
    anchorHeight: ASERT_ANCHOR.height,
  };
}

// Valida que la cadena guardada arranque donde dice el checkpoint. Si el primer
// bloque no es el del checkpoint, lo que hay en disco no sirve.
function checkpointMatches() {
  if (!CHECKPOINT.hash) return true;
  const header = headerAt(CHECKPOINT.height);
  return header ? headerHash(header) === CHECKPOINT.hash : false;
}

module.exports = {
  ASERT_ANCHOR,
  CHECKPOINT,
  HEADER_SIZE,
  POW_LIMIT,

  sha256d,
  headerHash,
  headerPrevHash,
  headerMerkleRoot,
  headerTime,
  headerBits,

  bitsToTarget,
  targetToBits,
  calculateASERT,
  expectedBits,
  verifyHeaders,

  baseHeight,
  load,
  append,
  reset,
  truncate,
  tipHeight,
  headerAt,
  merkleRootAt,
  hasHeight,
  status,
  checkpointMatches,
};
