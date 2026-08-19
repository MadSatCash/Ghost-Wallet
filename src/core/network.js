// Capa de red: consulta saldos a servidores Fulcrum (Electrum) de BCH.
//
// NO descarga la blockchain: le pregunta directo al servidor el saldo de una
// direccion -> por eso la carga es rapida (1-2 segundos).
//
// Mantiene VARIAS conexiones abiertas, una por operador independiente, y las
// reutiliza. Cada lectura de dinero va a todas y las respuestas se comparan
// entre si (ver consensus.js): un solo servidor puede mentirte el saldo sin que
// la wallet tenga como notarlo, varios operadores distintos tendrian que
// ponerse de acuerdo para lograr lo mismo.

const consensus = require('./consensus');

// Servidores Fulcrum publicos, verificados con tools/probe-servers.mjs.
//
// El campo `operator` es el que importa: el quorum cuenta DUEÑOS, no hostnames.
// bch.imaginary.cash y electrum.imaginary.cash son la misma persona, asi que
// entre los dos suman un voto, no dos.
//
// Si alguno deja de responder, correr `node tools/probe-servers.mjs` y editar
// esta lista con lo que salga. No agregar hosts sin probarlos.
const SERVERS = [
  { host: 'bch.imaginary.cash',      port: 50004, operator: 'imaginary.cash' },
  { host: 'electrum.imaginary.cash', port: 50004, operator: 'imaginary.cash' },
  { host: 'bch.loping.net',          port: 50004, operator: 'loping.net' },
  { host: 'bch.soul-dev.com',        port: 50004, operator: 'soul-dev.com' },
  { host: 'fulcrum.jettscythe.xyz',  port: 50004, operator: 'jettscythe.xyz' },
  { host: 'cashnode.bch.ninja',      port: 50004, operator: 'bch.ninja' },
  { host: 'fulcrum.criptolayer.net', port: 50004, operator: 'criptolayer.net' },
];

// Cuantos operadores distintos consultar en cada lectura. Tres da margen para
// que uno se caiga y todavia queden dos coincidiendo, que es el minimo para
// hablar de verificacion.
const POOL_TARGET = 3;

// Parametros de la descarga de cabeceras, medidos con tools/bench-headers.mjs
// sobre la cadena real por Tor:
//
//   secuencial, 1 servidor        41.8s   1.00x
//   pipeline x8, 1 servidor       14.6s   2.86x   <- el RTT era el cuello
//   repartido en 3, secuencial    11.2s   3.73x   <- y el ancho de banda tambien
//   repartido en 3 + pipeline x4  10.5s   3.99x
//
// Los dos cuellos son independientes y se suman: un circuito Tor da ~200 KB/s
// y no mas, asi que repartir entre operadores agrega circuitos; y como Electrum
// es JSON-RPC con id, se puede mandar el request siguiente sin esperar al
// anterior. Pasado x4 por conexion la ganancia se aplana.
const MAX_HEADERS_PER_REQUEST = 2016;  // tope que acepta Fulcrum
const PIPELINE_DEPTH = 4;

let _useTor = false;
let _torPort = null;

// ============================================================
// Fail-closed
//
// Historia: antes esto se hacia parcheando Module.prototype.require para
// envolver el modulo 'ws'. NO funcionaba: @electrum-cash/network llega a 'ws'
// por imports ESM (web-socket -> isomorphic-ws -> 'ws') y el loader ESM de Node
// no pasa por Module.prototype.require, asi que el parche nunca se disparaba y
// TODO el trafico salia por clearnet, con Tor prendido o apagado.
//
// Ahora hay dos capas, las dos explicitas:
//   1. assertTorReady() en getClient(), unico punto por el que pasan saldo,
//      UTXOs, historial y broadcast.
//   2. El socket se construye con el agente SOCKS pasado a mano, sin depender
//      de ningun detalle interno del cargador de modulos.
// ============================================================
function assertTorReady() {
  if (!_useTor) {
    throw new Error('FAIL-CLOSED: Tor esta desactivado. La wallet no hace conexiones directas a Internet.');
  }
  if (!_torPort) {
    throw new Error('FAIL-CLOSED: Tor todavia no asigno un puerto SOCKS. Espera a que termine de conectar.');
  }
}

let _libauth = null;
async function lib() {
  if (!_libauth) _libauth = await import('@bitauth/libauth');
  return _libauth;
}

// Pool de conexiones vivas, una por operador: [{ operator, host, client, height }].
// Antes habia un solo cliente y todo salia por ahi; ahora cada lectura de dinero
// se le pregunta a varios y se comparan las respuestas.
let _pool = [];
let _connecting = null;

function setUseTor(enabled) {
  _useTor = Boolean(enabled);
  // Apagar Tor cierra la conexion en curso: nunca queda un socket vivo que
  // sobreviva al cambio de modo.
  if (!_useTor) {
    _torPort = null;
    disconnect();
  }
}

