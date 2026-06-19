// Proceso principal de Electron: crea la ventana y atiende los pedidos
// del frontend (crear / importar wallets). Toda la criptografia corre aca,
// en el proceso principal; el frontend nunca toca las claves directamente.

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const wallet = require('../core/wallet');
const network = require('../core/network');
const storage = require('../core/storage');
const torManager = require('./torManager');

function createWindow() {
  const win = new BrowserWindow({
    width: 980,
    height: 740,
    minWidth: 820,
    minHeight: 620,
    backgroundColor: '#0e1116',
    title: 'BCH Wallet',
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

  ipcMain.handle('wallet:generateMnemonic', (_e, words) => wallet.generateMnemonic(words));
  ipcMain.handle('wallet:generateHexSecret', () => wallet.generateHexSecret());
  ipcMain.handle('wallet:detectInput', (_e, input) => wallet.detectInputType(input));
  ipcMain.handle('wallet:fromMnemonic', (_e, mnemonic, opts) => wallet.addressesFromMnemonic(mnemonic, opts));
  ipcMain.handle('wallet:fromHex', (_e, hex) => wallet.candidatesFromHexSecret(hex));

  // --- Red (saldos) ---
  ipcMain.handle('net:getBalance', (_e, address) => network.getBalance(address));

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

  // Consultar balance total de una billetera HD
  ipcMain.handle('wallet:getHdBalance', async (_e, id) => {
    const wallets = storage.listWalletsPublic();
    const w = wallets.find(x => x.id === id);
    if (!w || !w.xpub) throw new Error('Wallet HD no encontrada');

    const rIndex = w.receiveIndex || 0;
    const cIndex = w.changeIndex || 0;
    
    const receiveAddrs = wallet.getAddressesFromXPub(w.xpub, 0, 0, rIndex + 10);
    const changeAddrs = wallet.getAddressesFromXPub(w.xpub, 1, 0, cIndex + 10);
    const allAddrs = [...receiveAddrs, ...changeAddrs];
    
    let confirmed = 0;
    let unconfirmed = 0;
    let details = [];

    // En paralelo para mayor velocidad
    const promises = allAddrs.map(async (a) => {
      try {
        const b = await network.getBalance(a.address);
        if (b.confirmed > 0 || b.unconfirmed !== 0) {
          details.push({ ...a, confirmed: b.confirmed, unconfirmed: b.unconfirmed });
        }
        return b;
      } catch (err) {
        return { confirmed: 0, unconfirmed: 0 };
      }
    });

    const results = await Promise.all(promises);
    for (const b of results) {
      confirmed += b.confirmed;
      unconfirmed += b.unconfirmed;
    }

    return { confirmed, unconfirmed, details, receiveAddresses: receiveAddrs, server: network.serverName() };
  });

  // Importar frase: deriva las primeras direcciones y suma su saldo.
  ipcMain.handle('net:mnemonicReport', async (_e, mnemonic, count = 5) => {
    const addresses = await wallet.addressesFromMnemonic(mnemonic, { count });
    let confirmed = 0;
    let unconfirmed = 0;
    for (const a of addresses) {
      try {
        const b = await network.getBalance(a.address);
        a.confirmed = b.confirmed;
        a.unconfirmed = b.unconfirmed;
        confirmed += b.confirmed;
        unconfirmed += b.unconfirmed;
      } catch (e) {
        a.error = String(e.message || e);
      }
    }
    return { addresses, total: { confirmed, unconfirmed }, server: network.serverName() };
  });

  // Enviar BCH
  ipcMain.handle('wallet:sendBch', async (_e, id, password, toAddress, amountBch) => {
    const wallets = storage.listWalletsPublic();
    const w = wallets.find(x => x.id === id);
    if (!w) throw new Error('Wallet no encontrada');

    const secret = storage.getDecryptedSecret(id, password);
    let inputs = [];
    let changeAddress;

    if (w.type === 'hex') {
      const u = await network.getUtxos(w.address);
      if (!u || u.length === 0) throw new Error('No hay fondos suficientes (0 UTXOs).');
      u.forEach(x => inputs.push({ ...x, address: w.address, privKeyHex: secret }));
      changeAddress = w.address;
    } else {
      const rIndex = w.receiveIndex || 0;
      const cIndex = w.changeIndex || 0;
      const receiveAddrs = wallet.getAddressesFromXPub(w.xpub, 0, 0, rIndex + 10);
      const changeAddrs = wallet.getAddressesFromXPub(w.xpub, 1, 0, cIndex + 10);
      const allAddrs = [...receiveAddrs, ...changeAddrs];

      const promises = allAddrs.map(async (a) => {
        try {
          const u = await network.getUtxos(a.address);
          if (u && u.length > 0) {
            const privKeyHex = wallet.getPrivateKeyHexForPath(secret, 0, a.change, a.index);
            u.forEach(x => inputs.push({ ...x, address: a.address, privKeyHex }));
          }
        } catch(e) {}
      });
      await Promise.all(promises);

      if (inputs.length === 0) throw new Error('No hay fondos suficientes (0 UTXOs).');
      
      const newChangeNode = wallet.getAddressesFromXPub(w.xpub, 1, cIndex, 1)[0];
      changeAddress = newChangeNode.address;
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
    
    if (w.type === 'mnemonic') {
      storage.updateWallet(w.id, { changeIndex: (w.changeIndex || 0) + 1 });
    }

    return txid;
  });

  // Incrementar el indice de recepcion de una HD Wallet
  ipcMain.handle('wallet:incrementReceiveIndex', async (_e, id) => {
    const wallets = storage.listWalletsPublic();
    const w = wallets.find(x => x.id === id);
    if (!w || w.type !== 'mnemonic') throw new Error('Wallet HD no encontrada');
    
    storage.updateWallet(w.id, { receiveIndex: (w.receiveIndex || 0) + 1 });
    return true;
  });

  // Obtener historial detallado
  ipcMain.handle('wallet:getHistory', async (_e, id) => {
    const wallets = storage.listWalletsPublic();
    const w = wallets.find(x => x.id === id);
    if (!w) throw new Error('Wallet no encontrada');

    let allAddrs = [];
    if (w.type === 'hex') {
      allAddrs.push(w.address);
    } else {
      const rIndex = w.receiveIndex || 0;
      const cIndex = w.changeIndex || 0;
      const receiveAddrs = wallet.getAddressesFromXPub(w.xpub, 0, 0, rIndex + 5);
      const changeAddrs = wallet.getAddressesFromXPub(w.xpub, 1, 0, cIndex + 5);
      allAddrs = [...receiveAddrs.map(a => a.address), ...changeAddrs.map(a => a.address)];
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
