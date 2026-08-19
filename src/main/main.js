// Proceso principal de Electron: crea la ventana y atiende los pedidos
// del frontend (crear / importar wallets). Toda la criptografia corre aca,
// en el proceso principal; el frontend nunca toca las claves directamente.

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const wallet = require('../core/wallet');
const network = require('../core/network');
const storage = require('../core/storage');
const chain = require('../core/chain');
const chainsync = require('../core/chainsync');
const spv = require('../core/spv');
const coinselect = require('../core/coinselect');
const utxoscan = require('../core/utxoscan');
const torManager = require('./torManager');

const isHdWallet = (w) => Boolean(w && (w.type === 'mnemonic' || w.type === 'hex_hd'));

// Sincroniza la cadena de cabeceras sin bloquear nada.
//
// No propaga errores a proposito: si la sincronizacion falla, la wallet sigue
// andando con el cruce entre operadores y la UI avisa que la verificacion por
// proof-of-work no esta disponible. Es una capa que se suma, no un requisito.
// Cuanto esperar antes de empezar a bajar cabeceras. Le da al arranque de la
// wallet el pool entero para si: primero que el usuario vea su saldo, despues
// se sincroniza la cadena.
const DEMORA_SYNC_MS = 6000;

function arrancarSincronizacionDeCadena(win) {
  const avisar = (estado) => {
    if (win && !win.isDestroyed()) win.webContents.send('chain:progress', estado);
  };

  new Promise(resolve => setTimeout(resolve, DEMORA_SYNC_MS))
    .then(() => chainsync.sync(avisar))
    .then((final) => {
      avisar(final);
      if (final.error) console.warn('[Cadena] Sincronizacion incompleta:', final.error);
      else console.log(`[Cadena] Verificada por PoW hasta el bloque ${final.tipHeight}.`);
    })
    .catch((e) => console.warn('[Cadena] Fallo la sincronizacion:', e.message));
}

// Verifica por SPV una tanda de transacciones ya confirmadas.
//
// Cada una necesita su propia prueba de inclusion, asi que van con un limite de
// concurrencia: sobre Tor, cincuenta requests sueltas de golpe tardan mas que
// ocho en vuelo bien administradas.
async function verificarTransacciones(transacciones) {
  const CONCURRENCIA = 8;
  const pendientes = transacciones.slice();

  async function trabajador() {
    while (pendientes.length > 0) {
      const tx = pendientes.shift();
      if (!tx) return;

      if (tx.height <= 0) {
        tx.verification = { verified: false, reason: 'sin-confirmar', detail: 'Todavia en el mempool.' };
        continue;
      }
      if (!chainsync.puedeVerificar(tx.height)) {
        // Anterior al checkpoint: no es sospechosa, simplemente cae fuera del
        // tramo de cadena que la wallet tiene verificado.
        tx.verification = {
          verified: false,
          reason: 'fuera-de-rango',
          detail: `El bloque ${tx.height} es anterior al checkpoint (${chain.CHECKPOINT.height}).`,
        };
        continue;
      }

      try {
        const proof = await network.getMerkleProof(tx.txid, tx.height);
        tx.verification = spv.verifyTransaction(tx.txid, tx.height, proof);
      } catch (e) {
        tx.verification = {
          verified: false,
          reason: 'sin-prueba',
          detail: 'No pude obtener la prueba de inclusion: ' + String(e.message || e),
        };
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCIA }, trabajador));
  return transacciones;
}

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

// El saldo de una wallet HD es la suma de muchas direcciones. Alcanza con que
// UNA no haya pasado el cruce entre operadores para que el total deje de estar
// verificado: no se puede decir "el saldo es correcto" si una parte esta en duda.
function aggregateVerification(balances) {
  const conDatos = (balances || []).filter(b => b && b.verification);
  if (conDatos.length === 0) {
    return { verified: false, detail: 'Sin datos de verificacion cruzada.' };
  }

  const dudosas = conDatos.filter(b => !b.verification.verified);
  if (dudosas.length === 0) {
    return { verified: true, detail: conDatos[0].verification.detail };
  }

  return {
    verified: false,
    detail: `${dudosas.length} de ${conDatos.length} direcciones no pasaron la verificacion cruzada. ` +
            dudosas[0].verification.detail,
  };
}

