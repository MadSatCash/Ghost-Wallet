// Sonda de proveedores de precio BCH, por Tor.
//
// Para que sirve: cuando la barra dice "Price unavailable" no se sabe si el
// problema es Tor, el proveedor, o que ese proveedor no cotiza la moneda
// elegida. Esto prueba de verdad cada endpoint que usa src/core/network.js
// (misma tecnica: SOCKS5 -> TLS -> HTTP crudo) y dice cual responde, cuanto
// tarda, y que monedas devuelve realmente.
//
// Se corre con:  node tools/probe-price.mjs
//                node tools/probe-price.mjs ars,brl   (monedas a chequear)
//
// Levanta su propio Tor con un DataDirectory aparte, asi se puede correr con
// la wallet abierta sin pelearse por el lock.

import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import tls from 'node:tls';
import { SocksClient } from 'socks';

const WANTED = (process.argv[2] || 'usd,eur,ars,brl,mxn,clp,cop,pen,uyu,pyg,bob,gbp,jpy,cad,aud')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

const torDir = path.join(os.tmpdir(), 'ghostwallet-probe-tor-price');
const dataDir = path.join(torDir, 'data');

function findTorExe() {
  const roaming = process.env.APPDATA || path.join(os.homedir(), '.config');
  const candidates = [
    path.join(roaming, 'bch-wallet', 'tor-bin', 'tor', 'tor.exe'),
    path.join(roaming, 'bch-wallet', 'tor-bin', 'tor', 'tor'),
    path.join(os.homedir(), '.config', 'bch-wallet', 'tor-bin', 'tor', 'tor'),
    path.join(os.homedir(), 'Library', 'Application Support', 'bch-wallet', 'tor-bin', 'tor', 'tor'),
  ];
  return candidates.find(p => fs.existsSync(p)) || null;
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

let torProcess = null;

async function startTor() {
  const torExe = findTorExe();
  if (!torExe) throw new Error('No encontre tor.exe. Abri la wallet una vez para que lo descargue.');

  fs.mkdirSync(dataDir, { recursive: true });
  if (process.platform !== 'win32') {
    try { fs.chmodSync(torExe, 0o755); } catch { /* noop */ }
  }

  const socksPort = await getFreePort();
  process.stdout.write(`Levantando Tor (SOCKS ${socksPort})`);

  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      stopTor();
      reject(new Error('Tor no llego a Bootstrap 100% en 90s.'));
    }, 90000);

    torProcess = spawn(torExe, [
      '--SocksPort', `127.0.0.1:${socksPort}`,
      '--DataDirectory', dataDir,
      '--ClientOnly', '1',
    ]);

    torProcess.stdout.on('data', (buf) => {
      const line = buf.toString();
      if (/Bootstrapped (\d+)%/.test(line)) process.stdout.write('.');
      if (line.includes('Bootstrapped 100%')) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        console.log(' listo.\n');
        resolve(socksPort);
      }
    });
    torProcess.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });
  });
}

