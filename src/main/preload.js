// Puente seguro: expone al frontend SOLO estas funciones, nada mas.
// El frontend no puede tocar Node ni el sistema de archivos directamente.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  generateMnemonic: (words) => ipcRenderer.invoke('wallet:generateMnemonic', words),
  generateHexSecret: () => ipcRenderer.invoke('wallet:generateHexSecret'),
  detectInput: (input) => ipcRenderer.invoke('wallet:detectInput', input),
  fromMnemonic: (mnemonic, opts) => ipcRenderer.invoke('wallet:fromMnemonic', mnemonic, opts),
  fromHex: (hex) => ipcRenderer.invoke('wallet:fromHex', hex),
  getBalance: (address) => ipcRenderer.invoke('net:getBalance', address),
  resolveHexSecret: (hex) => ipcRenderer.invoke('net:resolveHexSecret', hex),
  mnemonicReport: (mnemonic, count) => ipcRenderer.invoke('net:mnemonicReport', mnemonic, count),
  getHdBalance: (id) => ipcRenderer.invoke('wallet:getHdBalance', id),
  getHistory: (id) => ipcRenderer.invoke('wallet:getHistory', id),
  incrementReceiveIndex: (id) => ipcRenderer.invoke('wallet:incrementReceiveIndex', id),
  
  enableTor: () => ipcRenderer.invoke('tor:enable'),
  disableTor: () => ipcRenderer.invoke('tor:disable'),
  torStatus: () => ipcRenderer.invoke('tor:status'),
  torNewCircuit: () => ipcRenderer.invoke('tor:newCircuit'),
  isTorDownloaded: () => ipcRenderer.invoke('tor:isDownloaded'),
  onTorProgress: (callback) => ipcRenderer.on('tor:progress', (_event, msg) => callback(msg)),
  // --- Persistencia ---
  listWallets: () => ipcRenderer.invoke('storage:list'),
  saveWallet: (opts) => ipcRenderer.invoke('storage:save', opts),
  deleteWallet: (id) => ipcRenderer.invoke('storage:delete', id),
  decryptWallet: (id, password) => ipcRenderer.invoke('storage:decrypt', id, password),
  sendBch: (id, password, toAddress, amount) => ipcRenderer.invoke('wallet:sendBch', id, password, toAddress, amount),
});
