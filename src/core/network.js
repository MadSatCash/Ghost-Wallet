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

const PRICE_CACHE_MS = 5 * 60 * 1000;
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

function hasAnyRequestedPrice(prices, requested) {
  return requested.some(code => Number.isFinite(prices[code]) && prices[code] > 0);
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
  if (!_useTor) throw new Error('Tor is required for network access');

  const requested = normalizeCurrencyCodes(currencies);
  const cacheKey = requested.join(',');
  const force = options && options.force;
  if (!force && _priceCache && _priceCache.cacheKey === cacheKey && Date.now() - _priceCache.updatedAt < PRICE_CACHE_MS) {
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

  // 2: Bitfinex — crypto exchange, usually accessible from Tor
  if (!hasAnyRequestedPrice(prices, requested)) {
    try {
      console.log('[Price] Trying Bitfinex...');
      const json = await torHttpGet('https://api-pub.bitfinex.com/v2/tickers?symbols=tBCHUSD');
      if (Array.isArray(json) && json[0] && json[0].length > 7) {
        mergePrices('Bitfinex', { usd: json[0][7] });
        console.log('[Price] Bitfinex OK: USD =', json[0][7]);
      }
    } catch (e) {
      console.log('[Price] Bitfinex failed:', e.message);
      errors.push('Bitfinex: ' + e.message);
    }
  }

  // 3: CoinGecko — supports many fiat pairs but often CloudFlare-protected
  if (!hasAnyRequestedPrice(prices, requested)) {
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

  // 4: Coinbase
  if (!hasAnyRequestedPrice(prices, requested) && !prices.usd) {
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

  // 5: CoinCap
  if (!hasAnyRequestedPrice(prices, requested) && !prices.usd) {
    try {
      console.log('[Price] Trying CoinCap...');
      const json = await torHttpGet('https://api.coincap.io/v2/assets/bitcoin-cash');
      if (json.data && json.data.priceUsd) mergePrices('CoinCap', { usd: json.data.priceUsd });
      console.log('[Price] CoinCap OK');
    } catch (e) {
      console.log('[Price] CoinCap failed:', e.message);
      errors.push('CoinCap: ' + e.message);
    }
  }

  // FX conversion for non-USD currencies
  const missing = missingRequestedPrices(prices, requested);
  if (prices.usd && missing.some(code => code !== 'usd')) {
    try {
      console.log('[Price] Fetching FX rates for:', missing.join(','));
      const json = await torHttpGet('https://open.er-api.com/v6/latest/USD');
      const rates = json.rates || {};
      const converted = {};
      missing.forEach(code => {
        const rate = rates[code.toUpperCase()];
        if (Number.isFinite(Number(rate)) && Number(rate) > 0) {
          converted[code] = prices.usd * Number(rate);
        }
      });
      mergePrices('USD FX', converted);
      console.log('[Price] FX OK, converted:', Object.keys(converted).join(','));
    } catch (e) {
      console.log('[Price] FX failed:', e.message);
      errors.push('USD FX: ' + e.message);
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
  _priceCache = { cacheKey, updatedAt: Date.now(), payload };
  console.log('[Price] Final:', sources.join(' + '));
  return payload;
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
  isTorEnabled,
  fetchBchPrice,
};
