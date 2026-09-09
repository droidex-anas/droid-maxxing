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
const { createNativeBrowserNavigation } = require('./nativeBrowserNavigation.cjs');
const { createNativeBrowserAgentActions } = require('./nativeBrowserAgentActions.cjs');
const { createNativeBrowserEviction } = require('./nativeBrowserEviction.cjs');
const { createNativeBrowserPageEvents } = require('./nativeBrowserPageEvents.cjs');
const { createNativeBrowserRecovery } = require('./nativeBrowserRecovery.cjs');
const { createNativeBrowserLayout } = require('./nativeBrowserLayout.cjs');
const interaction = require('./browserAgentInteraction.cjs');
const {
  browserTargetBeforeViewClose,
  chooseBrowserReload,
  chooseBrowserRestore,
  isExpectedSupersededLoad,
  userVisibleBrowserUrl,
} = require('./browserPageState.cjs');

// Browser sessions share authentication storage, not page/view identity.
const BROWSER_PARTITION = 'persist:droidex-browser';

function createNativeBrowserManager(options) {
  const nativeBrowsers = new Map();
  const urls = createNativeBrowserUrlPolicy({
    appName: options.appName,
    getHostAppUrl: options.getHostAppUrl,
  });
  const credentials = createNativeBrowserCredentials({
    browserSettings: options.browserSettings,
    partition: BROWSER_PARTITION,
    safeWebContents,
  });
  const navigation = createNativeBrowserNavigation({
    browserSettings: options.browserSettings,
    loadUrl: loadNativeBrowserUrl,
    safeWebContents,
  });
  const eviction = createNativeBrowserEviction({
    budget: options.budget,
    entries: () => nativeBrowsers.values(),
    closeEntry: closeNativeBrowserEntry,
    loadUrl: loadNativeBrowserUrl,
    reportFailure: emitNativeBrowserLoadFailed,
  });
  const viewHost = createNativeBrowserViewHost({
    BrowserWindow: options.BrowserWindow,
    getMainWindow: options.getMainWindow,
    listEntries: () => nativeBrowsers.values(),
  });
  const views = createNativeBrowserViewFactory({
    WebContentsView: options.WebContentsView,
    browserSettings: options.browserSettings,
    cursor: options.cursor,
    navigation,
    credentials,
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
    recoverRenderer: (entry, view, details) => recovery.recover(entry, view, details),
    onViewDestroyed: (entry) => layout.release(entry),
    listEntries: () => nativeBrowsers.values(),
  });
  const page = createNativeBrowserPage({
    appName: options.appName,
    ensureEntry: ensureNativeBrowserEntry,
    restoreForAction: restoreNativeBrowserForAction,
    safeWebContents,
    scheduleIdleClose: eviction.schedule,
    runWithWebContentsDebugger,
    findEntryForContents: findNativeBrowserEntryForWebContents,
  });

  const layout = createNativeBrowserLayout({
    appName: options.appName,
    getMainWindow: options.getMainWindow,
    findEntry: (id) => nativeBrowsers.get(id),
    ensureEntry: ensureNativeBrowserEntry,
    ensureView: ensureNativeBrowserView,
    restoreSnapshot: restoreBrowserSnapshot,
    viewHost,
    eviction,
    urls,
    cursor: options.cursor,
    applyDesignState: page.applyDesignState,
    loadUrl: loadNativeBrowserUrl,
    requireLoaded,
  });

  const actions = createNativeBrowserAgentActions({
    appName: options.appName,
    ensureView: ensureNativeBrowserView,
    getEntry: (id) => nativeBrowsers.get(urls.normalizeNativeBrowserSessionId(id)),
    restoreForAction: restoreNativeBrowserForAction,
    closeBrowser: closeNativeBrowser,
    openBrowser: openNativeBrowser,
    reloadBrowser: reloadNativeBrowser,
    resizeBrowser: (entry, viewport) => {
      entry.viewport = urls.normalizeBrowserViewport(viewport);
      if (!entry.attached) viewHost.setHiddenBounds(entry, entry.viewport);
    },
    page,
    navigation,
    credentials,
    browserSettings: options.browserSettings,
    cursor: options.cursor,
    interaction,
    safeWebContents,
    scheduleIdleClose: eviction.schedule,
  });

  const pageEvents = createNativeBrowserPageEvents({
    findEntryForContents: findNativeBrowserEntryForWebContents,
    page,
    credentials,
    navigation,
  });
  const recovery = createNativeBrowserRecovery({
    budget: options.budget,
    urls,
    findEntry: (id) => nativeBrowsers.get(id),
    closeEntry: closeNativeBrowserEntry,
    ensureView: ensureNativeBrowserView,
    loadUrl: loadNativeBrowserUrl,
    reportFailure: emitNativeBrowserLoadFailed,
    getAttachmentRevision: layout.revision,
    hostIsUsable: () => isUsableHost(options.getMainWindow()),
    mountRecovered: layout.mountRecovered,
  });

  function ensureNativeBrowserEntry(browserSessionId) {
    browserSessionId = urls.normalizeNativeBrowserSessionId(browserSessionId);
    let entry = nativeBrowsers.get(browserSessionId);
    if (!entry) {
      entry = views.createEntry(browserSessionId);
      nativeBrowsers.set(browserSessionId, entry);
    }
    eviction.touch(entry);
    return entry;
  }

  function ensureNativeBrowserView(browserSessionId) {
    const entry = ensureNativeBrowserEntry(browserSessionId);
    if (isBrowserViewUsable(entry.view)) return entry;
    const mainWindow = options.getMainWindow();
    if (!isUsableHost(mainWindow)) throw new Error(`${options.appName} window is not available.`);
    return views.attachView(entry);
  }

  async function openNativeBrowser(browserSessionId, url, viewport) {
    const entry = ensureNativeBrowserView(browserSessionId);
    entry.serialized = null;
    if (viewport) entry.viewport = urls.normalizeBrowserViewport(viewport);
    urls.rejectHostAppUrl(url);
    url = urls.normalizeNativeBrowserUrl(entry, url);
    if (url === 'about:blank' && !entry.targetUrl) url = options.browserSettings.homePage();
    urls.validateUrl(url);
    entry.failedRestoreUrl = null;
    if (!entry.attached) {
      viewHost.setHiddenBounds(entry, entry.viewport);
      viewHost.addHiddenView(entry);
    }
    const result = await loadNativeBrowserUrl(entry, url, { force: true });
    requireLoaded(result);
    eviction.schedule(entry);
  }

  function closeNativeBrowser(browserSessionId) {
    const entry = nativeBrowsers.get(urls.normalizeNativeBrowserSessionId(browserSessionId));
    if (entry) {
      layout.detach(browserSessionId);
      closeNativeBrowserEntry(entry, true);
    }
  }

  async function reloadNativeBrowser(browserSessionId) {
    const entry = nativeBrowsers.get(urls.normalizeNativeBrowserSessionId(browserSessionId));
    const contents = safeWebContents(entry?.view);
    if (!contents) throw new Error(`${options.appName} browser is not open.`);
    const reload = chooseBrowserReload({
      currentUrl: contents.getURL(),
      failedRestoreUrl: entry.failedRestoreUrl,
      loadingUrl: entry.loadingUrl,
      targetUrl: entry.targetUrl,
      homePage: options.browserSettings.homePage(),
    });
    entry.failedRestoreUrl = null;
    entry.targetUrl = reload.url;
    if (reload.kind === 'load') {
      requireLoaded(await loadNativeBrowserUrl(entry, reload.url, { force: true }));
    } else contents.reload();
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
      url: userVisibleBrowserUrl(url),
      canGoBack: history?.canGoBack() ?? false,
      canGoForward: history?.canGoForward() ?? false,
    });
  }

  function emitNativeBrowserLoadFailed(entry, url, error) {
    if (!isUsableHost(options.getMainWindow())) return;
    options.sendToRenderer('native-browser-load-failed', {
      browserSessionId: entry.browserSessionId,
      url: redactBrowserDiagnosticUrl(url),
      error,
    });
  }

  async function loadNativeBrowserUrl(entry, url, loadOptions = {}) {
    url = urls.normalizeNativeBrowserUrl(entry, url);
    urls.validateUrl(url);
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
        if (current !== contents || urls.isChromeErrorUrl(current.getURL())) return { ok: false };
        return { ok: true };
      })
      .catch((err) => {
        if (
          !contents.isDestroyed() &&
          isExpectedSupersededLoad({
            error: err,
            requestedUrl: url,
            targetUrl: entry.targetUrl,
            currentUrl: contents.getURL(),
          })
        )
          return { ok: true };
        if (entry.view?.webContents === contents && entry.targetUrl === url) entry.targetUrl = null;
        if (!contents.isDestroyed())
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
    if (entry.serialized) await restoreBrowserSnapshot(entry);
    if (!entry.attached) {
      viewHost.setHiddenBounds(entry, entry.viewport);
      viewHost.addHiddenView(entry);
    }
    const restoreUrl = chooseBrowserRestore({
      currentUrl: safeWebContents(entry.view)?.getURL(),
      targetUrl: entry.targetUrl,
      homePage: options.browserSettings.homePage(),
    });
    if (restoreUrl) requireLoaded(await loadNativeBrowserUrl(entry, restoreUrl));
    return entry;
  }

  function closeNativeBrowserEntry(entry, forget) {
    eviction.touch(entry);
    navigation.invalidate(entry);
    credentials.invalidate(entry);
    recovery.cancel(entry);
    const contents = safeWebContents(entry.view);
    const targetUrl = browserTargetBeforeViewClose({
      currentUrl: contents?.getURL(),
      loadingUrl: entry.loadingUrl,
      targetUrl: entry.targetUrl,
    });
    if (targetUrl) entry.targetUrl = targetUrl;
    entry.loadingPromise = null;
    entry.loadingUrl = null;
    if (forget) options.cursor.forget(entry.browserSessionId);
    else options.cursor.detach(entry.browserSessionId);
    if (contents) options.browserSettings.revokePermissionsForContents(contents);
    layout.release(entry);
    const view = entry.view;
    entry.view = null;
    entry.attached = false;
    viewHost.removeView(entry, view);
    if (contents) {
      try {
        contents.close({ waitForBeforeUnload: false });
      } catch {
        // Already destroyed by Electron window teardown.
      }
    }
    if (forget) nativeBrowsers.delete(entry.browserSessionId);
  }

  function closeAllNativeBrowsers() {
    for (const entry of [...nativeBrowsers.values()]) {
      closeNativeBrowserEntry(entry, true);
    }
    nativeBrowsers.clear();
    layout.invalidate();
    viewHost.close();
  }

  function nativeBrowserSessionIdForWebContents(contents) {
    return findNativeBrowserEntryForWebContents(contents)?.browserSessionId;
  }

  async function restoreBrowserSnapshot(entry) {
    if (!(await eviction.restore(entry)) || !isBrowserViewUsable(entry.view)) {
      throw new Error('DROIDEX Browser could not restore this page. Reload to retry.');
    }
  }

  function requireLoaded(result) {
    if (!result?.ok) throw result?.error ?? new Error('DROIDEX Browser could not load this page.');
  }

  function suspendAll() {
    layout.invalidate();
    for (const entry of nativeBrowsers.values()) closeNativeBrowserEntry(entry, false);
    viewHost.close();
  }

  function clearDiagnostics() {
    for (const entry of nativeBrowsers.values()) {
      entry.networkEvents.length = 0;
      entry.consoleEvents.length = 0;
    }
  }

  return {
    open: openNativeBrowser,
    attach: layout.attach,
    detach: layout.detach,
    setBounds: layout.setBounds,
    setVisible: layout.setVisible,
    close: closeNativeBrowser,
    reload: reloadNativeBrowser,
    navigateHistory: navigateNativeBrowserHistory,
    setDesignMode: page.setDesignMode,
    setPencilMode: page.setPencilMode,
    cancelAgentAction: actions.cancel,
    runAgentAction: actions.run,
    capture: page.capture,
    captureDesignSelection: page.captureDesignSelection,
    sessionIdForWebContents: nativeBrowserSessionIdForWebContents,
    closeAll: closeAllNativeBrowsers,
    suspendAll,
    clearDiagnostics,
    ...pageEvents,
    evictUnattached: () => {
      void eviction
        .evictUnattached()
        .catch((error) => console.error(`failed to release browser views: ${error.message}`));
    },
    resourceCounts: eviction.counts,
  };
}

module.exports = { createNativeBrowserManager, BROWSER_PARTITION };
