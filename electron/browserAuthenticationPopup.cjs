const POPUP_CAPABILITY_TTL_MS = 10_000;

function grantAuthenticationPopup(entry, view, targetUrl, now = Date.now()) {
  const exactTargetUrl = safeWebUrl(targetUrl);
  if (!exactTargetUrl) {
    entry.authenticationPopupCapability = null;
    throw new Error('Authentication popups require an exact HTTP(S) target.');
  }
  entry.authenticationPopupCapability = {
    view,
    documentGeneration: entry.documentGeneration,
    targetUrl: exactTargetUrl,
    expiresAt: now + POPUP_CAPABILITY_TTL_MS,
  };
}

function consumeAuthenticationPopup(entry, view, url, partition, now = Date.now()) {
  const capability = entry.authenticationPopupCapability;
  entry.authenticationPopupCapability = null;
  if (
    capability?.view !== view ||
    capability.documentGeneration !== entry.documentGeneration ||
    capability.expiresAt <= now ||
    capability.targetUrl !== safeWebUrl(url)
  ) {
    return capability ? { action: 'deny' } : undefined;
  }
  return {
    action: 'allow',
    overrideBrowserWindowOptions: {
      title: 'DROIDEX secure sign-in',
      width: 520,
      height: 720,
      minWidth: 420,
      minHeight: 560,
      show: true,
      backgroundColor: '#111111',
      autoHideMenuBar: true,
      webPreferences: {
        partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    },
  };
}

function hardenAuthenticationPopup(window) {
  window.setMenuBarVisibility?.(false);
  const contents = window.webContents;
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event, url) => {
    if (!isSafeWebUrl(url)) event.preventDefault();
  });
  contents.on('will-redirect', (event, url, _isInPlace, isMainFrame) => {
    if (isMainFrame && !isSafeWebUrl(url)) event.preventDefault();
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
}

function isSafeWebUrl(value) {
  return Boolean(safeWebUrl(value));
}

function safeWebUrl(value) {
  if (typeof value !== 'string' || value.length > 8_192) return false;
  try {
    const url = new URL(value);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password)
      return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

module.exports = {
  consumeAuthenticationPopup,
  grantAuthenticationPopup,
  hardenAuthenticationPopup,
  isSafeWebUrl,
};
