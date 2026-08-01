// Proceso principal de Electron: crea la ventana y atiende los pedidos
// del frontend (crear / importar wallets). Toda la criptografia corre aca,
// en el proceso principal; el frontend nunca toca las claves directamente.

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const wallet = require('../core/wallet');
const network = require('../core/network');
const storage = require('../core/storage');
const torManager = require('./torManager');

const isHdWallet = (w) => Boolean(w && (w.type === 'mnemonic' || w.type === 'hex_hd'));

// ============================================================
// BIP44 gap-limit address discovery
//
// Cuando se importa una seed desde otra wallet, no sabemos hasta que indice
// derivo. El estandar BIP44 dice: escanear direcciones hasta encontrar
// GAP_LIMIT (20) consecutivas SIN actividad on-chain. Todo antes de esa
// banda vacia forma parte de la wallet. "Actividad" = tiene tx history,
// aunque el saldo actual sea 0: una direccion usada y ya gastada sigue
// contando (BIP44 4.1).
// ============================================================
const GAP_LIMIT = 20;
const DISCOVERY_BATCH_SIZE = 20;
const DISCOVERY_HARD_CAP = 2000;
// Umbral de fallas de red por lote / operacion. Por arriba de esto abortamos
// en vez de reportar "wallet vacia" o "saldo parcial" silenciosamente —
// mostrar saldo subestimado en una billetera es un failure mode peor que
// mostrar un error explicito.
const NETWORK_FAILURE_ABORT_RATIO = 0.5;

// True si la fraccion de fallas justifica abortar la operacion.
function tooManyNetworkFailures(failures, total) {
  return total > 0 && failures * 2 > total;
}

async function discoverHdChain(xpub, branch, startFrom = 0) {
  const discovered = [];
  let cursor = startFrom;
  let consecutiveEmpty = 0;
  let maxIndexWithActivity = -1;
  let stopWalking = false;

  while (!stopWalking && discovered.length < DISCOVERY_HARD_CAP) {
    const batch = wallet.getAddressesFromXPub(xpub, branch, cursor, DISCOVERY_BATCH_SIZE);

    const results = await Promise.all(batch.map(async (a) => {
      try {
        const h = await network.getHistory(a.address);
        return { address: a, historyLength: Array.isArray(h) ? h.length : 0, ok: true };
      } catch (e) {
        return { address: a, historyLength: 0, ok: false };
      }
    }));

    // Si MAYORIA del batch fallo, la red esta caida/inestable: abortar en
    // vez de arriesgar a que un gap "empty" en realidad sean fallos y demos
    // saldo 0 falso a una wallet que tiene fondos.
    const batchFailures = results.filter(r => !r.ok).length;
    if (tooManyNetworkFailures(batchFailures, results.length)) {
      throw new Error('No se pudo consultar la red durante el descubrimiento de direcciones (demasiados fallos en el lote).');
    }

    for (const r of results) {
      discovered.push(r.address);
      if (!r.ok) {
        // Fallo aislado: no lo contamos como vacio (podria haber tenido
        // actividad); tampoco reseteamos el gap. Seguimos.
        continue;
      }
      if (r.historyLength > 0) {
        maxIndexWithActivity = r.address.index;
        consecutiveEmpty = 0;
      } else {
        consecutiveEmpty += 1;
        if (consecutiveEmpty >= GAP_LIMIT) {
          stopWalking = true;
          break;
        }
      }
    }

    cursor += DISCOVERY_BATCH_SIZE;
  }

  if (discovered.length >= DISCOVERY_HARD_CAP && !stopWalking) {
    // Wallet enorme (>2000 direcciones activas por rama) — no llegamos al
    // gap. El saldo reportado puede ser incompleto.
    console.warn(`[discoverHdChain] Hard cap ${DISCOVERY_HARD_CAP} alcanzado en branch ${branch}. El saldo puede estar subestimado.`);
  }

  return { addresses: discovered, maxIndexWithActivity };
}