function setTorPort(port) {
  _torPort = port || null;
}

function isTorEnabled() {
  return _useTor;
}

function torPort() {
  return _torPort;
}

// Socket de Electrum que sale obligatoriamente por el proxy SOCKS de Tor.
//
// Solo sobrescribimos connect(), que es el unico metodo que construye el
// WebSocket. El resto (write, disconnect, reenvio de eventos) opera sobre
// this.webSocket y se hereda tal cual.
let _TorSocket = null;
async function torSocketClass() {
  if (_TorSocket) return _TorSocket;
  const { ElectrumWebSocket } = await import('@electrum-cash/web-socket');
  // socks-proxy-agent v10 es ESM puro: no se puede require() desde CommonJS.
  const { SocksProxyAgent } = await import('socks-proxy-agent');
  const WebSocket = require('ws');

  _TorSocket = class TorElectrumSocket extends ElectrumWebSocket {
    connect() {
      if (this.webSocket) throw new Error('Ya hay una conexion abierta en este socket.');
      assertTorReady();

      this.disconnectTimer = setTimeout(() => this.disconnectOnTimeout(), this.timeout);
      this.once('connected', this.clearDisconnectTimerOnTimeout);

      // socks5h: la resolucion DNS la hace Tor, no el sistema (evita DNS leaks).
      const agent = new SocksProxyAgent(`socks5h://127.0.0.1:${_torPort}`);
      const scheme = this.encrypted ? 'wss' : 'ws';
      this.webSocket = new WebSocket(`${scheme}://${this.host}:${this.port}`, undefined, { agent });

      this.webSocket.addEventListener('open', this.onConnect.bind(this));
      this.webSocket.addEventListener('error', this.eventForwarders.wsError);
    }
  };
  return _TorSocket;
}