function stopTor() {
  if (torProcess) {
    try { torProcess.kill(); } catch { /* noop */ }
    torProcess = null;
  }
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

// Copia exacta de torHttpGet en src/core/network.js: si la sonda pasa y la
// wallet falla, la diferencia no esta en el transporte.
async function torHttpGet(urlString, socksPort) {
  const url = new URL(urlString);
  const hostname = url.hostname;
  const port = parseInt(url.port) || 443;

  const { socket } = await SocksClient.createConnection({
    proxy: { host: '127.0.0.1', port: socksPort, type: 5 },
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
      try { tlsSocket.destroy(); } catch { /* noop */ }
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
          finish(reject, new Error('HTTP ' + statusCode + ' :: ' + raw.slice(split + 4, split + 160).replace(/\s+/g, ' ').trim()));
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

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Cada proveedor: la URL tal cual la pide la wallet + como extrae los precios.
const PROVIDERS = [
  {
    name: 'Kraken',
    url: () => 'https://api.kraken.com/0/public/Ticker?pair=BCHUSD,BCHEUR',
    parse: (json) => {
      const out = {};
      if (json.result) {
        const usdKey = Object.keys(json.result).find(k => k.includes('USD'));
        const eurKey = Object.keys(json.result).find(k => k.includes('EUR'));
        if (usdKey && json.result[usdKey].c) out.usd = num(json.result[usdKey].c[0]);
        if (eurKey && json.result[eurKey].c) out.eur = num(json.result[eurKey].c[0]);
      }
      return out;
    },
  },
  {
    name: 'Bitfinex',
    url: () => 'https://api-pub.bitfinex.com/v2/tickers?symbols=tBCHUSD',
    parse: (json) => (Array.isArray(json) && json[0] && json[0].length > 7 ? { usd: num(json[0][7]) } : {}),
  },
  {
    name: 'CoinGecko',
    url: () => {
      const u = new URL('https://api.coingecko.com/api/v3/simple/price');
      u.searchParams.set('ids', 'bitcoin-cash');
      u.searchParams.set('vs_currencies', WANTED.join(','));
      return u.toString();
    },
    parse: (json) => json['bitcoin-cash'] || {},
  },
  {
    name: 'Coinbase',
    url: () => 'https://api.coinbase.com/v2/prices/BCH-USD/spot',
    parse: (json) => (json.data && json.data.amount ? { usd: num(json.data.amount) } : {}),
  },
  {
    name: 'CoinCap',
    url: () => 'https://api.coincap.io/v2/assets/bitcoin-cash',
    parse: (json) => (json.data && json.data.priceUsd ? { usd: num(json.data.priceUsd) } : {}),
  },
];

// Candidatos para reemplazar a los que ya no responden. No entran a la wallet
// hasta que esta sonda los apruebe.
const CANDIDATES = [
  {
    name: 'Bitfinex tBCHN:USD',
    url: () => 'https://api-pub.bitfinex.com/v2/tickers?symbols=tBCHN:USD',
    parse: (json) => (Array.isArray(json) && json[0] && json[0].length > 7 ? { usd: num(json[0][7]) } : {}),
  },
  {
    name: 'Bitstamp',
    url: () => 'https://www.bitstamp.net/api/v2/ticker/bchusd/',
    parse: (json) => ({ usd: num(json.last) }),
  },
  {
    name: 'Gemini',
    url: () => 'https://api.gemini.com/v1/pubticker/bchusd',
    parse: (json) => ({ usd: num(json.last) }),
  },
  {
    name: 'KuCoin',
    url: () => 'https://api.kucoin.com/api/v1/market/orderbook/level1?symbol=BCH-USDT',
    parse: (json) => ({ usd: num(json.data && json.data.price) }),
  },
  {
    name: 'Binance',
    url: () => 'https://api.binance.com/api/v3/ticker/price?symbol=BCHUSDT',
    parse: (json) => ({ usd: num(json.price) }),
  },
  {
    name: 'OKX',
    url: () => 'https://www.okx.com/api/v5/market/ticker?instId=BCH-USDT',
    parse: (json) => ({ usd: num(json.data && json.data[0] && json.data[0].last) }),
  },
];

// El paso de FX es el que decide si ARS y el resto de latam llegan a la UI.
const FX = {
  name: 'open.er-api.com (FX)',
  url: () => 'https://open.er-api.com/v6/latest/USD',
  parse: (json) => json.rates || {},
};

// Respaldo de FX: si open.er-api se cae, latam entera queda sin cotizacion.
const FX_ALT = {
  name: 'currency-api (FX alt)',
  url: () => 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json',
  parse: (json) => {
    const out = {};
    Object.entries((json && json.usd) || {}).forEach(([k, v]) => { out[k.toUpperCase()] = v; });
    return out;
  },
};

async function timed(fn) {
  const t0 = process.hrtime.bigint();
  try {
    const value = await fn();
    return { ms: Number(process.hrtime.bigint() - t0) / 1e6, value };
  } catch (e) {
    return { ms: Number(process.hrtime.bigint() - t0) / 1e6, error: e.message };
  }
}

async function main() {
  const socksPort = await startTor();
  const results = [];

  for (const p of PROVIDERS) {
    process.stdout.write(`${p.name.padEnd(22)} `);
    const r = await timed(() => torHttpGet(p.url(), socksPort));
    if (r.error) {
      console.log(`FALLA  ${Math.round(r.ms)}ms  ${r.error}`);
      results.push({ name: p.name, ok: false, error: r.error });
      continue;
    }
    let prices = {};
    try { prices = p.parse(r.value) || {}; } catch { prices = {}; }
    const clean = {};
    Object.entries(prices).forEach(([k, v]) => { const n = num(v); if (n) clean[k.toLowerCase()] = n; });
    const codes = Object.keys(clean);
    console.log(`OK     ${Math.round(r.ms)}ms  ${codes.length ? codes.join(',') : '(sin precios utiles)'}`);
    results.push({ name: p.name, ok: true, prices: clean });
  }

  let rates = {};
  for (const f of [FX, FX_ALT]) {
    process.stdout.write(`${f.name.padEnd(22)} `);
    const fx = await timed(() => torHttpGet(f.url(), socksPort));
    if (fx.error) {
      console.log(`FALLA  ${Math.round(fx.ms)}ms  ${fx.error}`);
      continue;
    }
    const parsed = f.parse(fx.value) || {};
    const faltan = WANTED.filter(c => c !== 'usd' && !num(parsed[c.toUpperCase()]));
    console.log(`OK     ${Math.round(fx.ms)}ms  ${Object.keys(parsed).length} tasas` +
      (faltan.length ? `  -- sin tasa para: ${faltan.join(',')}` : '  -- cubre todas las pedidas'));
    if (!Object.keys(rates).length) rates = parsed;
  }

  console.log('\n--- Candidatos de reemplazo ---');
  for (const c of CANDIDATES) {
    process.stdout.write(`${c.name.padEnd(22)} `);
    const r = await timed(() => torHttpGet(c.url(), socksPort));
    if (r.error) {
      console.log(`FALLA  ${Math.round(r.ms)}ms  ${r.error}`);
      continue;
    }
    let parsed = {};
    try { parsed = c.parse(r.value) || {}; } catch { parsed = {}; }
    const usd = num(parsed.usd);
    console.log(`OK     ${Math.round(r.ms)}ms  ${usd ? 'USD = ' + usd : '(sin precios utiles)'}`);
  }

  // Que veria la UI: primer proveedor con USD + conversion FX.
  const usdProvider = results.find(r => r.ok && r.prices.usd);
  console.log('\n--- Lo que llegaria a la UI ---');
  if (!usdProvider) {
    console.log('Ningun proveedor dio USD: la barra queda en "Price unavailable".');
  } else {
    console.log(`USD desde ${usdProvider.name}: ${usdProvider.prices.usd}`);
    for (const code of WANTED) {
      if (code === 'usd') continue;
      const directo = results.find(r => r.ok && r.prices[code]);
      const rate = num(rates[code.toUpperCase()]);
      if (directo) console.log(`  ${code.toUpperCase().padEnd(4)} ${directo.prices[code].toFixed(2).padStart(16)}  (directo, ${directo.name})`);
      else if (rate) console.log(`  ${code.toUpperCase().padEnd(4)} ${(usdProvider.prices.usd * rate).toFixed(2).padStart(16)}  (FX x${rate})`);
      else console.log(`  ${code.toUpperCase().padEnd(4)} ${'-'.padStart(16)}  SIN COTIZACION -> cae a USD`);
    }
  }

  stopTor();
}

main().catch(e => {
  console.error('\nError:', e.message);
  stopTor();
  process.exit(1);
});
