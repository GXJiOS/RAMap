const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mapDesktop', {
  platform: process.platform,
  saveFile: (file) => ipcRenderer.invoke('ramap:save-file', file),
  openAssets: (directory) => ipcRenderer.invoke('ramap:assets-open', directory),
  assetStatus: () => ipcRenderer.invoke('ramap:assets-status'),
  readAsset: (name) => ipcRenderer.invoke('ramap:assets-read', name),
  chooseFolder: () => ipcRenderer.invoke('ramap:choose-folder'),
});
