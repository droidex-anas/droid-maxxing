const { contextBridge, ipcRenderer } = require('electron');

// This isolated panel has no access to the main app's files, chats or bridge.
contextBridge.exposeInMainWorld('desktopCapture', {
  ready: () => ipcRenderer.invoke('capture:desktop', { operation: 'ready' }),
  choose: (mode) => ipcRenderer.invoke('capture:desktop', { operation: 'choose', mode }),
  selectionReady: () => ipcRenderer.invoke('capture:desktop', { operation: 'selectionReady' }),
  select: (rect) => ipcRenderer.invoke('capture:desktop', { operation: 'select', rect }),
  cancel: () => ipcRenderer.invoke('capture:desktop', { operation: 'cancel' }),
});
