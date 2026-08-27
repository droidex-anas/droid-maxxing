function attachChildView(entry, host) {
  if (!entry?.view || !isUsableHost(host)) return false;
  if (entry.windowAttached && entry.hostWindow === host) return false;
  detachChildView(entry);
  host.contentView.addChildView(entry.view);
  entry.windowAttached = true;
  entry.hostWindow = host;
  return true;
}

function detachChildView(entry, view = entry?.view) {
  const host = entry?.hostWindow;
  const wasAttached = Boolean(entry?.windowAttached);
  if (wasAttached && view && isUsableHost(host)) {
    try {
      host.contentView.removeChildView(view);
    } catch {
      // The host may already be tearing down.
    }
  }
  if (entry) {
    entry.windowAttached = false;
    entry.hostWindow = null;
  }
  return wasAttached;
}

function isUsableHost(host) {
  return Boolean(host && (typeof host.isDestroyed !== 'function' || !host.isDestroyed()));
}

function createNativeBrowserViewHost({ BrowserWindow, getMainWindow, listEntries }) {
  let hiddenNativeBrowserWindow = null;

  function attachToMainWindow(entry) {
    const mainWindow = getMainWindow();
    if (!entry.view || !isUsableHost(mainWindow)) return;
    const previousHost = entry.hostWindow;
    const moved = attachChildView(entry, mainWindow);
    entry.view.setVisible(entry.visible);
    safeWebContents(entry.view)?.setBackgroundThrottling(!entry.visible);
    if (moved && previousHost === hiddenNativeBrowserWindow) {
      closeIfUnused();
      resize();
    }
  }

  function addHiddenView(entry) {
    if (!entry.view) return;
    const host = ensure();
    attachChildView(entry, host);
    entry.view.setVisible(true);
    resize();
  }

  function removeView(entry, view) {
    const host = entry.hostWindow ?? getMainWindow();
    detachChildView(entry, view);
    if (host === hiddenNativeBrowserWindow) {
      closeIfUnused();
      resize();
    }
  }

  function resize() {
    if (!isUsableHost(hiddenNativeBrowserWindow)) return;
    let width = 1;
    let height = 1;
    for (const entry of listEntries()) {
      if (!entry.windowAttached || entry.hostWindow !== hiddenNativeBrowserWindow) continue;
      const bounds = entry.view?.getBounds();
      width = Math.max(width, bounds?.width ?? 1);
      height = Math.max(height, bounds?.height ?? 1);
    }
    hiddenNativeBrowserWindow.setContentSize(width, height);
  }

  function setHiddenBounds(entry, viewport) {
    if (!isBrowserViewUsable(entry.view)) return;
    const width = Math.max(1, Math.round(Number(viewport?.width) || 1200));
    const height = Math.max(1, Math.round(Number(viewport?.height) || 800));
    entry.view.setBounds({ x: 0, y: 0, width, height });
    if (entry.hostWindow === hiddenNativeBrowserWindow && isUsableHost(hiddenNativeBrowserWindow)) {
      resize();
    }
  }

  function ensure() {
    if (isUsableHost(hiddenNativeBrowserWindow)) return hiddenNativeBrowserWindow;
    hiddenNativeBrowserWindow = new BrowserWindow({
      show: true,
      x: -10000,
      y: -10000,
      width: 1200,
      height: 800,
      frame: false,
      backgroundColor: '#ffffff',
      opacity: 0,
      focusable: false,
      skipTaskbar: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false,
      },
    });
    hiddenNativeBrowserWindow.setIgnoreMouseEvents(true);
    hiddenNativeBrowserWindow.on('closed', () => {
      hiddenNativeBrowserWindow = null;
    });
    return hiddenNativeBrowserWindow;
  }

  function close() {
    const window = hiddenNativeBrowserWindow;
    hiddenNativeBrowserWindow = null;
    if (!isUsableHost(window)) return;
    try {
      window.close();
    } catch {
      // The app may already be tearing down.
    }
  }

  function closeIfUnused() {
    if (!hiddenNativeBrowserWindow) return;
    const inUse = [...listEntries()].some(
      (entry) => entry.windowAttached && entry.hostWindow === hiddenNativeBrowserWindow,
    );
    if (!inUse) close();
  }

  return {
    attachToMainWindow,
    addHiddenView,
    removeView,
    setHiddenBounds,
    close,
  };
}

function safeWebContents(view) {
  try {
    if (!view) return null;
    const contents = view.webContents;
    if (!contents || contents.isDestroyed()) return null;
    return contents;
  } catch {
    return null;
  }
}

function isBrowserViewUsable(view) {
  return Boolean(view && safeWebContents(view));
}

module.exports = {
  attachChildView,
  detachChildView,
  createNativeBrowserViewHost,
  isUsableHost,
  safeWebContents,
  isBrowserViewUsable,
};