// Conecta a UN operador, probando sus hosts hasta que alguno responda.
// Deja la conexion suscrita a cabeceras: la altura hace falta para comparar
// UTXOs a una altura comun.
async function connectOperator(operator, hosts) {
  const { ElectrumClient } = await import('@electrum-cash/network');
  const TorSocket = await torSocketClass();

  let lastErr;
  for (const { host, port } of hosts) {
    try {
      // Construimos el socket nosotros: asi el puerto y el timeout se
      // respetan de verdad (pasandolos por opciones al cliente se ignoraban).
      const socket = new TorSocket(host, port, true, 8000);
      const client = new ElectrumClient('BCHWallet', '1.4.1', socket);
      await client.connect();

      const entry = { operator, host, client, height: 0 };

      const tip = await client.request('blockchain.headers.subscribe');
      if (tip && !(tip instanceof Error)) entry.height = tip.height || 0;

      // El servidor avisa cada bloque nuevo: mantiene la altura fresca sin
      // pagar un round-trip antes de cada consulta.
      client.on('blockchain.headers.subscribe', (notification) => {
        const payload = Array.isArray(notification) ? notification[0] : notification;
        if (payload && payload.height) entry.height = payload.height;
      });
      await client.subscribe('blockchain.headers.subscribe');

      // Un operador caido tiene que salir del pool, no quedarse contando como
      // testigo mudo: si no, el quorum se cree mas grande de lo que es.
      client.on('disconnected', () => {
        _pool = _pool.filter(e => e !== entry);
      });

      return entry;
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`Operador ${operator} sin hosts disponibles: ${lastErr && lastErr.message}`);
}

// Llena el pool con hasta POOL_TARGET operadores distintos, en paralelo.
// Si alguno no levanta, se sigue con los que si: la wallet degrada avisando,
// no se cuelga esperando al que falta.
// Cuanto esperar antes de volver a intentar completar el pool.
// Sin esto, con solo 2 operadores disponibles cada consulta reintentaria
// conectar al tercero y pagaria el timeout completo, siempre.
const REINTENTO_POOL_MS = 60000;
let _ultimoIntentoPool = 0;

async function getPool(objetivo = POOL_TARGET) {
  if (_pool.length >= objetivo) return _pool;
  if (_connecting) return _connecting;
  // Pool incompleto pero utilizable: seguir con lo que hay hasta que pase el
  // cooldown. Con dos operadores todavia se puede verificar.
  if (objetivo === POOL_TARGET &&
      _pool.length >= consensus.QUORUM_MIN &&
      Date.now() - _ultimoIntentoPool < REINTENTO_POOL_MS) {
    return _pool;
  }
  // Antes de tocar la red, siempre.
  assertTorReady();
  _ultimoIntentoPool = Date.now();

  _connecting = (async () => {
    const byOperator = new Map();
    for (const server of SERVERS) {
      if (!byOperator.has(server.operator)) byOperator.set(server.operator, []);
      byOperator.get(server.operator).push(server);
    }

    const alreadyConnected = new Set(_pool.map(entry => entry.operator));
    const pendientes = [...byOperator.entries()].filter(([operator]) => !alreadyConnected.has(operator));

    // Se intentan TODOS los operadores libres a la vez y se conserva el primer
    // POOL_TARGET que responda: sobre Tor la latencia varia mucho entre
    // circuitos, y elegir por orden fijo castiga siempre a los mismos.
    const intentos = await Promise.allSettled(
      pendientes.map(([operator, hosts]) => connectOperator(operator, hosts))
    );

    for (const intento of intentos) {
      if (intento.status !== 'fulfilled') continue;
      if (_pool.length < objetivo) {
        _pool.push(intento.value);
      } else {
        // Sobrante: cerrarlo en vez de dejar el socket colgado.
        try { intento.value.client.disconnect(); } catch { /* noop */ }
      }
    }

    if (_pool.length === 0) {
      const motivo = intentos.find(i => i.status === 'rejected');
      throw new Error(
        'No pude conectar a ningun servidor BCH por Tor. ' +
        (motivo && motivo.reason && motivo.reason.message ? motivo.reason.message : '')
      );
    }

    return _pool;
  })();

  try {
    return await _connecting;
  } finally {
    _connecting = null;
  }
}

// Un solo cliente, para lo que no necesita consenso (precio, sondeos sueltos).
async function getClient() {
  const pool = await getPool();
  return pool[0].client;
}

// Le hace la misma pregunta a todos los operadores del pool.
// Los que fallan se descartan en silencio: el veredicto ya distingue entre
// "coinciden" y "respondieron pocos".
// Tope de consultas de wallet en vuelo al mismo tiempo.
//
// Por que hace falta: la pantalla principal pide el saldo de TODAS las wallets
// guardadas de una vez, y cada saldo son ~75 direcciones (descubrimiento mas
// saldo). Con 26 wallets HD eso son ~11.700 requests disparados de golpe sobre
// tres circuitos Tor. El canal se tapa solo y las consultas empiezan a vencer
// en masa; lo que llegue despues —por ejemplo la consulta de UTXOs de un
// envio— compite contra esa avalancha y vence tambien. Asi se llego a mostrar
// "No hay fondos suficientes (0 UTXOs)" con la plata intacta en la cadena.
//
// El numero sale de la misma medicion que ordena la descarga de cabeceras: un
// circuito Tor rinde hasta cierto punto y, pasadas PIPELINE_DEPTH requests
// encoladas por conexion, la ganancia se aplana. Cada queryAll manda UNA
// request a cada operador, asi que PIPELINE_DEPTH consultas en vuelo dejan
// exactamente esa profundidad en cada conexion.
//
// Esto no hace mas lenta la carga: el techo lo pone Tor, no la cola. Lo que
// cambia es que la espera se hace ordenada en vez de terminar en timeouts.
const MAX_CONSULTAS_EN_VUELO = PIPELINE_DEPTH;

// Una cola sola no alcanza: pintar la lista de wallets encola cientos de
// consultas, y un envio que llega despues quedaria esperando atras de todas
// ellas. Lo urgente —lo que hace falta para firmar— pasa adelante. Lo que
// alimenta una pantalla puede esperar.
let consultasEnVuelo = 0;
const esperandoCupo = [];

async function conCupo(fn, { urgente = false } = {}) {
  if (consultasEnVuelo >= MAX_CONSULTAS_EN_VUELO) {
    await new Promise(resolve => {
      if (urgente) esperandoCupo.unshift(resolve);
      else esperandoCupo.push(resolve);
    });
  }
  consultasEnVuelo++;
  try {
    return await fn();
  } finally {
    consultasEnVuelo--;
    const siguiente = esperandoCupo.shift();
    if (siguiente) siguiente();
  }
}

// Cuantas consultas hay en vuelo y cuantas esperando. Para diagnostico.
function estadoDeCola() {
  return { enVuelo: consultasEnVuelo, esperando: esperandoCupo.length, tope: MAX_CONSULTAS_EN_VUELO };
}

async function queryAll(method, ...params) {
  return queryAllCon({}, method, ...params);
}

async function queryAllCon(opciones, method, ...params) {
  const pool = await getPool();
  return conCupo(async () => {
    const respuestas = await Promise.allSettled(
      pool.map(async (entry) => {
        const res = await entry.client.request(method, ...params);
        if (res instanceof Error) throw res;
        return { operator: entry.operator, host: entry.host, height: entry.height, value: res };
      })
    );
    return respuestas.filter(r => r.status === 'fulfilled').map(r => r.value);
  }, opciones);
}

// Consulta con consenso y un reintento.
//
// El reintento no es por errores de red: es por desfase de altura. Dos
// servidores pueden discrepar un instante porque uno ya proceso el bloque nuevo
// y el otro no. Esperar un momento y volver a preguntar los pone de acuerdo.
// Si la diferencia sobrevive al reintento, ya no es desfase.
async function queryWithConsensus(method, params, resolver, opciones = {}) {
  let verdict = resolver(await queryAllCon(opciones, method, ...params));
  if (!verdict.verified && verdict.reason === 'discrepancia') {
    await new Promise(resolve => setTimeout(resolve, 1500));
    verdict = resolver(await queryAllCon(opciones, method, ...params));
  }
  return verdict;
}

// Direccion CashAddr -> scripthash (lo que entiende el protocolo Electrum).
async function addressToScripthash(address) {
  const L = await lib();
  const res = L.cashAddressToLockingBytecode(address);
  if (typeof res === 'string') throw new Error('Direccion invalida: ' + res);
  const hash = L.sha256.hash(res.bytecode);
  return L.binToHex(hash.slice().reverse());
}

// Saldo de una direccion, en satoshis (confirmado y sin confirmar).
//
// No lanza si falta consenso: devuelve el dato mas conservador y lo marca en
// `verification` para que la UI pueda avisar. Un saldo dudoso mostrado con
// advertencia es mas util que una pantalla en blanco — y para gastar esa plata
// hay que pasar por getUtxos(), que si es estricto.
async function getBalance(address) {
  const sh = await addressToScripthash(address);
  const verdict = await queryWithConsensus(
    'blockchain.scripthash.get_balance', [sh], consensus.resolveBalance
  );

  if (!verdict.value) {
    throw new Error('No pude consultar el saldo: ' + consensus.describeVerdict(verdict));
  }

  return {
    confirmed: verdict.value.confirmed,
    unconfirmed: verdict.value.unconfirmed,
    verification: {
      verified: verdict.verified,
      agreedBy: verdict.agreedBy,
      dissentBy: verdict.dissentBy,
      detail: consensus.describeVerdict(verdict),
    },
  };
}

// Obtiene los UTXOs (fondos gastables) de una direccion.
//
// Aca SI es fail-closed. Estos son los datos con los que se firma: si los
// servidores no coinciden sobre que monedas existen, firmar es apostar. Un
// error explicito es mejor que una transaccion armada sobre datos en disputa.
async function getUtxos(address) {
  const sh = await addressToScripthash(address);
  // Urgente: esto es lo que se consulta para firmar. Si espera atras de la
  // tanda de saldos que pinta la pantalla principal, vence, y un envio
  // perfectamente valido termina en "no hay fondos".
  const verdict = await queryWithConsensus(
    'blockchain.scripthash.listunspent', [sh], consensus.resolveUtxos, { urgente: true }
  );

  if (!verdict.verified) {
    const err = new Error(
      'Los servidores no coinciden sobre los fondos de ' + address + '. ' +
      consensus.describeVerdict(verdict) +
      ' No se firma nada hasta que coincidan.'
    );
    // Marca para que el caller no lo confunda con un timeout: un fallo de red
    // se reintenta, una discrepancia hay que mostrarsela al usuario tal cual.
    err.consensusFailure = true;
    err.verdict = verdict;
    throw err;
  }

  return verdict.value;
}

// Transmite una transaccion firmada (en formato hex) a la red.
//
// Va a TODOS los operadores del pool, no a uno: si el primero decide no
// propagarla, la tx igual entra por los otros. Alcanza con que uno la acepte.
async function broadcastTransaction(rawTxHex) {
  const pool = await getPool();
  const intentos = await Promise.allSettled(
    pool.map(entry => entry.client.request('blockchain.transaction.broadcast', rawTxHex)
      .then((res) => {
        if (res instanceof Error) throw res;
        return { operator: entry.operator, txid: res };
      }))
  );

  const aceptaron = intentos.filter(i => i.status === 'fulfilled').map(i => i.value);
  if (aceptaron.length === 0) {
    const motivos = intentos
      .map(i => i.reason && i.reason.message ? i.reason.message : String(i.reason))
      .filter(Boolean);
    throw new Error('Ningun servidor acepto la transaccion. ' + motivos.join(' | '));
  }

  console.log(`[Broadcast] Aceptada por ${aceptaron.length}/${pool.length}: ` +
    aceptaron.map(a => a.operator).join(', '));
  return aceptaron[0].txid;
}

function satsToBch(sats) {
  return sats / 1e8;
}

// Formatea satoshis como texto en BCH (sin ceros sobrantes).
function formatBch(sats) {
  const bch = satsToBch(sats);
  return bch.toFixed(8).replace(/\.?0+$/, '') + ' BCH';
}

// Nombre para mostrar: cuantos operadores hay verificando, no un hostname.
function serverName() {
  if (_pool.length === 0) return null;
  if (_pool.length === 1) return _pool[0].host + ' (sin verificar)';
  return `${_pool.length} operadores: ` + _pool.map(entry => entry.operator).join(', ');
}

// Estado del pool, para que la UI pueda mostrar quien esta respondiendo.
function poolStatus() {
  return {
    connected: _pool.length,
    target: POOL_TARGET,
    quorumMin: consensus.QUORUM_MIN,
    operators: _pool.map(entry => ({ operator: entry.operator, host: entry.host, height: entry.height })),
  };
}

// Desconectar completamente: cerrar todos los WebSockets, vaciar el pool,
// y cancelar cualquier intento de conexión en curso.
function disconnect() {
  for (const entry of _pool) {
    try { entry.client.disconnect(); } catch { /* noop */ }
  }
  _pool = [];
  // Si hay una conexión en progreso, la descartamos.
  // La Promise de getPool() puede rechazar, pero los callers
  // ya manejan errores de red.
  _connecting = null;
}

// Historial de una direccion. Devuelve el array del grupo que gano el consenso.
//
// No lanza: el historial no mueve plata, y durante el descubrimiento HD lo que
// se pregunta es "esta direccion tuvo actividad alguna vez". Para la vista de
// transacciones, usar getHistoryVerified() que ademas devuelve el veredicto.
async function getHistory(address) {
  const { entries } = await getHistoryVerified(address);
  return entries;
}

async function getHistoryVerified(address) {
  const sh = await addressToScripthash(address);
  const verdict = await queryWithConsensus(
    'blockchain.scripthash.get_history', [sh], consensus.resolveHistory
  );

  if (!verdict.value) {
    throw new Error('No pude consultar el historial: ' + consensus.describeVerdict(verdict));
  }

  return {
    entries: verdict.value,
    verification: {
      verified: verdict.verified,
      agreedBy: verdict.agreedBy,
      dissentBy: verdict.dissentBy,
      detail: consensus.describeVerdict(verdict),
    },
  };
}

// Obtener transaccion completa.
async function getTransaction(txid) {
  const c = await getClient();
  const res = await c.request('blockchain.transaction.get', txid, true);
  if (res instanceof Error) throw res;
  return res;
}

// ============================================================
// Cabeceras de bloque
// ============================================================

const TOTAL_OPERADORES = new Set(SERVERS.map(s => s.operator)).size;

// Baja el rango [startHeight, endHeight] inclusive, repartido entre todos los
// operadores disponibles y con varias requests en vuelo por conexion.
//
// Devuelve un Buffer con las cabeceras consecutivas, 80 bytes cada una. NO las
// verifica: de eso se encarga chain.js. Aca solo se traen.
const MAX_INTENTOS_TRAMO = 6;

// Un socket caido responde con esto. Distinto de un timeout: el operador no
// esta lento, ya no esta.
function esErrorDeConexion(e) {
  const msg = String((e && e.message) || e).toLowerCase();
  return msg.includes('disconnect') || msg.includes('not connected') || msg.includes('closed');
}

// Que operadores puede usar la sincronizacion sin pisarle el saldo al usuario.
//
// Una respuesta de 2016 cabeceras son ~320 KB de hex, y sobre Tor eso ocupa el
// socket varios segundos. Si la sync usa las mismas conexiones que las consultas
// de saldo, el descubrimiento HD —que dispara decenas de requests— se queda
// esperando detras y expira. Por eso los primeros POOL_TARGET operadores quedan
// reservados para las consultas y la sync se lleva los demas.
//
// Si no hay operadores de sobra, la sync usa los mismos pero de a uno: tarda
// mas, y esta bien que tarde. Es una tarea de fondo; el saldo no.
function carrilDeSync() {
  if (_pool.length > POOL_TARGET) {
    return { operadores: _pool.slice(POOL_TARGET), dedicado: true };
  }
  return { operadores: _pool, dedicado: false };
}

async function getBlockHeaders(startHeight, endHeight, onProgress) {
  if (endHeight < startHeight) return Buffer.alloc(0);

  // Para bajar conviene todo el ancho de banda disponible: cada operador es un
  // circuito Tor distinto, y uno solo topea a ~200 KB/s.
  await getPool(TOTAL_OPERADORES);

  // Cola compartida en vez de repartir los tramos de antemano. Si un operador
  // se cae a mitad de camino, sus tramos no quedan huerfanos — los levanta
  // cualquier otro. Ademas auto-balancea: el que va mas rapido hace mas.
  const pendientes = [];
  for (let cursor = startHeight; cursor <= endHeight; cursor += MAX_HEADERS_PER_REQUEST) {
    pendientes.push({
      start: cursor,
      count: Math.min(MAX_HEADERS_PER_REQUEST, endHeight - cursor + 1),
      intentos: 0,
    });
  }

  const total = pendientes.length;
  const listos = new Map();
  let siguienteCliente = 0;

  async function trabajador() {
    while (pendientes.length > 0) {
      const tramo = pendientes.shift();
      if (!tramo) return;

      // El carril se relee en cada vuelta: cachear el array era el bug — un
      // operador que se desconectaba seguia recibiendo requests para siempre.
      let vivos = carrilDeSync().operadores;
      if (vivos.length === 0) {
        await getPool();
        vivos = carrilDeSync().operadores;
        if (vivos.length === 0) {
          throw new Error('Se cayeron todos los operadores durante la descarga de cabeceras.');
        }
      }
      const entry = vivos[siguienteCliente++ % vivos.length];

      try {
        const res = await entry.client.request('blockchain.block.headers', tramo.start, tramo.count);
        if (res instanceof Error) throw res;
        listos.set(tramo.start, res.hex);
        if (onProgress) onProgress(listos.size, total);
      } catch (e) {
        if (esErrorDeConexion(e)) {
          // Fuera del pool: no tiene sentido seguir mandandole requests.
          _pool = _pool.filter(x => x !== entry);
          try { entry.client.disconnect(); } catch { /* noop */ }
          // El pool se puede haber vaciado entero — por ejemplo si alguien
          // llamo a disconnect() mientras esto corria. Se le da un respiro y
          // se reconecta en la proxima vuelta en vez de quemar los intentos.
          await new Promise(r => setTimeout(r, 600));
        }
        tramo.intentos++;
        if (tramo.intentos >= MAX_INTENTOS_TRAMO) {
          throw new Error(
            `No pude bajar las cabeceras desde ${tramo.start} tras ${MAX_INTENTOS_TRAMO} intentos. ` +
            String((e && e.message) || e)
          );
        }
        // Vuelve al final de la cola para que lo tome otro operador.
        pendientes.push(tramo);
      }
    }
  }

  // Con carril propio se va a fondo; compartiendo, de a uno para no tapar el
  // canal por el que el usuario consulta su saldo.
  const carril = carrilDeSync();
  const concurrencia = carril.dedicado
    ? Math.max(1, Math.min(total, carril.operadores.length * PIPELINE_DEPTH))
    : 1;
  await Promise.all(Array.from({ length: concurrencia }, trabajador));

  const ordenados = [...listos.entries()].sort((a, b) => a[0] - b[0]);
  return Buffer.from(ordenados.map(([, hex]) => hex).join(''), 'hex');
}

// Altura del tip segun el pool. Se toma la MENOR de las que reportan los
// operadores: sincronizar hasta donde todos llegaron evita pedir un bloque que
// solo uno dice tener.
async function getTipHeight() {
  const pool = await getPool();
  const alturas = pool.map(entry => entry.height).filter(h => h > 0);
  if (alturas.length === 0) throw new Error('Ningun operador reporto la altura de la cadena.');
  return Math.min(...alturas);
}

// Prueba de que una transaccion esta en un bloque. Se pide a UN operador a
// proposito: el proof se verifica solo contra el merkle root de una cabecera ya
// validada por PoW, asi que mentir en el proof no sirve de nada — el calculo no
// llega al root y la verificacion falla.
async function getMerkleProof(txid, height) {
  const c = await getClient();
  const res = await c.request('blockchain.transaction.get_merkle', txid, height);
  if (res instanceof Error) throw res;
  return res;
}

const PRICE_CACHE_MS = 5 * 60 * 1000;
// Si el payload quedo incompleto (alguna moneda pedida sin cotizacion) se
// cachea poco: no tiene sentido dejar cinco minutos un resultado a medias.
const PRICE_CACHE_PARTIAL_MS = 60 * 1000;
let _priceCache = null;

function normalizeCurrencyCodes(currencies) {
  const raw = Array.isArray(currencies) ? currencies : String(currencies || '').split(',');
  const codes = raw.map(code => String(code || '').trim().toLowerCase()).filter(Boolean);
  return Array.from(new Set(codes.length ? codes : ['usd']));
}

function normalizePriceMap(map) {
  const out = {};
  Object.entries(map || {}).forEach(([code, value]) => {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) out[String(code).toLowerCase()] = n;
  });
  return out;
}

