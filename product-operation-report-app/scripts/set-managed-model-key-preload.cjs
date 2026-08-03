const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('managedKey', {
  getPublicConfig: () => ipcRenderer.invoke('managed-key:public-config'),
  save: (apiKey) => ipcRenderer.invoke('managed-key:save', apiKey),
  close: () => ipcRenderer.invoke('managed-key:close')
})
