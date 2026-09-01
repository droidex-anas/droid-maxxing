function createNativeBrowserViewFactory({
  WebContentsView,
  session,
  preloadPath,
  partition,
  normalizeBrowserConsoleMessage,
  redactBrowserDiagnosticUrl,
  urls,
  safeWebContents,
  loadUrl,
  emitLoaded,
  emitLoadFailed,
  applyDesignState,
  autofill,
  recoverRenderer,
  onViewDestroyed,
  listEntries,
}) {
  let browserSessionConfigured = false;

  function configureSession() {
    if (browserSessionConfigured) return;
    const ses = session.fromPartition(partition);
    // Keep Electron's safe defaults: deny WebHID/WebUSB device access for the
    // embedded browser. WebAuthn / passkeys are handled by Chromium natively and
    // do not flow through these handlers, so granting HID/USB to arbitrary sites
    // (and auto-selecting a device) would only open a hardware-permission
    // escalation path with no upside.
    ses.setDevicePermissionHandler(() => false);
    ses.setPermissionCheckHandler(() => false);
    ses.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    ses.webRequest.onCompleted({ urls: ['http://*/*', 'https://*/*'] }, (details) => {
      recordNetworkEvent(details);
    });
    ses.webRequest.onErrorOccurred({ urls: ['http://*/*', 'https://*/*'] }, (details) => {
      recordNetworkEvent(details);
    });
    browserSessionConfigured = true;
  }

  function recordNetworkEvent(details) {
    const entry = [...listEntries()].find(
      (candidate) => safeWebContents(candidate.view)?.id === details.webContentsId,
    );
    if (!entry) return;
    entry.networkEvents.push({
      timestamp: Date.now(),
      method: String(details.method || 'GET').slice(0, 16),
      url: redactBrowserDiagnosticUrl(details.url),
      resourceType: details.resourceType ? String(details.resourceType) : undefined,
      status: Number.isFinite(details.statusCode) ? details.statusCode : undefined,
      error: details.error ? String(details.error).slice(0, 200) : undefined,
    });
    if (entry.networkEvents.length > 100) {
      entry.networkEvents.splice(0, entry.networkEvents.length - 100);
    }
  }

  function createEntry(browserSessionId) {
    return {
      browserSessionId,
      view: null,
      targetUrl: null,
      failedRestoreUrl: null,
      state: { designMode: false, pencilMode: false },
      attached: false,
      visible: true,
      windowAttached: false,
      hostWindow: null,
      idleTimer: null,
      loadingUrl: null,
      loadingPromise: null,
      viewport: { width: 1200, height: 800, deviceScaleFactor: 2 },
      networkEvents: [],
      consoleEvents: [],
      rendererCrashes: [],
      lastUsedAt: Date.now(),
      viewCloseReason: null,
      serialized: null,
    };
  }

  function attachView(entry) {
    if (isBrowserViewUsable(entry.view)) return entry;
    configureSession();
    const view = new WebContentsView({
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false,
        partition,
      },
    });
    entry.view = view;
    entry.viewCloseReason = null;
    const contents = view.webContents;
    contents.setWindowOpenHandler(({ url: nextUrl }) => {
      if (entry.view === view) loadUrl(entry, nextUrl);
      return { action: 'deny' };
    });
    contents.on('console-message', (details) => {
      entry.consoleEvents.push({
        timestamp: Date.now(),
        ...normalizeBrowserConsoleMessage(details),
      });
      if (entry.consoleEvents.length > 100) {
        entry.consoleEvents.splice(0, entry.consoleEvents.length - 100);
      }
    });
    contents.on('will-navigate', (_event, requestedUrl) => {
      if (entry.view !== view) return;
      // This event is limited to page/user-initiated navigations; programmatic
      // loadURL retries (including the HTTPS-to-HTTP fallback) do not emit it.
      entry.failedRestoreUrl = null;
      entry.targetUrl = requestedUrl;
    });
    contents.on('did-navigate', (_event, loadedUrl) => {
      if (entry.view !== view || urls.isChromeErrorUrl(loadedUrl)) return;
      entry.failedRestoreUrl = null;
      entry.targetUrl = loadedUrl;
      emitLoaded(entry, loadedUrl);
    });
    contents.on('did-finish-load', () => {
      const current = safeWebContents(view);
      if (entry.view !== view || !current) return;
      const loadedUrl = current.getURL();
      if (urls.isChromeErrorUrl(loadedUrl)) {
        if (entry.targetUrl && !urls.isChromeErrorUrl(entry.targetUrl))
          emitLoaded(entry, entry.targetUrl);
        return;
      }
      if (entry.state.designMode && entry.attached && entry.visible) {
        applyDesignState(entry);
      }
      void autofill(current);
    });
    contents.on('did-fail-load', (_event, errorCode, errorDescription, failedUrl, isMainFrame) => {
      if (entry.view !== view || !isMainFrame || errorCode === -3) return;
      const fallback = urls.httpFallbackUrl(failedUrl, errorCode);
      if (fallback) {
        urls.rememberFailedRestoreUrl(entry, entry.targetUrl || failedUrl);
        void loadUrl(entry, fallback, { force: true });
        return;
      }
      urls.rememberFailedRestoreUrl(entry, entry.targetUrl || failedUrl);
      emitLoadFailed(entry, failedUrl, errorDescription || `net error ${errorCode}`);
    });
    contents.on('dom-ready', () => {
      if (entry.view === view && entry.state.designMode && entry.attached && entry.visible) {
        applyDesignState(entry);
      }
    });
    contents.on('destroyed', () => {
      if (entry.view === view) {
        entry.view = null;
        entry.attached = false;
        entry.windowAttached = false;
        entry.hostWindow = null;
        onViewDestroyed(entry);
      }
    });
    contents.on('render-process-gone', (_event, details) => {
      if (entry.view === view) recoverRenderer(entry, view, details);
    });
    contents.on('did-navigate-in-page', (_event, nextUrl) => {
      if (entry.view !== view) return;
      entry.targetUrl = nextUrl;
      emitLoaded(entry, nextUrl);
      if (entry.state.designMode && entry.attached && entry.visible) {
        applyDesignState(entry);
      }
    });
    return entry;
  }

  function isBrowserViewUsable(view) {
    return Boolean(view && safeWebContents(view));
  }

  return { attachView, configureSession, createEntry };
}

module.exports = { createNativeBrowserViewFactory };