async function discoverHdChain(xpub, branch, startFrom = 0) {
  const discovered = [];
  let cursor = startFrom;
  let consecutiveEmpty = 0;
  let maxIndexWithActivity = -1;
  let stopWalking = false;
  let failures = 0;

  while (!stopWalking && discovered.length < DISCOVERY_HARD_CAP) {
    const batch = wallet.getAddressesFromXPub(xpub, branch, cursor, DISCOVERY_BATCH_SIZE);

    const results = await Promise.all(batch.map(async (a) => {
      try {
        const h = await network.getHistory(a.address);
        return { address: a, historyLength: Array.isArray(h) ? h.length : 0, ok: true };
      } catch (e) {
        // El motivo importa y hasta ahora se tiraba. Sin esto, un barrido que
        // falla no se puede diagnosticar despues: solo queda el sintoma.
        return { address: a, historyLength: 0, ok: false, error: e };
      }
    }));

    // Si MAYORIA del batch fallo, la red esta caida/inestable: abortar en
    // vez de arriesgar a que un gap "empty" en realidad sean fallos y demos
    // saldo 0 falso a una wallet que tiene fondos.
    const fallidos = results.filter(r => !r.ok);
    if (tooManyNetworkFailures(fallidos.length, results.length)) {
      const motivo = fallidos[0].error ? fallidos[0].error.message : 'sin detalle';
      const cola = network.estadoDeCola();
      throw new Error(
        `No se pudo consultar la red durante el descubrimiento de direcciones ` +
        `(${fallidos.length} de ${results.length} fallaron; cola: ${cola.enVuelo} en vuelo, ${cola.esperando} esperando). ` +
        `Primer motivo: ${motivo}`
      );
    }

    for (const r of results) {
      discovered.push(r.address);
      if (!r.ok) {
        // Fallo aislado: no lo contamos como vacio (podria haber tenido
        // actividad); tampoco reseteamos el gap. Seguimos, pero queda
        // anotado: el gap sigue corriendo con las que vienen despues, asi
        // que una direccion activa que no pudimos ver puede cortar el
        // barrido antes de tiempo y esconder fondos en indices mas altos.
        // Quien vaya a firmar tiene que enterarse de esto.
        failures += 1;
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

  const hitHardCap = discovered.length >= DISCOVERY_HARD_CAP && !stopWalking;
  if (hitHardCap) {
    // Wallet enorme (>2000 direcciones activas por rama) — no llegamos al
    // gap. El saldo reportado puede ser incompleto.
    console.warn(`[discoverHdChain] Hard cap ${DISCOVERY_HARD_CAP} alcanzado en branch ${branch}. El saldo puede estar subestimado.`);
  }

  return { addresses: discovered, maxIndexWithActivity, failures, hitHardCap };
}

// Cuantas direcciones se miran mas alla del ultimo indice conocido cuando NO
// se hace el barrido completo. No es un gap limit: es un margen de cortesia
// para notar que aparecio actividad nueva y disparar el barrido de verdad.
const VENTANA_CORTESIA = 5;

// Direcciones ya conocidas de una wallet, derivadas sin tocar la red.
//
// Por que existe: el barrido BIP44 pregunta por el historial de cada direccion
// para saber donde termina la wallet, y eso cuesta ~80 consultas por wallet
// por mas que la wallet tenga dos direcciones usadas — el gap limit de 20 en
// dos ramas se paga entero siempre. Para pintar una fila de la lista eso no
// hace falta: `wallets.json` ya guarda hasta que indice llego cada rama.
//
// Medido sobre 28 wallets reales: 1.982 direcciones barridas contra 175
// conocidas. El 91% del trabajo era redescubrir lo que ya estaba anotado.
function direccionesConocidas(w, ventana = VENTANA_CORTESIA) {
  const hastaReceive = Math.max(w.receiveIndex || 0, 1) + ventana;
  const hastaChange  = (w.changeIndex  || 0) + ventana;

  const receive = wallet.getAddressesFromXPub(w.xpub, 0, 0, hastaReceive);
  const change  = hastaChange > 0 ? wallet.getAddressesFromXPub(w.xpub, 1, 0, hastaChange) : [];

  // Indice a partir del cual estamos mirando "de mas". Si aparece actividad
  // de aca en adelante, la wallet crecio por fuera y hay que barrer en serio.
  return {
    receiveAddresses: receive,
    changeAddresses: change,
    allAddresses: [...receive, ...change],
    desdeReceive: Math.max(w.receiveIndex || 0, 1),
    desdeChange: w.changeIndex || 0,
  };
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
    // Salud del barrido. Las pantallas que solo muestran pueden ignorarlo;
    // la que firma, no.
    discoveryFailures: receiveResult.failures + changeResult.failures,
    discoveryIncomplete: receiveResult.hitHardCap || changeResult.hitHardCap,
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

  // Seguridad: bloquear TODA navegacion, y abrir en el navegador externo solo
  // los dominios que la app usa de verdad.
  //
  // Antes se abria cualquier http(s). Como el historial inyecta datos que vienen
  // del servidor Electrum (que no es de confianza), un servidor hostil podia
  // fabricar una URL y hacer que se abriera sola en el navegador del usuario,
  // fuera de Tor. Con allowlist, lo peor que puede hacer es que no se abra nada.
  const DOMINIOS_PERMITIDOS = new Set([
    'blockchair.com',
    'www.blockchair.com',
  ]);

  function abrirEnNavegador(rawUrl) {
    let url;
    try {
      url = new URL(rawUrl);
    } catch {
      return false;
    }
    if (url.protocol !== 'https:') return false;
    if (!DOMINIOS_PERMITIDOS.has(url.hostname)) {
      console.warn('Navegacion externa bloqueada hacia un dominio no permitido:', url.hostname);
      return false;
    }
    require('electron').shell.openExternal(url.toString());
    return true;
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    abrirEnNavegador(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    event.preventDefault();
    abrirEnNavegador(url);
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

    // Solo reiniciar las conexiones si algo cambio de verdad.
    //
    // El renderer puede llamar a tor:enable mas de una vez (arranque automatico
    // y boton). Desconectar cuando ya estaba todo bien mata los sockets que en
    // ese mismo momento estan bajando cabeceras, y la sincronizacion se cae con
    // "Connection lost" sin que haya pasado nada malo.
    const cambioAlgo = !network.isTorEnabled() || network.torPort() !== socksPort;
    network.setTorPort(socksPort);
    network.setUseTor(true);
    if (cambioAlgo) network.disconnect();

    // Con Tor arriba ya se puede verificar la cadena. Va en segundo plano a
    // proposito: la wallet es usable desde el primer segundo con el cruce entre
    // operadores, y el blindaje por proof-of-work se suma cuando termina.
    arrancarSincronizacionDeCadena(win);
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
  ipcMain.handle('net:poolStatus', () => network.poolStatus());

  // --- Cadena de cabeceras (verificacion por proof-of-work) ---
  ipcMain.handle('chain:status', () => chainsync.estado());
  ipcMain.handle('chain:sync', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    arrancarSincronizacionDeCadena(win);
    return chainsync.estado();
  });

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
  //
  // Dos modos, porque las dos pantallas que lo usan tienen necesidades
  // distintas:
  //
  //   completo (default) — barrido BIP44 con gap limit. Encuentra actividad en
  //     indices que esta wallet nunca genero, que es el caso de una seed
  //     importada de otra billetera. Es el modo del detalle de una wallet.
  //
  //   rapido — solo las direcciones ya conocidas, sin consultas de
  //     descubrimiento. Es el modo de la LISTA, donde el costo se multiplica
  //     por la cantidad de wallets guardadas. Si aparece actividad dentro de la
  //     ventana de cortesia, esa wallet se rebarre completa en el momento: sale
  //     barato en el caso normal y sigue siendo correcto en el raro.
  ipcMain.handle('wallet:getHdBalance', async (_e, id, opciones = {}) => {
    const wallets = storage.listWalletsPublic();
    const w = wallets.find(x => x.id === id);
    if (!w || !w.xpub) throw new Error('Wallet HD no encontrada');

    let resolved = opciones.rapido ? direccionesConocidas(w) : await resolveHdWalletAddresses(w);
    let rebarrida = false;

    let confirmed = 0;
    let unconfirmed = 0;
    let details = [];
    let failures = 0;

    const consultarSaldos = async (direcciones) => {
      confirmed = 0; unconfirmed = 0; details = []; failures = 0;
      return Promise.all(direcciones.map(async (a) => {
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
    };

    let results = await consultarSaldos(resolved.allAddresses);

    // En modo rapido, actividad en la ventana de cortesia significa que la
    // wallet creció por fuera de los indices anotados. Ahi el atajo dejo de
    // ser valido y hay que barrer en serio ESTA wallet.
    if (opciones.rapido) {
      const masAllaDeLoConocido = details.some(d =>
        (d.change === 0 && d.index >= resolved.desdeReceive) ||
        (d.change === 1 && d.index >= resolved.desdeChange)
      );
      if (masAllaDeLoConocido) {
        rebarrida = true;
        resolved = await resolveHdWalletAddresses(w);
        results = await consultarSaldos(resolved.allAddresses);
      }
    }

    if (tooManyNetworkFailures(failures, results.length)) {
      throw new Error('Error de red: fallaron demasiadas consultas de saldo (la wallet podria tener fondos no visibles).');
    }

    for (const b of results) {
      confirmed += b.confirmed;
      unconfirmed += b.unconfirmed;
    }

    // Mostrar es mas tolerante que firmar: un saldo parcial sigue siendo util
    // y no se puede dejar la pantalla en blanco por un timeout. Pero parcial
    // hay que decirlo. Antes esta cuenta se descartaba al salir de la funcion
    // y el usuario veia un total incompleto como si fuera el total.
    const incomplete = failures > 0 || resolved.discoveryFailures > 0 || resolved.discoveryIncomplete;

    // Un saldo del camino rapido mira solo las direcciones anotadas. Si la
    // wallet crecio por fuera y la actividad nueva cayo mas alla de la ventana
    // de cortesia, este total puede quedar corto — el detalle, que si barre
    // completo, es el que manda.
    const soloDireccionesConocidas = Boolean(opciones.rapido) && !rebarrida;

    return {
      confirmed,
      unconfirmed,
      details,
      receiveAddresses: resolved.receiveAddresses,
      server: network.serverName(),
      verification: aggregateVerification(results),
      incomplete,
      failures,
      discoveryFailures: resolved.discoveryFailures,
      discoveryIncomplete: resolved.discoveryIncomplete,
      addressesQueried: results.length,
      soloDireccionesConocidas,
      rebarrida,
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
    return { confirmed, unconfirmed, failures, verification: aggregateVerification(results) };
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

    // Esta es la pantalla donde el usuario decide si la seed que escribio es la
    // suya. Un saldo subestimado aca no se lee como "falto red": se lee como
    // "me equivoque de wallet". Tiene que decir cuando esta incompleto.
    const failures = rBal.failures + cBal.failures;
    const discoveryFailures = receiveDiscovery.failures + changeDiscovery.failures;
    const discoveryIncomplete = receiveDiscovery.hitHardCap || changeDiscovery.hitHardCap;

    return {
      addresses: firstAddresses,
      total: {
        confirmed:   rBal.confirmed   + cBal.confirmed,
        unconfirmed: rBal.unconfirmed + cBal.unconfirmed,
      },
      server: network.serverName(),
      verification: aggregateVerification([rBal, cBal]),
      incomplete: failures > 0 || discoveryFailures > 0 || discoveryIncomplete,
      failures,
      discoveryFailures,
      discoveryIncomplete,
      addressesQueried: receiveDiscovery.addresses.length + changeDiscovery.addresses.length,
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

  // Junta los UTXOs gastables de una wallet. Para wallets HD tambien devuelve
  // el resultado del discovery, que el envio necesita para la direccion de
  // cambio. La regla —o estan todas las direcciones, o no se firma— vive en
  // utxoscan.js, donde se puede testear sin red.
  async function collectSpendableUtxos(w) {
    if (!isHdWallet(w)) {
      const u = await network.getUtxos(w.address);
      return { utxos: (u || []).map(x => ({ ...x, address: w.address })), resolved: null };
    }

    const resolved = await resolveHdWalletAddresses(w);
    const { utxos } = await utxoscan.collectSpendableUtxos({
      addresses: resolved.allAddresses,
      getUtxos: (address) => network.getUtxos(address),
      discoveryFailures: resolved.discoveryFailures,
      discoveryIncomplete: resolved.discoveryIncomplete,
    });

    return { utxos, resolved };
  }

  // Estimar el maximo enviable calculando el fee real segun cantidad de UTXOs.
  // No necesita el password: solo mira los UTXOs.
  //
  // Vaciar la wallet es la unica operacion que barre todas las direcciones a
  // proposito, asi que devuelve cuantas va a unir para poder avisarlo.
  ipcMain.handle('wallet:estimateMaxSend', async (_e, id) => {
    const wallets = storage.listWalletsPublic();
    const w = wallets.find(x => x.id === id);
    if (!w) throw new Error('Wallet no encontrada');

    const { utxos } = await collectSpendableUtxos(w);
    const plan = coinselect.planMaxSend({ utxos, feeRate: 1 });

    return {
      totalSats: plan.totalSats,
      feeSats: plan.feeSats,
      maxSats: plan.maxSats,
      utxoCount: plan.utxoCount,
      addressCount: plan.addressCount,
      leftOut: plan.leftOut,
      skippedCount: plan.skipped.length,
      skippedSats: plan.skipped.reduce((s, u) => s + u.value, 0),
    };
  });

  // Previsualizar un envio: monto, comision y cambio, SIN pedir la contrasena
  // ni tocar claves privadas. Es lo que alimenta la pantalla de confirmacion.
  ipcMain.handle('wallet:prepareSend', async (_e, id, toAddress, amountBch) => {
    const wallets = storage.listWalletsPublic();
    const w = wallets.find(x => x.id === id);
    if (!w) throw new Error('Wallet no encontrada');

    // Validar destino y monto antes de salir a la red.
    wallet.parseMainnetAddress(toAddress);
    const amountSats = wallet.bchToSats(amountBch);

    const { utxos } = await collectSpendableUtxos(w);
    if (utxos.length === 0) throw new Error('No hay fondos suficientes (0 UTXOs).');

    // `inputs` se queda en el proceso principal: al frontend solo van los
    // numeros que el usuario necesita para decidir.
    const { inputs, ...plan } = wallet.planSend({ utxos, toAddress, amountSats, feeRate: 1 });
    return { ...plan, toAddress, walletName: w.name };
  });

  // Enviar BCH
  ipcMain.handle('wallet:sendBch', async (_e, id, password, toAddress, amountBch) => {
    const wallets = storage.listWalletsPublic();
    const w = wallets.find(x => x.id === id);
    if (!w) throw new Error('Wallet no encontrada');

    // Validar ANTES de descifrar la semilla: si el destino o el monto estan
    // mal, la clave privada nunca llega a existir en memoria.
    wallet.parseMainnetAddress(toAddress);
    const amountSats = wallet.bchToSats(amountBch);

    const secret = storage.getDecryptedSecret(id, password);
    const { utxos, resolved } = await collectSpendableUtxos(w);
    if (utxos.length === 0) throw new Error('No hay fondos suficientes (0 UTXOs).');

    // Elegir las monedas ANTES de derivar claves: se firma solo lo que entra en
    // la transaccion, no la wallet entera. Es la misma llamada que hizo la
    // pantalla de confirmacion, y es determinista, asi que lo que el usuario
    // aprobo es lo que se firma.
    const plan = wallet.planSend({ utxos, toAddress, amountSats, feeRate: 1 });
    const elegidos = plan.inputs;

    let inputs;
    let changeAddress;
    // Guardamos aca el proximo changeIndex a persistir tras un envio exitoso.
    // Base = resolved.changeIndex (post-discovery), NO w.changeIndex, que
    // pudo haber quedado desactualizado si la seed viene importada.
    let nextChangeIndexToPersist = null;

    if (!isHdWallet(w)) {
      inputs = elegidos.map(x => ({ ...x, privKeyHex: secret }));
      changeAddress = w.address;
    } else {
      inputs = elegidos.map(x => ({
        ...x,
        privKeyHex: w.type === 'hex_hd'
          ? wallet.getPrivateKeyHexForHexHdPath(secret, 0, x.change, x.index)
          : wallet.getPrivateKeyHexForPath(secret, 0, x.change, x.index)
      }));
      // Nueva direccion de change: la primera libre segun lo descubierto.
      const newChangeNode = wallet.getAddressesFromXPub(w.xpub, 1, resolved.changeIndex, 1)[0];
      changeAddress = newChangeNode.address;
      nextChangeIndexToPersist = resolved.changeIndex + 1;
    }

    const built = wallet.buildAndSignTx({
      inputs,
      toAddress,
      changeAddress,
      amountSats,
      feeRate: 1
    });

    // El txid es determinista: lo calculamos nosotros a partir de la tx que
    // firmamos, en vez de creerle al servidor lo que nos devuelva.
    const txidLocal = require('bitcore-lib-cash').Transaction(built.hex).id;
    const txidServidor = await network.broadcastTransaction(built.hex);

    if (typeof txidServidor === 'string' && txidServidor.toLowerCase() !== txidLocal.toLowerCase()) {
      console.warn('El servidor devolvio un txid distinto al calculado localmente.',
        { servidor: txidServidor, local: txidLocal });
    }

    if (isHdWallet(w) && nextChangeIndexToPersist !== null) {
      try {
        storage.updateWallet(w.id, { changeIndex: nextChangeIndexToPersist });
      } catch (e) {
        // La tx ya se broadcasteo con exito; un fallo persistiendo el indice
        // no puede propagarse como error porque el usuario perderia el txid.
        console.error('Tx enviada OK pero fallo persistir changeIndex:', e);
      }
    }

    return {
      txid: txidLocal,
      feeSats: built.feeSats,
      amountSats,
      changeSats: built.changeSats,
      inputCount: built.inputCount,
      addressCount: plan.addressCount,
    };
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
    const verificaciones = [];

    // Direcciones cuyo historial no se pudo traer. Sus transacciones no van a
    // aparecer en la lista, y un historial con agujeros que no se anuncian es
    // peor que uno que avisa: el usuario concluye que una tx no existe.
    let historyFailures = 0;

    const histPromises = allAddrs.map(async (addr) => {
      try {
        const { entries, verification } = await network.getHistoryVerified(addr);
        verificaciones.push({ verification });
        entries.forEach(tx => {
          if (!historyMap.has(tx.tx_hash)) {
            historyMap.set(tx.tx_hash, tx);
          }
        });
      } catch (err) {
        historyFailures += 1;
      }
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
    // Transacciones que no se pudieron traer: no aparecen en la lista.
    let txSinResolver = 0;
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

          // El neto de una tx es lo que entro a mis direcciones menos lo que
          // salio de ellas. La resta necesita la tx anterior de cada input, y
          // si esa consulta falla el input no se resta: una tx en la que MANDE
          // plata queda con neto positivo y se muestra como si hubiera cobrado.
          // Ese numero no se puede mostrar como si fuera un hecho.
          let vinsSinResolver = 0;
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
            } catch (e) {
              vinsSinResolver += 1;
            }
          });
          await Promise.all(vinPromises);

          // Con inputs sin resolver, un neto 0 tampoco significa "no me toca":
          // puede ser una tx mia cuyo signo no se pudo calcular. Se muestra
          // igual, marcada, en vez de desaparecer de la lista.
          if (netSats !== 0 || vinsSinResolver > 0) {
            detailedHistory.push({
              txid: tx.tx_hash,
              height: tx.height,
              netSats,
              amountUncertain: vinsSinResolver > 0,
              time: raw.blocktime || raw.time || Math.floor(Date.now() / 1000)
            });
          }
        } catch (e) {
          txSinResolver += 1;
        }
      });
      await Promise.all(chunkPromises);
    }

    detailedHistory.sort((a, b) => {
      if (a.height <= 0 && b.height > 0) return -1;
      if (b.height <= 0 && a.height > 0) return 1;
      if (b.time !== a.time) return b.time - a.time;
      return 0;
    });

    await verificarTransacciones(detailedHistory);

    return {
      transactions: detailedHistory,
      verification: aggregateVerification(verificaciones),
      chain: chainsync.estado(),
      incomplete: historyFailures > 0 || txSinResolver > 0,
      historyFailures,
      txSinResolver,
      addressesQueried: allAddrs.length,
    };
  });
}

app.on('before-quit', () => { network.disconnect(); });
