const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mapDesktop', {
  platform: process.platform,
  saveFile: (file) => ipcRenderer.invoke('ramap:save-file', file),
});
