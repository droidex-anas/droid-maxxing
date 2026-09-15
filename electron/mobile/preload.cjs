const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('mobile', {
  status: () => ipcRenderer.invoke('droidex-mobile-control', 'status'),
  folder: () => ipcRenderer.invoke('droidex-mobile-control', 'folder'),
  enable: (workspace, address) => ipcRenderer.invoke('droidex-mobile-control', 'enable', { workspace, address }),
  approve: (id, allow) => ipcRenderer.invoke('droidex-mobile-control', 'approve', { id, allow }),
  disable: () => ipcRenderer.invoke('droidex-mobile-control', 'disable'),
  copy: () => ipcRenderer.invoke('droidex-mobile-control', 'copy'),
  saveGuide: () => ipcRenderer.invoke('droidex-mobile-control', 'save-guide'),
});