function missingRequestedPrices(prices, requested) {
  return requested.filter(code => !Number.isFinite(prices[code]) || prices[code] <= 0);
}

function decodeChunked(raw) {
  let result = '';
  let pos = 0;
  while (pos < raw.length) {
    const lineEnd = raw.indexOf('\r\n', pos);
    if (lineEnd === -1) break;
    const size = parseInt(raw.slice(pos, lineEnd), 16);
    if (!size || isNaN(size)) break;
    result += raw.slice(lineEnd + 2, lineEnd + 2 + size);
    pos = lineEnd + 2 + size + 2;
  }
  return result;
}

// Direct SOCKS5 → TLS → raw HTTP, bypassing socks-proxy-agent entirely.
// socks-proxy-agent + https.get was failing silently in this Electron/Node combo.
async function torHttpGet(urlString) {
  const { SocksClient } = require('socks');
  const tls = require('tls');
  const url = new URL(urlString);
  const hostname = url.hostname;
  const port = parseInt(url.port) || 443;

  const { socket } = await SocksClient.createConnection({
    proxy: { host: '127.0.0.1', port: _torPort, type: 5 },
    command: 'connect',
    destination: { host: hostname, port },
    timeout: 20000,
  });

  const tlsSocket = tls.connect({ socket, servername: hostname });

  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; tlsSocket.destroy(); reject(new Error('Timeout (20s)')); }
    }, 20000);

    function finish(fn, val) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { tlsSocket.destroy(); } catch (_) {}
      fn(val);
    }

    tlsSocket.on('secureConnect', () => {
      const reqPath = url.pathname + (url.search || '');
      tlsSocket.write(
        'GET ' + reqPath + ' HTTP/1.1\r\n' +
        'Host: ' + hostname + '\r\n' +
        'User-Agent: Mozilla/5.0 (Windows NT 10.0; rv:128.0) Gecko/20100101 Firefox/128.0\r\n' +
        'Accept: application/json, text/plain, */*\r\n' +
        'Accept-Encoding: identity\r\n' +
        'Connection: close\r\n\r\n'
      );
    });

    const chunks = [];
    tlsSocket.on('data', chunk => chunks.push(chunk));
    tlsSocket.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        const split = raw.indexOf('\r\n\r\n');
        if (split === -1) { finish(reject, new Error('Malformed HTTP response')); return; }

        const headerBlock = raw.slice(0, split);
        const statusCode = parseInt(headerBlock.split(' ')[1]);
        if (statusCode < 200 || statusCode >= 300) {
          finish(reject, new Error('HTTP ' + statusCode));
          return;
        }

        let body = raw.slice(split + 4);
        if (headerBlock.toLowerCase().includes('transfer-encoding: chunked')) {
          body = decodeChunked(body);
        }

        finish(resolve, JSON.parse(body));
      } catch (e) {
        finish(reject, new Error('Parse: ' + e.message));
      }
    });

    tlsSocket.on('error', err => finish(reject, err));
  });
}

