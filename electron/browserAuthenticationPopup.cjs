const {
  isSafeHttpUrl,
  MAX_BROWSER_URL_LENGTH,
  parseSafeHttpUrl,
} = require('./nativeBrowserUrls.cjs');

const POPUP_URL_LIMIT = { maxLength: MAX_BROWSER_URL_LENGTH };

const POPUP_CAPABILITY_TTL_MS = 10_000;

function grantAuthenticationPopup(entry, view, targetUrl, now = Date.now()) {
  const exactTargetUrl = parseSafeHttpUrl(targetUrl, POPUP_URL_LIMIT)?.href;
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
    capability.targetUrl !== parseSafeHttpUrl(url, POPUP_URL_LIMIT)?.href
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
  // Live navigation must stay uncapped; real SAML/OAuth responses exceed the stored-URL limit.
  contents.on('will-navigate', (event, url) => {
    if (!isSafeHttpUrl(url)) event.preventDefault();
  });
  contents.on('will-redirect', (event, url, _isInPlace, isMainFrame) => {
    if (isMainFrame && !isSafeHttpUrl(url)) event.preventDefault();
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
}

module.exports = {
  consumeAuthenticationPopup,
  grantAuthenticationPopup,
  hardenAuthenticationPopup,
};
