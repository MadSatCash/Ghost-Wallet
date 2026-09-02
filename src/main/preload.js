// Puente seguro: expone al frontend SOLO estas funciones, nada mas.
// El frontend no puede tocar Node ni el sistema de archivos directamente.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  generateMnemonic: (words) => ipcRenderer.invoke('wallet:generateMnemonic', words),
  generateHexSecret: () => ipcRenderer.invoke('wallet:generateHexSecret'),
  detectInput: (input) => ipcRenderer.invoke('wallet:detectInput', input),
  fromMnemonic: (mnemonic, opts) => ipcRenderer.invoke('wallet:fromMnemonic', mnemonic, opts),
  fromHex: (hex) => ipcRenderer.invoke('wallet:fromHex', hex),
  fromHexHd: (hex, opts) => ipcRenderer.invoke('wallet:fromHexHd', hex, opts),
  getBalance: (address) => ipcRenderer.invoke('net:getBalance', address),
  getBchPrice: (currencies, force) => ipcRenderer.invoke('net:getBchPrice', currencies, force),
  poolStatus: () => ipcRenderer.invoke('net:poolStatus'),
  chainStatus: () => ipcRenderer.invoke('chain:status'),
  chainSync: () => ipcRenderer.invoke('chain:sync'),
  onChainProgress: (callback) => ipcRenderer.on('chain:progress', (_event, estado) => callback(estado)),
  resolveHexSecret: (hex) => ipcRenderer.invoke('net:resolveHexSecret', hex),
  mnemonicReport: (mnemonic, count) => ipcRenderer.invoke('net:mnemonicReport', mnemonic, count),
  hexHdReport: (hex, count) => ipcRenderer.invoke('net:hexHdReport', hex, count),
  getHdBalance: (id, opciones) => ipcRenderer.invoke('wallet:getHdBalance', id, opciones),
  getHistory: (id) => ipcRenderer.invoke('wallet:getHistory', id),
  incrementReceiveIndex: (id) => ipcRenderer.invoke('wallet:incrementReceiveIndex', id),
  
  enableTor: () => ipcRenderer.invoke('tor:enable'),
  disableTor: () => ipcRenderer.invoke('tor:disable'),
  torStatus: () => ipcRenderer.invoke('tor:status'),
  torNewCircuit: () => ipcRenderer.invoke('tor:newCircuit'),
  isTorDownloaded: () => ipcRenderer.invoke('tor:isDownloaded'),
  onTorProgress: (callback) => ipcRenderer.on('tor:progress', (_event, msg) => callback(msg)),
  // --- Contrasena maestra (la unica de la app) ---
  vaultStatus: () => ipcRenderer.invoke('vault:status'),
  createVault: (password) => ipcRenderer.invoke('vault:create', password),
  unlockVault: (password) => ipcRenderer.invoke('vault:unlock', password),
  // --- Persistencia ---
  listWallets: () => ipcRenderer.invoke('storage:list'),
  saveWallet: (opts) => ipcRenderer.invoke('storage:save', opts),
  deleteWallet: (id) => ipcRenderer.invoke('storage:delete', id),
  revealWallet: (id) => ipcRenderer.invoke('storage:reveal', id),
  // --- Grupos de billeteras ---
  listGroups: () => ipcRenderer.invoke('groups:list'),
  createGroup: (name) => ipcRenderer.invoke('groups:create', name),
  renameGroup: (id, name) => ipcRenderer.invoke('groups:rename', id, name),
  deleteGroup: (id) => ipcRenderer.invoke('groups:delete', id),
  assignWalletGroup: (walletId, groupId) => ipcRenderer.invoke('groups:assign', walletId, groupId),
  prepareSend: (id, toAddress, amount) => ipcRenderer.invoke('wallet:prepareSend', id, toAddress, amount),
  sendBch: (id, toAddress, amount) => ipcRenderer.invoke('wallet:sendBch', id, toAddress, amount),
  estimateMaxSend: (id) => ipcRenderer.invoke('wallet:estimateMaxSend', id),
  generateQr: (text) => ipcRenderer.invoke('qr:generate', text),
});
