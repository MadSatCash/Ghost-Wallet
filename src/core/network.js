// Capa de red: consulta saldos a servidores Fulcrum (Electrum) de BCH.
//
// NO descarga la blockchain: le pregunta directo al servidor el saldo de una
// direccion -> por eso la carga es rapida (1-2 segundos). Mantiene UNA conexion
// abierta y la reutiliza, asi las consultas siguientes son instantaneas.

// Servidores publicos de respaldo: si uno falla, prueba el siguiente.
const SERVERS = [
  { host: 'bch.imaginary.cash', port: 50004 },
  { host: 'fulcrum.fountainhead.cash', port: 50004 },
  { host: 'bch.loping.net', port: 50004 },
  { host: 'blackie.c3-soft.com', port: 50004 },
  { host: 'electrum.imaginary.cash', port: 50004 },
];

// Parche mágico para forzar a que WebSockets pase por Tor
let _useTor = false;
let _torPort = 9050;

const Module = require('module');
const originalRequire = Module.prototype.require;
Module.prototype.require = function(request) {
  if (request === 'ws') {
    const ws = originalRequire.call(this, request);
    class ProxyWS extends ws {
      constructor(url, protocols, options) {
        if (!_useTor) {
          throw new Error("FAIL-CLOSED: Intentando realizar una conexión directa a Internet cuando Tor está desactivado. Bloqueado por política de privacidad extrema.");
        }
        const { SocksProxyAgent } = originalRequire.call(module, 'socks-proxy-agent');
        // socks5h fuerza la resolución de DNS remota (evita DNS leaks)
        const agent = new SocksProxyAgent(`socks5h://127.0.0.1:${_torPort}`);
        super(url, protocols, { ...options, agent });
      }
    }
    return ProxyWS;
  }
  return originalRequire.call(this, request);
};

let _libauth = null;
async function lib() {
  if (!_libauth) _libauth = await import('@bitauth/libauth');
  return _libauth;
}

let _client = null;
let _connecting = null;
let _serverName = null;

function setUseTor(enabled) {
  _useTor = enabled;
}

function setTorPort(port) {
  _torPort = port;
}

function isTorEnabled() {
  return _useTor;
}

async function getClient() {
  if (_client) return _client;
  if (_connecting) return _connecting;
  _connecting = (async () => {
    const { ElectrumClient } = await import('@electrum-cash/network');
    let lastErr;
    for (const { host, port } of SERVERS) {
      try {
        const c = new ElectrumClient('BCHWallet', '1.4.1', host, { port, timeout: 8000 });
        await c.connect();
        _client = c;
        _serverName = host;
        return c;
      } catch (e) {
        lastErr = e;
      }
    }
    throw new Error('No pude conectar a ningun servidor BCH. ' + (lastErr && lastErr.message ? lastErr.message : ''));
  })();
  try {
    return await _connecting;
  } finally {
    _connecting = null;
  }
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
async function getBalance(address) {
  const c = await getClient();
  const sh = await addressToScripthash(address);
  const res = await c.request('blockchain.scripthash.get_balance', sh);
  if (res instanceof Error) throw res;
  return { confirmed: res.confirmed || 0, unconfirmed: res.unconfirmed || 0 };
}

// Obtiene los UTXOs (fondos gastables) de una dirección.
async function getUtxos(address) {
  const c = await getClient();
  const sh = await addressToScripthash(address);
  const res = await c.request('blockchain.scripthash.listunspent', sh);
  if (res instanceof Error) throw res;
  return res;
}

// Transmite una transacción firmada (en formato hex) a la red.
async function broadcastTransaction(rawTxHex) {
  const c = await getClient();
  const res = await c.request('blockchain.transaction.broadcast', rawTxHex);
  if (res instanceof Error) throw res;
  return res;
}

function satsToBch(sats) {
  return sats / 1e8;
}

// Formatea satoshis como texto en BCH (sin ceros sobrantes).
function formatBch(sats) {
  const bch = satsToBch(sats);
  return bch.toFixed(8).replace(/\.?0+$/, '') + ' BCH';
}

function serverName() {
  return _serverName;
}

// Desconectar completamente: cerrar el WebSocket, anular el cliente,
// y cancelar cualquier intento de conexión en curso.
function disconnect() {
  if (_client) {
    try { _client.disconnect(); } catch { /* noop */ }
    _client = null;
    _serverName = null;
  }
  // Si hay una conexión en progreso, la descartamos.
  // La Promise de getClient() puede rechazar, pero los callers
  // ya manejan errores de red.
  _connecting = null;
}

// Obtener historial basico de una direccion.
async function getHistory(address) {
  const c = await getClient();
  const sh = await addressToScripthash(address);
  const res = await c.request('blockchain.scripthash.get_history', sh);
  if (res instanceof Error) throw res;
  return res;
}

// Obtener transaccion completa.
async function getTransaction(txid) {
  const c = await getClient();
  const res = await c.request('blockchain.transaction.get', txid, true);
  if (res instanceof Error) throw res;
  return res;
}

module.exports = {
  SERVERS,
  getBalance,
  getUtxos,
  broadcastTransaction,
  addressToScripthash,
  satsToBch,
  formatBch,
  serverName,
  disconnect,
  getHistory,
  getTransaction,
  setUseTor,
  setTorPort,
  isTorEnabled
};
