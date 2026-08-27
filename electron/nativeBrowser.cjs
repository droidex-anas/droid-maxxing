const {
  restoreSerialized,
  CAPTURE_SCROLL_SCRIPT,
  restoreScrollScript,
} = require('./nativeBrowserBudget.cjs');
const {
  normalizeBrowserConsoleMessage,
  redactBrowserDiagnosticUrl,
} = require('./browserDiagnostics.cjs');
const { runWithWebContentsDebugger } = require('./nativeBrowserEmulation.cjs');
const {
  createNativeBrowserViewHost,
  isUsableHost,
  safeWebContents,
  isBrowserViewUsable,
} = require('./nativeBrowserHost.cjs');
const { createNativeBrowserUrlPolicy } = require('./nativeBrowserUrls.cjs');
const { createNativeBrowserCredentials } = require('./nativeBrowserCredentials.cjs');
const { createNativeBrowserPage } = require('./nativeBrowserPage.cjs');
const { createNativeBrowserViewFactory } = require('./nativeBrowserView.cjs');

// A single persistent partition keeps cookies, localStorage, and registered
// passkeys alive across reloads, dev-server restarts, and app restarts so the
// user does not have to sign in again every time.
const BROWSER_PARTITION = 'persist:droidex-browser';

function createNativeBrowserManager(options) {
  const nativeBrowsers = new Map();
  let attachedBrowserSessionId = null;
  const urls = createNativeBrowserUrlPolicy({
    appName: options.appName,
    getHostAppUrl: options.getHostAppUrl,
  });
  const credentials = createNativeBrowserCredentials({
    app: options.app,
    appName: options.appName,
    safeStorage: options.safeStorage,
    dialog: options.dialog,
    getMainWindow: options.getMainWindow,
  });
  const viewHost = createNativeBrowserViewHost({
    BrowserWindow: options.BrowserWindow,
    getMainWindow: options.getMainWindow,
    listEntries: () => nativeBrowsers.values(),
  });
  const views = createNativeBrowserViewFactory({
    WebContentsView: options.WebContentsView,
    session: options.session,
    preloadPath: options.preloadPath,
    partition: BROWSER_PARTITION,
    normalizeBrowserConsoleMessage,
    redactBrowserDiagnosticUrl,
    urls,
    safeWebContents,
    loadUrl: loadNativeBrowserUrl,
    emitLoaded: emitNativeBrowserLoaded,
    emitLoadFailed: emitNativeBrowserLoadFailed,
    applyDesignState: (entry) => page.applyDesignState(entry),
    autofill: (contents) => credentials.autofill(contents),
    recoverRenderer: recoverNativeBrowserRenderer,
    onViewDestroyed: (entry) => {
      if (attachedBrowserSessionId === entry.browserSessionId) attachedBrowserSessionId = null;
    },
    listEntries: () => nativeBrowsers.values(),
  });
  const page = createNativeBrowserPage({
    appName: options.appName,
    ensureEntry: ensureNativeBrowserEntry,
    restoreForAction: restoreNativeBrowserForAction,
    safeWebContents,
    scheduleIdleClose: scheduleNativeBrowserIdleClose,
    setHiddenBounds: viewHost.setHiddenBounds,
    normalizeBrowserViewport: urls.normalizeBrowserViewport,
    credentials,
    runWithWebContentsDebugger,
    findEntryForContents: findNativeBrowserEntryForWebContents,
  });

  function ensureNativeBrowserEntry(browserSessionId) {
    browserSessionId = urls.normalizeNativeBrowserSessionId(browserSessionId);
    let entry = nativeBrowsers.get(browserSessionId);
    if (!entry) {
      entry = views.createEntry(browserSessionId);
      nativeBrowsers.set(browserSessionId, entry);
    }
    clearNativeBrowserIdleTimer(entry);
    return entry;
  }

  function ensureNativeBrowserView(browserSessionId) {
    const entry = ensureNativeBrowserEntry(browserSessionId);
    if (isBrowserViewUsable(entry.view)) return entry;
    const mainWindow = options.getMainWindow();
    if (!isUsableHost(mainWindow)) throw new Error(`${options.appName} window is not available.`);
    return views.attachView(entry);
  }

  async function openNativeBrowser(browserSessionId, url, bounds, viewport) {
    const entry = ensureNativeBrowserView(browserSessionId);
    entry.serialized = null;
    entry.lastUsedAt = Date.now();
    if (viewport) entry.viewport = urls.normalizeBrowserViewport(viewport);
    urls.rejectHostAppUrl(url);
    url = urls.normalizeNativeBrowserUrl(entry, url);
    urls.validateUrl(url);
    entry.failedRestoreUrl = null;
    if (bounds) await attachNativeBrowser(entry.browserSessionId, bounds, { restore: false });
    else {
      viewHost.setHiddenBounds(entry, entry.viewport);
      viewHost.addHiddenView(entry);
    }
    await loadNativeBrowserUrl(entry, url, { force: true });
    scheduleNativeBrowserIdleClose(entry);
  }

  async function attachNativeBrowser(browserSessionId, bounds, attachOptions = {}) {
    const entry = ensureNativeBrowserView(browserSessionId);
    entry.lastUsedAt = Date.now();
    if (entry.serialized) await restoreNativeBrowserSerialized(entry);
    if (!isUsableHost(options.getMainWindow()))
      throw new Error(`${options.appName} window is not available.`);
    if (attachedBrowserSessionId && attachedBrowserSessionId !== entry.browserSessionId) {
      detachNativeBrowser(attachedBrowserSessionId);
    }
    const view = entry.view;
    if (!view) throw new Error(`${options.appName} browser is not open.`);
    viewHost.attachToMainWindow(entry);
    attachedBrowserSessionId = entry.browserSessionId;
    entry.attached = true;
    view.setBounds(urls.normalizeBounds(bounds));
    clearNativeBrowserIdleTimer(entry);
    if (entry.state.designMode) page.applyDesignState(entry);
    if (attachOptions.restore !== false) {
      const targetUrl =
        urls.restorableUrlForEntry(entry, entry.targetUrl) ??
        urls.restorableUrlForEntry(entry, attachOptions.restoreUrl);
      const currentUrl = safeWebContents(view)?.getURL() ?? '';
      if (
        targetUrl &&
        (!currentUrl || currentUrl === 'about:blank' || urls.isChromeErrorUrl(currentUrl))
      ) {
        urls.rejectHostAppUrl(targetUrl);
        urls.validateUrl(targetUrl);
        await loadNativeBrowserUrl(entry, targetUrl, { force: true });
      }
    }
  }

  function detachNativeBrowser(browserSessionId) {
    const targetBrowserSessionId = browserSessionId ?? attachedBrowserSessionId;
    if (!targetBrowserSessionId) return;
    const entry = nativeBrowsers.get(targetBrowserSessionId);
    if (!entry) return;
    if (attachedBrowserSessionId === targetBrowserSessionId) attachedBrowserSessionId = null;
    entry.attached = false;
    safeWebContents(entry.view)?.setBackgroundThrottling(true);
    viewHost.removeView(entry, entry.view);
    viewHost.setHiddenBounds(entry, entry.viewport);
    viewHost.addHiddenView(entry);
    scheduleNativeBrowserIdleClose(entry);
  }

  function setNativeBrowserBounds(browserSessionId, bounds) {
    const entry = nativeBrowsers.get(urls.normalizeNativeBrowserSessionId(browserSessionId));
    if (!entry?.attached || !isBrowserViewUsable(entry.view)) return;
    entry.view.setBounds(urls.normalizeBounds(bounds));
  }

  function setNativeBrowserVisible(browserSessionId, visible) {
    const entry = ensureNativeBrowserEntry(browserSessionId);
    entry.visible = Boolean(visible);
    if (!isBrowserViewUsable(entry.view) || !entry.attached) return;
    entry.view.setVisible(entry.visible);
    safeWebContents(entry.view)?.setBackgroundThrottling(!entry.visible);
  }

  function closeNativeBrowser(browserSessionId) {
    const entry = nativeBrowsers.get(urls.normalizeNativeBrowserSessionId(browserSessionId));
    if (entry) closeNativeBrowserEntry(entry, true);
  }

  function reloadNativeBrowser(browserSessionId) {
    const entry = nativeBrowsers.get(urls.normalizeNativeBrowserSessionId(browserSessionId));
    const contents = safeWebContents(entry?.view);
    if (!contents) throw new Error(`${options.appName} browser is not open.`);
    if (entry.failedRestoreUrl) {
      const retryUrl = entry.failedRestoreUrl;
      entry.failedRestoreUrl = null;
      return loadNativeBrowserUrl(entry, retryUrl, { force: true });
    }
    entry.targetUrl = contents.getURL();
    contents.reload();
  }

  function navigateNativeBrowserHistory(browserSessionId, direction) {
    const entry = nativeBrowsers.get(urls.normalizeNativeBrowserSessionId(browserSessionId));
    const contents = safeWebContents(entry?.view);
    if (!contents) throw new Error(`${options.appName} browser is not open.`);
    const history = contents.navigationHistory;
    if (!history) return false;
    if (direction === 'back') {
      if (!history.canGoBack()) return false;
      history.goBack();
    } else {
      if (!history.canGoForward()) return false;
      history.goForward();
    }
    return true;
  }

  function findNativeBrowserEntryForWebContents(contents) {
    for (const entry of nativeBrowsers.values()) {
      if (safeWebContents(entry.view) === contents) return entry;
    }
    return undefined;
  }

  function emitNativeBrowserLoaded(entry, url) {
    const mainWindow = options.getMainWindow();
    if (!isUsableHost(mainWindow)) return;
    const history = safeWebContents(entry.view)?.navigationHistory;
    options.sendToRenderer('native-browser-loaded', {
      browserSessionId: entry.browserSessionId,
      url,
      canGoBack: history?.canGoBack() ?? false,
      canGoForward: history?.canGoForward() ?? false,
    });
  }

  function emitNativeBrowserLoadFailed(entry, url, error) {
    if (!isUsableHost(options.getMainWindow())) return;
    options.sendToRenderer('native-browser-load-failed', {
      browserSessionId: entry.browserSessionId,
      url,
      error,
    });
  }

  async function loadNativeBrowserUrl(entry, url, loadOptions = {}) {
    url = urls.normalizeNativeBrowserUrl(entry, url);
    const contents = safeWebContents(entry.view);
    if (!contents) return { ok: false };
    if (url === 'about:blank' && contents.getURL() === 'about:blank') return { ok: true };
    if (!loadOptions.force && contents.getURL() === url) return { ok: true };
    if (entry.loadingUrl === url && entry.loadingPromise) return entry.loadingPromise;
    entry.targetUrl = url;
    const load = contents
      .loadURL(url)
      .then(() => {
        const current = safeWebContents(entry.view);
        if (!current || urls.isChromeErrorUrl(current.getURL())) return { ok: false };
        return { ok: true };
      })
      .catch((err) => {
        if (entry.targetUrl === url) entry.targetUrl = null;
        if (!contents.isDestroyed() && !urls.isLoadAbortError(err))
          console.error(`failed to load native browser URL: ${err.message}`);
        return { ok: false, error: err };
      })
      .finally(() => {
        if (entry.loadingPromise === load) {
          entry.loadingPromise = null;
          entry.loadingUrl = null;
        }
      });
    entry.loadingUrl = url;
    entry.loadingPromise = load;
    return load;
  }

  async function restoreNativeBrowserForAction(browserSessionId) {
    const entry = ensureNativeBrowserView(browserSessionId);
    if (entry.serialized) await restoreNativeBrowserSerialized(entry);
    if (!entry.attached) {
      viewHost.setHiddenBounds(entry, entry.viewport);
      viewHost.addHiddenView(entry);
    }
    if (entry.targetUrl && !entry.serialized) await loadNativeBrowserUrl(entry, entry.targetUrl);
    return entry;
  }

  function scheduleNativeBrowserIdleClose(entry) {
    if (!entry || entry.attached) return;
    entry.lastUsedAt = Date.now();
    clearNativeBrowserIdleTimer(entry);
    if (options.budget.idleMs > 0) {
      entry.idleTimer = setTimeout(() => {
        if (!entry.attached) void evictNativeBrowserView(entry);
      }, options.budget.idleMs);
    }
    void enforceNativeBrowserBudget();
  }

  function nativeBrowserBudgetEntries() {
    return [...nativeBrowsers.values()].map((entry) => ({
      browserSessionId: entry.browserSessionId,
      attached: entry.attached,
      hasView: isBrowserViewUsable(entry.view),
      lastUsedAt: entry.lastUsedAt,
      targetUrl: entry.targetUrl,
      viewport: entry.viewport,
      state: entry.state,
      serialized: entry.serialized,
    }));
  }

  async function enforceNativeBrowserBudget() {
    const ids = options.budget.idsToEvict(nativeBrowserBudgetEntries());
    for (const id of ids) {
      const entry = nativeBrowsers.get(id);
      if (entry) await evictNativeBrowserView(entry);
    }
  }

  async function captureNativeBrowserSnapshot(entry) {
    const contents = safeWebContents(entry.view);
    let scroll = entry.serialized?.scroll || { x: 0, y: 0 };
    let screenshot = null;
    if (contents) {
      const captured = await contents
        .executeJavaScript(CAPTURE_SCROLL_SCRIPT, true)
        .catch(() => null);
      if (captured && Number.isFinite(captured.x) && Number.isFinite(captured.y)) scroll = captured;
      const image = await contents.capturePage().catch(() => null);
      if (image && !image.isEmpty?.()) screenshot = image.toPNG().toString('base64');
    }
    return options.budget.snapshotFrom(entry, {
      url:
        urls.restorableUrlForEntry(entry, entry.targetUrl) || contents?.getURL() || entry.targetUrl,
      scroll,
      screenshot,
      viewport: entry.viewport,
      state: entry.state,
    });
  }

  async function evictNativeBrowserView(entry) {
    if (!entry || entry.attached || !isBrowserViewUsable(entry.view)) return;
    entry.viewCloseReason = 'evict';
    entry.serialized = await captureNativeBrowserSnapshot(entry);
    closeNativeBrowserEntry(entry, false);
  }

  async function restoreNativeBrowserSerialized(entry) {
    await restoreSerialized(entry, {
      loadUrl: (target, url) => loadNativeBrowserUrl(target, url, { force: true }),
      restoreScroll: async (target, scroll) => {
        const contents = safeWebContents(target.view);
        if (!contents) return;
        await contents.executeJavaScript(restoreScrollScript(scroll), true).catch(() => undefined);
      },
      reportFailure: (target, url, error) => {
        const message = error?.message || 'Navigation failed';
        console.error(`failed to restore native browser URL: ${message}`);
        emitNativeBrowserLoadFailed(target, url, message);
      },
      releaseFailedView: (target) => {
        if (!isBrowserViewUsable(target.view)) return;
        target.viewCloseReason = 'restore-failed';
        closeNativeBrowserEntry(target, false);
      },
    });
  }

  function clearNativeBrowserIdleTimer(entry) {
    if (!entry?.idleTimer) return;
    clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
  }

  function closeNativeBrowserEntry(entry, forget) {
    clearNativeBrowserIdleTimer(entry);
    if (attachedBrowserSessionId === entry.browserSessionId) attachedBrowserSessionId = null;
    const view = entry.view;
    entry.view = null;
    entry.attached = false;
    viewHost.removeView(entry, view);
    const contents = safeWebContents(view);
    if (contents) {
      try {
        contents.close({ waitForBeforeUnload: false });
      } catch {
        // Already destroyed by Electron window teardown.
      }
    }
    if (forget) nativeBrowsers.delete(entry.browserSessionId);
  }

  function recoverNativeBrowserRenderer(entry, view, details) {
    if (options.budget.isEvictionClose(entry.viewCloseReason)) return;
    const reason = String(details?.reason || 'unknown');
    const targetUrl = urls.restorableUrlForEntry(entry, entry.targetUrl);
    const wasAttached = entry.attached;
    const bounds = view.getBounds();
    const contents = safeWebContents(view);
    viewHost.removeView(entry, view);
    entry.view = null;
    entry.attached = false;
    entry.loadingUrl = null;
    entry.loadingPromise = null;
    if (attachedBrowserSessionId === entry.browserSessionId) attachedBrowserSessionId = null;
    contents?.close();
    if (reason === 'clean-exit') return;

    const now = Date.now();
    entry.rendererCrashes = entry.rendererCrashes.filter((timestamp) => now - timestamp < 30_000);
    entry.rendererCrashes.push(now);
    console.error(
      `Native browser renderer exited: browserSession=${entry.browserSessionId} reason=${reason} exitCode=${details?.exitCode}`,
    );
    emitNativeBrowserLoadFailed(
      entry,
      targetUrl ?? 'about:blank',
      `Browser renderer exited (${reason}).`,
    );
    if (entry.rendererCrashes.length >= 3) return;

    setTimeout(() => {
      if (
        !nativeBrowsers.has(entry.browserSessionId) ||
        entry.view ||
        !isUsableHost(options.getMainWindow())
      )
        return;
      try {
        ensureNativeBrowserView(entry.browserSessionId);
        if (wasAttached) {
          viewHost.attachToMainWindow(entry);
          entry.attached = true;
          attachedBrowserSessionId = entry.browserSessionId;
          entry.view.setBounds(bounds);
        } else {
          viewHost.setHiddenBounds(entry, entry.viewport);
          viewHost.addHiddenView(entry);
        }
        if (targetUrl) void loadNativeBrowserUrl(entry, targetUrl, { force: true });
      } catch (err) {
        console.error(`failed to recover native browser renderer: ${err.message}`);
      }
    }, 250);
  }

  function closeAllNativeBrowsers() {
    for (const entry of [...nativeBrowsers.values()]) {
      closeNativeBrowserEntry(entry, true);
    }
    nativeBrowsers.clear();
    attachedBrowserSessionId = null;
    viewHost.close();
  }

  function nativeBrowserSessionIdForWebContents(contents) {
    return findNativeBrowserEntryForWebContents(contents)?.browserSessionId;
  }

  function withNativeBrowserSession(event, payload) {
    return { ...payload, browserSessionId: nativeBrowserSessionIdForWebContents(event.sender) };
  }

  function evictUnattached() {
    for (const entry of nativeBrowsers.values()) {
      if (!entry.attached) void evictNativeBrowserView(entry);
    }
  }

  return {
    open: openNativeBrowser,
    attach: attachNativeBrowser,
    detach: detachNativeBrowser,
    setBounds: setNativeBrowserBounds,
    setVisible: setNativeBrowserVisible,
    close: closeNativeBrowser,
    reload: reloadNativeBrowser,
    goBack: (browserSessionId) => navigateNativeBrowserHistory(browserSessionId, 'back'),
    goForward: (browserSessionId) => navigateNativeBrowserHistory(browserSessionId, 'forward'),
    setDesignMode: page.setDesignMode,
    setPencilMode: page.setPencilMode,
    runAgentAction: page.runAgentAction,
    capture: page.capture,
    captureDesignSelection: page.captureDesignSelection,
    handleCredentialCapture: credentials.handleCapture,
    sessionIdForWebContents: nativeBrowserSessionIdForWebContents,
    withSession: withNativeBrowserSession,
    closeAll: closeAllNativeBrowsers,
    evictUnattached,
    resourceCounts: () => options.budget.counts(nativeBrowserBudgetEntries()),
  };
}

module.exports = { createNativeBrowserManager, BROWSER_PARTITION };