async function fetchBchPrice(currencies, options) {
  assertTorReady();

  const requested = normalizeCurrencyCodes(currencies);
  const cacheKey = requested.join(',');
  const force = options && options.force;
  if (!force && _priceCache && _priceCache.cacheKey === cacheKey && Date.now() - _priceCache.updatedAt < _priceCache.ttl) {
    return _priceCache.payload;
  }

  const errors = [];
  const prices = {};
  const sources = [];

  function mergePrices(source, nextPrices) {
    const clean = normalizePriceMap(nextPrices);
    Object.assign(prices, clean);
    if (Object.keys(clean).length) sources.push(source);
  }

  // 1: Kraken — crypto-native, generally Tor-friendly
  try {
    console.log('[Price] Trying Kraken...');
    const json = await torHttpGet('https://api.kraken.com/0/public/Ticker?pair=BCHUSD,BCHEUR');
    const result = {};
    if (json.result) {
      const usdKey = Object.keys(json.result).find(k => k.includes('USD'));
      const eurKey = Object.keys(json.result).find(k => k.includes('EUR'));
      if (usdKey && json.result[usdKey].c) result.usd = json.result[usdKey].c[0];
      if (eurKey && json.result[eurKey].c) result.eur = json.result[eurKey].c[0];
    }
    mergePrices('Kraken', result);
    console.log('[Price] Kraken OK:', JSON.stringify(result));
  } catch (e) {
    console.log('[Price] Kraken failed:', e.message);
    errors.push('Kraken: ' + e.message);
  }

  // 2: Bitfinex — crypto exchange, usually accessible from Tor. Solo aporta
  // USD: se pide unicamente cuando Kraken no dejo USD sobre la mesa.
  if (!prices.usd) {
    try {
      console.log('[Price] Trying Bitfinex...');
      // El par es tBCHN:USD — tBCHUSD respondia 200 con lista vacia, o sea
      // que este respaldo nunca aportaba nada (verificado con tools/probe-price.mjs).
      const json = await torHttpGet('https://api-pub.bitfinex.com/v2/tickers?symbols=tBCHN:USD');
      if (Array.isArray(json) && json[0] && json[0].length > 7) {
        mergePrices('Bitfinex', { usd: json[0][7] });
        console.log('[Price] Bitfinex OK: USD =', json[0][7]);
      }
    } catch (e) {
      console.log('[Price] Bitfinex failed:', e.message);
      errors.push('Bitfinex: ' + e.message);
    }
  }

  // 3: CoinGecko — el unico que cotiza fiat latam (ARS, BRL, MXN, CLP) de forma
  // directa. Antes se salteaba apenas Kraken traia USD, y entonces esas monedas
  // dependian por completo del paso de FX; ahora se consulta siempre que falte
  // alguna de las pedidas.
  if (missingRequestedPrices(prices, requested).length) {
    try {
      console.log('[Price] Trying CoinGecko...');
      const cgUrl = new URL('https://api.coingecko.com/api/v3/simple/price');
      cgUrl.searchParams.set('ids', 'bitcoin-cash');
      cgUrl.searchParams.set('vs_currencies', requested.join(','));
      const json = await torHttpGet(cgUrl.toString());
      if (json['bitcoin-cash']) mergePrices('CoinGecko', json['bitcoin-cash']);
      console.log('[Price] CoinGecko OK');
    } catch (e) {
      console.log('[Price] CoinGecko failed:', e.message);
      errors.push('CoinGecko: ' + e.message);
    }
  }

  // 4: Coinbase — ultimo recurso para USD, que es la base del paso de FX
  if (!prices.usd) {
    try {
      console.log('[Price] Trying Coinbase...');
      const json = await torHttpGet('https://api.coinbase.com/v2/prices/BCH-USD/spot');
      if (json.data && json.data.amount) mergePrices('Coinbase', { usd: json.data.amount });
      console.log('[Price] Coinbase OK');
    } catch (e) {
      console.log('[Price] Coinbase failed:', e.message);
      errors.push('Coinbase: ' + e.message);
    }
  }

  // 5: Gemini — reemplaza a CoinCap, cuyo dominio dejo de resolver
  if (!prices.usd) {
    try {
      console.log('[Price] Trying Gemini...');
      const json = await torHttpGet('https://api.gemini.com/v1/pubticker/bchusd');
      if (json.last) mergePrices('Gemini', { usd: json.last });
      console.log('[Price] Gemini OK');
    } catch (e) {
      console.log('[Price] Gemini failed:', e.message);
      errors.push('Gemini: ' + e.message);
    }
  }

  // 6: KuCoin — ultimo recurso, cotiza contra USDT (aproxima USD 1:1)
  if (!prices.usd) {
    try {
      console.log('[Price] Trying KuCoin...');
      const json = await torHttpGet('https://api.kucoin.com/api/v1/market/orderbook/level1?symbol=BCH-USDT');
      if (json.data && json.data.price) mergePrices('KuCoin', { usd: json.data.price });
      console.log('[Price] KuCoin OK');
    } catch (e) {
      console.log('[Price] KuCoin failed:', e.message);
      errors.push('KuCoin: ' + e.message);
    }
  }

  // FX conversion for non-USD currencies. Va con respaldo: para las monedas
  // que ningun exchange cotiza (UYU, PYG, BOB, PEN, COP) este paso es el unico
  // camino, y si cae la unica fuente esas monedas se quedan sin precio.
  const FX_SOURCES = [
    {
      name: 'USD FX',
      url: 'https://open.er-api.com/v6/latest/USD',
      rates: (json) => json.rates || {},
    },
    {
      name: 'USD FX (respaldo)',
      url: 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json',
      rates: (json) => {
        const out = {};
        Object.entries((json && json.usd) || {}).forEach(([code, rate]) => {
          out[String(code).toUpperCase()] = rate;
        });
        return out;
      },
    },
  ];

  if (prices.usd) {
    for (const fx of FX_SOURCES) {
      const missing = missingRequestedPrices(prices, requested).filter(code => code !== 'usd');
      if (!missing.length) break;
      try {
        console.log('[Price] Fetching FX rates from', fx.name, 'for:', missing.join(','));
        const json = await torHttpGet(fx.url);
        const rates = fx.rates(json);
        const converted = {};
        missing.forEach(code => {
          const rate = Number(rates[code.toUpperCase()]);
          if (Number.isFinite(rate) && rate > 0) converted[code] = prices.usd * rate;
        });
        mergePrices(fx.name, converted);
        console.log('[Price] FX OK, converted:', Object.keys(converted).join(','));
      } catch (e) {
        console.log('[Price] FX failed:', e.message);
        errors.push(fx.name + ': ' + e.message);
      }
    }
  }

  if (!Object.keys(prices).length) {
    throw new Error('No se pudo obtener la cotizacion BCH. ' + errors.join(' | '));
  }

  const payload = {
    prices,
    requested,
    missing: missingRequestedPrices(prices, requested),
    source: sources.join(' + '),
    updatedAt: Date.now(),
    errors,
  };
  const ttl = payload.missing.length ? PRICE_CACHE_PARTIAL_MS : PRICE_CACHE_MS;
  _priceCache = { cacheKey, updatedAt: Date.now(), ttl, payload };
  console.log('[Price] Final:', sources.join(' + '));
  return payload;
}

module.exports = {
  SERVERS,
  POOL_TARGET,
  getBalance,
  getUtxos,
  broadcastTransaction,
  addressToScripthash,
  satsToBch,
  formatBch,
  serverName,
  poolStatus,
  estadoDeCola,
  disconnect,
  getHistory,
  getHistoryVerified,
  getTransaction,
  getBlockHeaders,
  getTipHeight,
  getMerkleProof,
  setUseTor,
  setTorPort,
  isTorEnabled,
  torPort,
  fetchBchPrice,
};