// Descubre direcciones de ambas ramas y persiste los indices en storage.
async function resolveHdWalletAddresses(w) {
  if (!isHdWallet(w) || !w.xpub) throw new Error('Wallet HD no encontrada');

  const [receiveResult, changeResult] = await Promise.all([
    discoverHdChain(w.xpub, 0, 0),
    discoverHdChain(w.xpub, 1, 0),
  ]);

  const rStart = w.receiveIndex || 0;
  const cStart = w.changeIndex  || 0;
  const newReceiveIndex = Math.max(rStart, receiveResult.maxIndexWithActivity + 1);
  const newChangeIndex  = Math.max(cStart, changeResult.maxIndexWithActivity  + 1);

  if (newReceiveIndex !== rStart || newChangeIndex !== cStart) {
    try {
      storage.updateWallet(w.id, {
        receiveIndex: newReceiveIndex,
        changeIndex: newChangeIndex,
      });
    } catch (e) {
      // Persistir es una optimizacion: no romper la operacion por esto.
      console.error('No se pudo persistir receiveIndex/changeIndex:', e);
    }
  }

  return {
    receiveAddresses: receiveResult.addresses,
    changeAddresses: changeResult.addresses,
    allAddresses: [...receiveResult.addresses, ...changeResult.addresses],
    receiveIndex: newReceiveIndex,
    changeIndex: newChangeIndex,
    maxReceiveActive: receiveResult.maxIndexWithActivity,
    maxChangeActive:  changeResult.maxIndexWithActivity,
  };
}

function createWindow() {
  const win = new BrowserWindow({
    width: 980,
    height: 740,
    minWidth: 820,
    minHeight: 620,
    backgroundColor: '#0e1116',
    title: 'Ghost Wallet',
    icon: path.join(__dirname, process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, // el frontend no comparte contexto con Node
      nodeIntegration: false, // el frontend NO tiene acceso a Node
      sandbox: true,
    },
  });

  win.maximize();
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Seguridad: bloquear navegacion interna pero permitir enlaces web en el navegador externo.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http:') || url.startsWith('https:')) {
      require('electron').shell.openExternal(url);
    }
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith('http:') || url.startsWith('https:')) {
      event.preventDefault();
      require('electron').shell.openExternal(url);
    } else {
      event.preventDefault();
    }
  });
}

