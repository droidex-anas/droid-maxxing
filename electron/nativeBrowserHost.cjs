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

function suspendBrowserRegistry(registry, closeEntry) {
  for (const entry of registry.values()) closeEntry(entry, false);
}

function closeBrowserRegistry(registry, closeEntry) {
  for (const entry of [...registry.values()]) closeEntry(entry, true);
  registry.clear();
}

function disposeBrowserEntryView(entry, options) {
  const view = entry.view;
  const contents = safeWebContents(view);
  options.detachCursor?.(entry.browserSessionId);
  if (contents) options.revokePermissions?.(contents);
  options.removeView?.(entry, view);
  entry.view = null;
  entry.attached = false;
  entry.windowAttached = false;
  entry.hostWindow = null;
  if (contents) {
    try {
      contents.close({ waitForBeforeUnload: false });
    } catch {
      // Electron may destroy the contents before lifecycle cleanup runs.
    }
  }
  return { contents, view };
}

function safeWebContents(view) {
  try {
    const contents = view?.webContents;
    if (!contents || contents.isDestroyed()) return null;
    return contents;
  } catch {
    return null;
  }
}

function setBrowserViewBoundsIfChanged(view, bounds) {
  if (browserBoundsEqual(view.getBounds(), bounds)) return false;
  view.setBounds(bounds);
  return true;
}

function setBrowserActionActive(entry, active) {
  const contents = safeWebContents(entry.view);
  if (!contents) return false;
  contents.setBackgroundThrottling(active ? false : !(entry.attached && entry.visible));
  return true;
}

function browserBoundsEqual(left, right) {
  return (
    left?.x === right?.x &&
    left?.y === right?.y &&
    left?.width === right?.width &&
    left?.height === right?.height
  );
}

function isUsableHost(host) {
  return Boolean(host && (typeof host.isDestroyed !== 'function' || !host.isDestroyed()));
}

function createNativeBrowserHostController(options) {
  const registry = new Map();
  let attachedBrowserSessionId = null;
  let hiddenWindow = null;

  function ensureEntry(browserSessionId, createEntry) {
    let entry = registry.get(browserSessionId);
    if (!entry) {
      entry = createEntry(browserSessionId);
      registry.set(browserSessionId, entry);
    }
    clearIdle(entry);
    return entry;
  }

  function attachToMain(entry) {
    const mainWindow = options.getMainWindow();
    if (!entry.view || !isUsableHost(mainWindow)) return false;
    const previousHost = entry.hostWindow;
    const moved = attachChildView(entry, mainWindow);
    entry.view.setVisible(entry.visible);
    safeWebContents(entry.view)?.setBackgroundThrottling(!entry.visible);
    if (moved && previousHost === hiddenWindow) closeHiddenWindowIfUnused();
    attachedBrowserSessionId = entry.browserSessionId;
    entry.attached = true;
    clearIdle(entry);
    return true;
  }

  function parkHidden(entry) {
    if (!entry.view) return false;
    options.detachCursor?.(entry.browserSessionId);
    if (attachedBrowserSessionId === entry.browserSessionId) attachedBrowserSessionId = null;
    entry.attached = false;
    const host = ensureHiddenWindow();
    attachChildView(entry, host);
    entry.view.setVisible(true);
    safeWebContents(entry.view)?.setBackgroundThrottling(true);
    setHiddenBounds(entry, entry.viewport);
    resizeHiddenWindow();
    scheduleIdle(entry);
    return true;
  }

  function detach(browserSessionId) {
    const id = browserSessionId ?? attachedBrowserSessionId;
    if (!id) return undefined;
    const entry = registry.get(id);
    if (!entry) return undefined;
    parkHidden(entry);
    return entry;
  }

  function removeView(entry, view) {
    const host = entry.hostWindow;
    detachChildView(entry, view);
    if (host === hiddenWindow) closeHiddenWindowIfUnused();
  }

  function disposeEntry(entry, forget) {
    clearIdle(entry);
    options.beforeDispose?.(entry);
    if (attachedBrowserSessionId === entry.browserSessionId) attachedBrowserSessionId = null;
    disposeBrowserEntryView(entry, {
      detachCursor: options.detachCursor,
      revokePermissions: options.revokePermissions,
      removeView,
    });
    if (forget) registry.delete(entry.browserSessionId);
  }

  function scheduleIdle(entry) {
    if (!entry || entry.attached || options.idleMs <= 0) return;
    clearIdle(entry);
    entry.idleTimer = setTimeout(() => {
      if (!entry.attached) disposeEntry(entry, false);
    }, options.idleMs);
  }

  function clearIdle(entry) {
    if (!entry?.idleTimer) return;
    clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
  }

  function setHiddenBounds(entry, viewport) {
    if (!options.isViewUsable(entry.view)) return;
    const width = Math.max(1, Math.round(Number(viewport?.width) || 1200));
    const height = Math.max(1, Math.round(Number(viewport?.height) || 800));
    entry.view.setBounds({ x: 0, y: 0, width, height });
    if (entry.hostWindow === hiddenWindow) resizeHiddenWindow();
  }

  function ensureHiddenWindow() {
    if (isUsableHost(hiddenWindow)) return hiddenWindow;
    hiddenWindow = options.createHiddenWindow();
    hiddenWindow.on('closed', () => {
      hiddenWindow = null;
    });
    return hiddenWindow;
  }

  function resizeHiddenWindow() {
    if (!isUsableHost(hiddenWindow)) return;
    let width = 1;
    let height = 1;
    for (const entry of registry.values()) {
      if (!entry.windowAttached || entry.hostWindow !== hiddenWindow) continue;
      const bounds = entry.view?.getBounds();
      width = Math.max(width, bounds?.width ?? 1);
      height = Math.max(height, bounds?.height ?? 1);
    }
    hiddenWindow.setContentSize(width, height);
  }

  function closeHiddenWindowIfUnused() {
    if (!hiddenWindow) return;
    const inUse = [...registry.values()].some(
      (entry) => entry.windowAttached && entry.hostWindow === hiddenWindow,
    );
    if (!inUse) closeHiddenWindow();
    else resizeHiddenWindow();
  }

  function closeHiddenWindow() {
    const window = hiddenWindow;
    hiddenWindow = null;
    if (!isUsableHost(window)) return;
    try {
      window.close();
    } catch {
      // The app may already be tearing down.
    }
  }

  function closeAll(forget) {
    options.detachCursor?.();
    for (const entry of [...registry.values()]) disposeEntry(entry, forget);
    if (forget) registry.clear();
    attachedBrowserSessionId = null;
    closeHiddenWindow();
  }

  return {
    attachToMain,
    clearAttached: (browserSessionId) => {
      if (attachedBrowserSessionId === browserSessionId) attachedBrowserSessionId = null;
    },
    clearIdle,
    closeAll: () => closeAll(true),
    detach,
    disposeEntry,
    ensureEntry,
    entries: () => registry.values(),
    findEntry: (predicate) => [...registry.values()].find(predicate),
    getAttachedSessionId: () => attachedBrowserSessionId,
    getEntry: (browserSessionId) => registry.get(browserSessionId),
    hasEntry: (browserSessionId) => registry.has(browserSessionId),
    parkHidden,
    scheduleIdle,
    setHiddenBounds,
    suspendAll: () => closeAll(false),
  };
}

module.exports = {
  attachChildView,
  closeBrowserRegistry,
  detachChildView,
  disposeBrowserEntryView,
  setBrowserActionActive,
  setBrowserViewBoundsIfChanged,
  suspendBrowserRegistry,
  createNativeBrowserHostController,
};
