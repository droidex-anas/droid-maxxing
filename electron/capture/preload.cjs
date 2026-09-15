function installCapturePreload({ contextBridge, ipcRenderer }) {
  contextBridge.exposeInMainWorld('droidCapture', {
    preferences: () => ipcRenderer.invoke('capture:request', { operation: 'preferences' }),
    setPreferences: (value) =>
      ipcRenderer.invoke('capture:request', { operation: 'setPreferences', value }),
    take: (request) => ipcRenderer.invoke('capture:request', { ...request, operation: 'take' }),
    cancel: (requestId) =>
      ipcRenderer.invoke('capture:request', { operation: 'cancel', requestId }),
    import: (source, title) =>
      ipcRenderer.invoke('capture:request', { operation: 'import', source, title }),
    read: (id) => ipcRenderer.invoke('capture:request', { operation: 'read', id }),
    list: () => ipcRenderer.invoke('capture:request', { operation: 'list' }),
    thumbnail: (id) => ipcRenderer.invoke('capture:request', { operation: 'thumbnail', id }),
    delete: (id) => ipcRenderer.invoke('capture:request', { operation: 'delete', id }),
    save: (id, revision, recipe, output) =>
      ipcRenderer.invoke('capture:request', { operation: 'save', id, revision, recipe, output }),
    copy: (id) => ipcRenderer.invoke('capture:request', { operation: 'copy', id }),
    export: (id) => ipcRenderer.invoke('capture:request', { operation: 'export', id }),
    attach: (id) => ipcRenderer.invoke('capture:request', { operation: 'attach', id }),
    onShortcut: (handler) => {
      const listener = () => handler();
      ipcRenderer.on('capture:shortcut', listener);
      return () => ipcRenderer.removeListener('capture:shortcut', listener);
    },
  });
}
module.exports = { installCapturePreload };