app.whenReady().then(() => {
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Desconectar red y matar Tor al salir
app.on('before-quit', () => { 
  network.disconnect(); 
  torManager.stopTor();
});

// Puente seguro frontend <-> nucleo de la wallet.
function registerIpc() {
  // --- Tor ---
  ipcMain.handle('tor:enable', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    await torManager.downloadAndExtractTor((msg) => {
      win.webContents.send('tor:progress', msg);
    });
    await torManager.startTor((msg) => {
      win.webContents.send('tor:progress', msg);
    });
    
    // Configurar el puerto dinámico asignado para el proxy SOCKS
    const socksPort = torManager.getSocksPort();
    network.setTorPort(socksPort);
    network.setUseTor(true);
    network.disconnect(); // force reconnect
    return true;
  });

  ipcMain.handle('tor:disable', () => {
    torManager.stopTor();
    network.setUseTor(false);
    network.disconnect(); // force reconnect
    return true;
  });

  ipcMain.handle('tor:status', () => {
    return { enabled: network.isTorEnabled(), ready: torManager.isReady() };
  });

  ipcMain.handle('tor:isDownloaded', () => {
    return torManager.isTorDownloaded();
  });

  ipcMain.handle('tor:newCircuit', async () => {
    await torManager.newCircuit();
    network.disconnect(); // forzar reconexión por el nuevo circuito
    return true;
  });

  // --- Persistencia ---
  ipcMain.handle('storage:list', () => storage.listWalletsPublic());
  ipcMain.handle('storage:save', (_e, opts) => storage.saveWallet(opts));
  ipcMain.handle('storage:delete', (_e, id) => storage.deleteWallet(id));
  ipcMain.handle('storage:decrypt', (_e, id, password) => storage.getDecryptedSecret(id, password));

  ipcMain.handle('qr:generate', (_e, text) => {
    const qr = require('qrcode-generator');
    const q = qr(0, 'M');
    q.addData(text);
    q.make();
    return q.createSvgTag({ cellSize: 4, margin: 2 });
  });

  ipcMain.handle('wallet:generateMnemonic', (_e, words) => wallet.generateMnemonic(words));
  ipcMain.handle('wallet:generateHexSecret', () => wallet.generateHexSecret());
  ipcMain.handle('wallet:detectInput', (_e, input) => wallet.detectInputType(input));
  ipcMain.handle('wallet:fromMnemonic', (_e, mnemonic, opts) => wallet.addressesFromMnemonic(mnemonic, opts));
  ipcMain.handle('wallet:fromHex', (_e, hex) => wallet.candidatesFromHexSecret(hex));
  ipcMain.handle('wallet:fromHexHd', (_e, hex, opts) => wallet.addressesFromHexHd(hex, opts));

  // --- Red (saldos y precio) ---
  ipcMain.handle('net:getBalance', (_e, address) => network.getBalance(address));
  ipcMain.handle('net:getBchPrice', (_e, currencies, force) => network.fetchBchPrice(currencies, { force }));

  // Importar secreto de 64: calcula las dos direcciones posibles, consulta el
  // saldo de cada una y elige automaticamente la que tenga fondos.
  ipcMain.handle('net:resolveHexSecret', async (_e, hex) => {
    const cands = await wallet.candidatesFromHexSecret(hex);
    const withBalance = [];
    for (const c of cands) {
      try {
        const b = await network.getBalance(c.address);
        withBalance.push({ ...c, confirmed: b.confirmed, unconfirmed: b.unconfirmed });
      } catch (e) {
        withBalance.push({ ...c, confirmed: 0, unconfirmed: 0, error: String(e.message || e) });
      }
    }
    const funded = withBalance.find((c) => c.confirmed + c.unconfirmed > 0);
    const compressed = withBalance.find((c) => c.recipe === 'compressed');
    const chosen = funded || compressed || withBalance[0];
    return { candidates: withBalance, chosenRecipe: chosen.recipe, server: network.serverName() };
  });

  // Consultar balance total de una billetera HD.
  // Usa gap-limit discovery para encontrar TODAS las direcciones con actividad
  // en ambas ramas (receive y change), incluso mas alla del ultimo indice
  // conocido — necesario cuando la seed viene importada de otra wallet.
  ipcMain.handle('wallet:getHdBalance', async (_e, id) => {
    const wallets = storage.listWalletsPublic();
    const w = wallets.find(x => x.id === id);
    if (!w || !w.xpub) throw new Error('Wallet HD no encontrada');

    const resolved = await resolveHdWalletAddresses(w);

    let confirmed = 0;
    let unconfirmed = 0;
    let details = [];
    let failures = 0;

    const results = await Promise.all(resolved.allAddresses.map(async (a) => {
      try {
        const b = await network.getBalance(a.address);
        if (b.confirmed > 0 || b.unconfirmed !== 0) {
          details.push({ ...a, confirmed: b.confirmed, unconfirmed: b.unconfirmed });
        }
        return b;
      } catch (err) {
        failures += 1;
        return { confirmed: 0, unconfirmed: 0 };
      }
    }));

    if (tooManyNetworkFailures(failures, results.length)) {
      throw new Error('Error de red: fallaron demasiadas consultas de saldo (la wallet podria tener fondos no visibles).');
    }

    for (const b of results) {
      confirmed += b.confirmed;
      unconfirmed += b.unconfirmed;
    }

    return {
      confirmed,
      unconfirmed,
      details,
      receiveAddresses: resolved.receiveAddresses,
      server: network.serverName()
    };
  });

  // Suma los saldos de una lista de direcciones. Anota `confirmed`/`unconfirmed`
  // sobre cada address in-place para que el caller pueda mostrarlos.
  async function sumBalances(addresses) {
    let failures = 0;
    const results = await Promise.all(addresses.map(async (a) => {
      try { return await network.getBalance(a.address); }
      catch { failures++; return { confirmed: 0, unconfirmed: 0 }; }
    }));
    let confirmed = 0, unconfirmed = 0;
    results.forEach((b, i) => {
      addresses[i].confirmed = b.confirmed;
      addresses[i].unconfirmed = b.unconfirmed;
      confirmed += b.confirmed;
      unconfirmed += b.unconfirmed;
    });
    return { confirmed, unconfirmed, failures };
  }

  // Reporte de importacion de mnemonic: gap-limit en ambas ramas para no
  // subestimar el saldo (bug corregido — antes usaba SCAN_LIMIT fijo de 20 y
  // perdia saldos en indices altos, sobre todo en change).
  async function hdImportReport(xpub, count) {
    const [receiveDiscovery, changeDiscovery] = await Promise.all([
      discoverHdChain(xpub, 0, 0),
      discoverHdChain(xpub, 1, 0),
    ]);
    const rBal = await sumBalances(receiveDiscovery.addresses);
    const cBal = await sumBalances(changeDiscovery.addresses);

    // Para la UI: primeras `count` de la rama receive. Si el discovery cubrio
    // menos que `count` (posible solo si count > GAP_LIMIT), completar con
    // derivacion pura para no romper la vista.
    let firstAddresses = receiveDiscovery.addresses.slice(0, count);
    if (firstAddresses.length < count) {
      const missing = count - firstAddresses.length;
      const extra = wallet.getAddressesFromXPub(xpub, 0, firstAddresses.length, missing);
      firstAddresses = [...firstAddresses, ...extra];
    }

    return {
      addresses: firstAddresses,
      total: {
        confirmed:   rBal.confirmed   + cBal.confirmed,
        unconfirmed: rBal.unconfirmed + cBal.unconfirmed,
      },
      server: network.serverName(),
    };
  }

  ipcMain.handle('net:mnemonicReport', async (_e, mnemonic, count = 5) => {
    const xpub = wallet.getXPubFromMnemonic(mnemonic);
    return hdImportReport(xpub, count);
  });

  ipcMain.handle('net:hexHdReport', async (_e, secret, count = 5) => {
    const xpub = wallet.getXPubFromHexHd(secret);
    return hdImportReport(xpub, count);
  });

  // Estimar el maximo enviable calculando el fee real segun cantidad de UTXOs.
  // No necesita el password: solo mira los UTXOs. Coincide con la formula
  // usada por buildAndSignTx cuando el change seria dust (send-max).
  ipcMain.handle('wallet:estimateMaxSend', async (_e, id) => {
    const wallets = storage.listWalletsPublic();
    const w = wallets.find(x => x.id === id);
    if (!w) throw new Error('Wallet no encontrada');

    const DUST_LIMIT = 546;
    let utxos = [];
    if (!isHdWallet(w)) {
      const u = await network.getUtxos(w.address);
      if (u) utxos = u;
    } else {
      const resolved = await resolveHdWalletAddresses(w);
      let failures = 0;
      const promises = resolved.allAddresses.map(async (a) => {
        try {
          const u = await network.getUtxos(a.address);
          if (u && u.length > 0) u.forEach(x => utxos.push(x));
        } catch (e) { failures++; }
      });
      await Promise.all(promises);
      if (tooManyNetworkFailures(failures, resolved.allAddresses.length)) {
        throw new Error('Error de red: fallaron demasiadas consultas de UTXOs (el maximo enviable podria estar subestimado).');
      }
    }

    const totalSats = utxos.reduce((s, u) => s + u.value, 0);
    const n = utxos.length;
    const BASE_SIZE = 10;
    const INPUT_SIZE = 149;
    const OUTPUT_SIZE = 34;
    const feeRate = 1;
    const feeSats = n === 0
      ? 0
      : Math.ceil((BASE_SIZE + n * INPUT_SIZE + 1 * OUTPUT_SIZE) * feeRate);
    let maxSats = Math.max(0, totalSats - feeSats);
    if (maxSats < DUST_LIMIT) maxSats = 0;

    return { totalSats, feeSats, maxSats, utxoCount: n };
  });

  // Enviar BCH
  ipcMain.handle('wallet:sendBch', async (_e, id, password, toAddress, amountBch) => {
    const wallets = storage.listWalletsPublic();
    const w = wallets.find(x => x.id === id);
    if (!w) throw new Error('Wallet no encontrada');

    const secret = storage.getDecryptedSecret(id, password);
    let inputs = [];
    let changeAddress;
    // Guardamos aca el proximo changeIndex a persistir tras un envio exitoso.
    // Base = resolved.changeIndex (post-discovery), NO w.changeIndex, que
    // pudo haber quedado desactualizado si la seed viene importada.
    let nextChangeIndexToPersist = null;

    if (!isHdWallet(w)) {
      const u = await network.getUtxos(w.address);
      if (!u || u.length === 0) throw new Error('No hay fondos suficientes (0 UTXOs).');
      u.forEach(x => inputs.push({ ...x, address: w.address, privKeyHex: secret }));
      changeAddress = w.address;
    } else {
      const resolved = await resolveHdWalletAddresses(w);

      let utxoFailures = 0;
      const promises = resolved.allAddresses.map(async (a) => {
        try {
          const u = await network.getUtxos(a.address);
          if (u && u.length > 0) {
            const privKeyHex = w.type === 'hex_hd'
              ? wallet.getPrivateKeyHexForHexHdPath(secret, 0, a.change, a.index)
              : wallet.getPrivateKeyHexForPath(secret, 0, a.change, a.index);
            u.forEach(x => inputs.push({ ...x, address: a.address, privKeyHex }));
          }
        } catch(e) { utxoFailures++; }
      });
      await Promise.all(promises);

      // Chequeo critico: si fallaron demasiados getUtxos, podriamos estar
      // firmando una tx con inputs incompletos (dejando UTXOs "atrapados"
      // en direcciones que no consultamos con exito) o incluso el UTXO
      // grande podria estar ausente. Abortar en vez de mandar una tx menor
      // a lo que el usuario cree que esta enviando.
      if (tooManyNetworkFailures(utxoFailures, resolved.allAddresses.length)) {
        throw new Error('Error de red: fallaron demasiadas consultas de UTXOs. Reintenta antes de enviar para no dejar fondos afuera de la transaccion.');
      }

      if (inputs.length === 0) {
        throw new Error('No hay fondos suficientes (0 UTXOs).');
      }

      // Nueva direccion de change: la primera libre segun lo descubierto.
      const newChangeNode = wallet.getAddressesFromXPub(w.xpub, 1, resolved.changeIndex, 1)[0];
      changeAddress = newChangeNode.address;
      nextChangeIndexToPersist = resolved.changeIndex + 1;
    }

    const amountSats = Math.floor(parseFloat(amountBch) * 1e8);
    const rawTxHex = wallet.buildAndSignTx({
      inputs,
      toAddress,
      changeAddress,
      amountSats,
      feeRate: 1
    });

    const txid = await network.broadcastTransaction(rawTxHex);

    if (isHdWallet(w) && nextChangeIndexToPersist !== null) {
      try {
        storage.updateWallet(w.id, { changeIndex: nextChangeIndexToPersist });
      } catch (e) {
        // La tx ya se broadcasteo con exito; un fallo persistiendo el indice
        // no puede propagarse como error porque el usuario perderia el txid.
        console.error('Tx enviada OK pero fallo persistir changeIndex:', e);
      }
    }

    return txid;
  });

  // Incrementar el indice de recepcion de una HD Wallet
  ipcMain.handle('wallet:incrementReceiveIndex', async (_e, id) => {
    const wallets = storage.listWalletsPublic();
    const w = wallets.find(x => x.id === id);
    if (!isHdWallet(w)) throw new Error('Wallet HD no encontrada');
    
    storage.updateWallet(w.id, { receiveIndex: (w.receiveIndex || 0) + 1 });
    return true;
  });

  // Obtener historial detallado
  ipcMain.handle('wallet:getHistory', async (_e, id) => {
    const wallets = storage.listWalletsPublic();
    const w = wallets.find(x => x.id === id);
    if (!w) throw new Error('Wallet no encontrada');

    let allAddrs = [];
    if (!isHdWallet(w)) {
      allAddrs.push(w.address);
    } else {
      const resolved = await resolveHdWalletAddresses(w);
      allAddrs = resolved.allAddresses.map(a => a.address);
    }

    const myAddrs = new Set(allAddrs);
    let historyMap = new Map();

    const histPromises = allAddrs.map(async (addr) => {
      try {
        const h = await network.getHistory(addr);
        h.forEach(tx => {
          if (!historyMap.has(tx.tx_hash)) {
            historyMap.set(tx.tx_hash, tx);
          }
        });
      } catch (err) {}
    });
    await Promise.all(histPromises);

    let history = Array.from(historyMap.values());
    history.sort((a, b) => {
      if (a.height <= 0 && b.height > 0) return -1;
      if (b.height <= 0 && a.height > 0) return 1;
      return b.height - a.height;
    });

    history = history.slice(0, 50);

    const detailedHistory = [];
    const CHUNK = 10;
    for (let i = 0; i < history.length; i += CHUNK) {
      const chunk = history.slice(i, i + CHUNK);
      const chunkPromises = chunk.map(async (tx) => {
        try {
          const raw = await network.getTransaction(tx.tx_hash);
          let netSats = 0;
          
          raw.vout.forEach(out => {
            if (out.scriptPubKey && out.scriptPubKey.addresses) {
              for (const a of out.scriptPubKey.addresses) {
                if (myAddrs.has(a)) {
                  netSats += Math.round(out.value * 1e8);
                }
              }
            }
          });

          const vinPromises = raw.vin.map(async (vin) => {
            if (vin.coinbase) return;
            try {
              const prev = await network.getTransaction(vin.txid);
              const prevOut = prev.vout[vin.vout];
              if (prevOut && prevOut.scriptPubKey && prevOut.scriptPubKey.addresses) {
                for (const a of prevOut.scriptPubKey.addresses) {
                  if (myAddrs.has(a)) {
                    netSats -= Math.round(prevOut.value * 1e8);
                  }
                }
              }
            } catch(e) {}
          });
          await Promise.all(vinPromises);

          if (netSats !== 0) {
            detailedHistory.push({
              txid: tx.tx_hash,
              height: tx.height,
              netSats,
              time: raw.blocktime || raw.time || Math.floor(Date.now() / 1000)
            });
          }
        } catch(e) {}
      });
      await Promise.all(chunkPromises);
    }

    detailedHistory.sort((a, b) => {
      if (a.height <= 0 && b.height > 0) return -1;
      if (b.height <= 0 && a.height > 0) return 1;
      if (b.time !== a.time) return b.time - a.time;
      return 0;
    });

    return detailedHistory;
  });
}

app.on('before-quit', () => { network.disconnect(); });
