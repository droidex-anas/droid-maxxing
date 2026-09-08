function createNativeBrowserViewFactory({
  WebContentsView,
  session,
  preloadPath,
  partition,
  normalizeBrowserConsoleMessage,
  redactBrowserDiagnosticUrl,
  urls,
  safeWebContents,
  browserSettings,
  navigation,
  cursor,
  credentials,
  loadUrl,
  emitLoaded,
  emitLoadFailed,
  applyDesignState,
  recoverRenderer,
  onViewDestroyed,
  listEntries,
}) {
  let browserSessionConfigured = false;

  function configureSession() {
    if (browserSessionConfigured) return;
    const browserSession = session.fromPartition(partition);
    browserSession.setDevicePermissionHandler(() => false);
    browserSession.setPermissionCheckHandler((contents, permission, requestingOrigin, details) =>
      browserSettings.canAccessPermission(contents, permission, requestingOrigin, details),
    );
    browserSession.setPermissionRequestHandler((contents, permission, callback, details) =>
      browserSettings.handlePermissionRequest(contents, permission, callback, details),
    );
    browserSession.on('will-download', (_event, item) => browserSettings.prepareDownload(item));
    browserSession.webRequest.onCompleted(
      { urls: ['http://*/*', 'https://*/*'] },
      recordNetworkEvent,
    );
    browserSession.webRequest.onErrorOccurred(
      { urls: ['http://*/*', 'https://*/*'] },
      recordNetworkEvent,
    );
    browserSessionConfigured = true;
  }

  function recordNetworkEvent(details) {
    if (!browserSettings.areDiagnosticsEnabled()) return;
    let entry;
    for (const candidate of listEntries()) {
      if (safeWebContents(candidate.view)?.id === details.webContentsId) {
        entry = candidate;
        break;
      }
    }
    if (!entry) return;
    entry.networkEvents.push({
      timestamp: Date.now(),
      method: String(details.method || 'GET').slice(0, 16),
      url: redactBrowserDiagnosticUrl(details.url),
      resourceType: details.resourceType ? String(details.resourceType) : undefined,
      status: Number.isFinite(details.statusCode) ? details.statusCode : undefined,
      error: details.error ? String(details.error).slice(0, 200) : undefined,
    });
    trimDiagnostics(entry.networkEvents);
  }

  function createEntry(browserSessionId) {
    return {
      browserSessionId,
      appSessionId: null,
      view: null,
      targetUrl: null,
      failedRestoreUrl: null,
      state: { designMode: false, pencilMode: false },
      attached: false,
      visible: true,
      agentCursorActive: false,
      windowAttached: false,
      hostWindow: null,
      idleTimer: null,
      loadingUrl: null,
      loadingPromise: null,
      viewport: { width: 1200, height: 800, deviceScaleFactor: 2 },
      networkEvents: [],
      consoleEvents: [],
      rendererCrashes: [],
      agentActionActive: false,
      userNavigationActive: false,
      agentRequest: null,
      navigationGeneration: 0,
      documentGeneration: 0,
      pendingAgentNavigation: null,
      trustedUserNavigation: null,
      approvedHistoryTransition: null,
      authenticationPopupCapability: null,
      captureActivityCount: 0,
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
        sandbox: true,
        backgroundThrottling: true,
        partition,
      },
    });
    entry.view = view;
    entry.viewCloseReason = null;
    installViewLifecycle(entry, view);
    return entry;
  }

  function installViewLifecycle(entry, view) {
    const contents = view.webContents;
    contents.setWindowOpenHandler(({ url }) => handleWindowOpen(entry, view, url));
    contents.on('did-create-window', (window) => credentials.hardenAuthenticationPopup(window));
    contents.on('console-message', (details) => recordConsoleEvent(entry, details));
    contents.on('will-navigate', (event, url) => handleNavigation(entry, view, event, url));
    contents.on('will-redirect', (event, url, _isInPlace, isMainFrame) => {
      if (isMainFrame) handleRedirect(entry, view, event, url);
    });
    contents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
      if (entry.view !== view || !isMainFrame) return;
      entry.documentGeneration += 1;
      if (isInPlace) {
        contents.send('native-browser-agent-snapshot-invalidated');
        return;
      }
      navigation.clearTrustedUserNavigation(entry);
      credentials.invalidate(entry);
      browserSettings.revokePermissionsForNavigation(contents);
    });
    contents.on('did-navigate', (_event, url) => {
      if (entry.view !== view || urls.isChromeErrorUrl(url)) return;
      entry.failedRestoreUrl = null;
      entry.targetUrl = url;
      emitLoaded(entry, url);
    });
    contents.on('did-finish-load', () => handleFinishedLoad(entry, view));
    contents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      if (entry.view !== view || !isMainFrame || code === -3) return;
      const fallback = urls.httpFallbackUrl(url, code);
      if (fallback) {
        urls.rememberFailedRestoreUrl(entry, entry.targetUrl || url);
        void loadUrl(entry, fallback, { force: true });
        return;
      }
      urls.rememberFailedRestoreUrl(entry, entry.targetUrl || url);
      emitLoadFailed(entry, url, description || `net error ${code}`);
    });
    contents.on('dom-ready', () => {
      if (entry.view === view && entry.state.designMode && entry.attached && entry.visible) {
        applyDesignState(entry);
      }
    });
    contents.on('destroyed', () => handleDestroyed(entry, view, contents));
    contents.on('render-process-gone', (_event, details) => {
      if (entry.view === view) recoverRenderer(entry, view, details);
    });
    contents.on('did-navigate-in-page', (_event, url) => {
      if (entry.view !== view) return;
      entry.targetUrl = url;
      emitLoaded(entry, url);
      if (entry.state.designMode && entry.attached && entry.visible) applyDesignState(entry);
    });
  }

  function handleWindowOpen(entry, view, url) {
    const authenticationPopup = credentials.allowAuthenticationPopup(entry, view, url);
    if (authenticationPopup) return authenticationPopup;
    try {
      urls.validateUrl(url);
      if (entry.view === view && navigation.authorizeTransition(entry, view, 'popup', url)) {
        void loadUrl(entry, url, { force: true });
      }
    } catch {
      // Popups stay inside the embedded browser and unsafe schemes fail closed.
    }
    return { action: 'deny' };
  }

  function handleNavigation(entry, view, event, url) {
    if (entry.view !== view) return;
    try {
      urls.validateUrl(url);
    } catch {
      event.preventDefault();
      return;
    }
    if (!navigation.authorizeTransition(entry, view, 'navigate', url)) {
      event.preventDefault();
      return;
    }
    entry.failedRestoreUrl = null;
    entry.targetUrl = url;
  }

  function handleRedirect(entry, view, event, url) {
    if (entry.view !== view) return;
    try {
      urls.validateUrl(url);
    } catch {
      event.preventDefault();
      return;
    }
    if (!navigation.authorizeTransition(entry, view, 'redirect', url)) {
      event.preventDefault();
    }
  }

  function recordConsoleEvent(entry, details) {
    if (!browserSettings.areDiagnosticsEnabled()) return;
    entry.consoleEvents.push({ timestamp: Date.now(), ...normalizeBrowserConsoleMessage(details) });
    trimDiagnostics(entry.consoleEvents);
  }

  function trimDiagnostics(events) {
    if (events.length > 100) events.splice(0, events.length - 100);
  }

  function handleFinishedLoad(entry, view) {
    const contents = safeWebContents(view);
    if (entry.view !== view || !contents) return;
    const url = contents.getURL();
    if (urls.isChromeErrorUrl(url)) return;
    if (entry.state.designMode && entry.attached && entry.visible) applyDesignState(entry);
  }

  function handleDestroyed(entry, view, contents) {
    if (entry.view !== view) return;
    cursor.detach(entry.browserSessionId);
    browserSettings.revokePermissionsForContents(contents);
    navigation.invalidate(entry);
    credentials.invalidate(entry);
    entry.view = null;
    entry.attached = false;
    entry.windowAttached = false;
    entry.hostWindow = null;
    onViewDestroyed(entry);
  }

  function isBrowserViewUsable(view) {
    return Boolean(view && safeWebContents(view));
  }

  return { attachView, configureSession, createEntry };
}

module.exports = { createNativeBrowserViewFactory };
