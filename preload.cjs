const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('native', {
  minimize: () => ipcRenderer.send('win', 'min'),
  maximize: () => ipcRenderer.send('win', 'max'),
  close: () => ipcRenderer.send('win', 'close'),
})
