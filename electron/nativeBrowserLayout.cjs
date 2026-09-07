const {
  isUsableHost,
  safeWebContents,
  isBrowserViewUsable,
  setBrowserViewBoundsIfChanged,
} = require('./nativeBrowserHost.cjs');

// Sole owner of renderer attachment intent, including leases across page restores.
function createNativeBrowserLayout({
  appName,
  getMainWindow,
  findEntry,
  ensureEntry,
  ensureView,
  restoreSnapshot,
  viewHost,
  eviction,
  urls,
  cursor,
  applyDesignState,
  loadUrl,
  requireLoaded,
}) {
  let attachedBrowserSessionId = null;
  let attachmentRevision = 0;
  let requestedAttachmentId = null;
  let requestedAttachmentBounds = null;

  async function attachNativeBrowser(browserSessionId, bounds, attachOptions = {}) {
    const revision = ++attachmentRevision;
    requestedAttachmentId = urls.normalizeNativeBrowserSessionId(browserSessionId);
    requestedAttachmentBounds = urls.normalizeBounds(bounds);
    const entry = ensureView(browserSessionId);
    const view = entry.view;
    if (entry.serialized) await restoreSnapshot(entry);
    if (
      attachmentRevision !== revision ||
      findEntry(entry.browserSessionId) !== entry ||
      entry.view !== view
    )
      return;
    if (!isUsableHost(getMainWindow())) throw new Error(`${appName} window is not available.`);
    if (attachedBrowserSessionId && attachedBrowserSessionId !== entry.browserSessionId) {
      detachNativeBrowser(attachedBrowserSessionId, false);
    }
    if (!view) throw new Error(`${appName} browser is not open.`);
    viewHost.attachToMainWindow(entry);
    attachedBrowserSessionId = entry.browserSessionId;
    entry.attached = true;
    setBrowserViewBoundsIfChanged(view, requestedAttachmentBounds);
    if (entry.visible && entry.agentCursorActive)
      cursor.attach({
        browserSessionId: entry.browserSessionId,
        hostWindow: getMainWindow(),
        bounds: requestedAttachmentBounds,
      });
    eviction.touch(entry);
    if (entry.state.designMode) applyDesignState(entry);
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
        requireLoaded(await loadUrl(entry, targetUrl, { force: true }));
      }
    }
  }

  function detachNativeBrowser(browserSessionId, invalidateAttachment = true) {
    const targetBrowserSessionId =
      browserSessionId ?? requestedAttachmentId ?? attachedBrowserSessionId;
    if (invalidateAttachment && requestedAttachmentId === targetBrowserSessionId) {
      attachmentRevision += 1;
      requestedAttachmentId = null;
      requestedAttachmentBounds = null;
    }
    if (!targetBrowserSessionId) return;
    const entry = findEntry(targetBrowserSessionId);
    if (!entry) return;
    if (attachedBrowserSessionId === targetBrowserSessionId) attachedBrowserSessionId = null;
    entry.attached = false;
    cursor.detach(entry.browserSessionId);
    safeWebContents(entry.view)?.setBackgroundThrottling(true);
    viewHost.removeView(entry, entry.view);
    viewHost.setHiddenBounds(entry, entry.viewport);
    viewHost.addHiddenView(entry);
    eviction.schedule(entry);
  }

  function setNativeBrowserBounds(browserSessionId, bounds) {
    const normalizedBrowserSessionId = urls.normalizeNativeBrowserSessionId(browserSessionId);
    const normalizedBounds = urls.normalizeBounds(bounds);
    if (requestedAttachmentId === normalizedBrowserSessionId) {
      requestedAttachmentBounds = normalizedBounds;
    }
    const entry = findEntry(normalizedBrowserSessionId);
    if (!entry?.attached || !isBrowserViewUsable(entry.view)) return;
    if (setBrowserViewBoundsIfChanged(entry.view, normalizedBounds)) {
      cursor.setBounds(entry.browserSessionId, normalizedBounds);
    }
  }

  function setNativeBrowserVisible(browserSessionId, visible, agentCursorActive) {
    const entry = ensureEntry(browserSessionId);
    entry.visible = Boolean(visible);
    entry.agentCursorActive = agentCursorActive === true;
    if (!entry.agentCursorActive) cursor.forget(entry.browserSessionId);
    if (!isBrowserViewUsable(entry.view) || !entry.attached) return;
    entry.view.setVisible(entry.visible);
    safeWebContents(entry.view)?.setBackgroundThrottling(!entry.visible);
    if (entry.visible && entry.agentCursorActive)
      cursor.attach({
        browserSessionId: entry.browserSessionId,
        hostWindow: getMainWindow(),
        bounds: entry.view.getBounds(),
      });
    else if (entry.agentCursorActive) cursor.detach(entry.browserSessionId);
  }

  function mountRecovered(entry, bounds, revision) {
    if (attachmentRevision === revision && requestedAttachmentId === entry.browserSessionId) {
      const recoveredBounds = requestedAttachmentBounds ?? bounds;
      viewHost.attachToMainWindow(entry);
      entry.attached = true;
      attachedBrowserSessionId = entry.browserSessionId;
      setBrowserViewBoundsIfChanged(entry.view, recoveredBounds);
      if (entry.visible && entry.agentCursorActive)
        cursor.attach({
          browserSessionId: entry.browserSessionId,
          hostWindow: getMainWindow(),
          bounds: recoveredBounds,
        });
    } else {
      viewHost.setHiddenBounds(entry, entry.viewport);
      viewHost.addHiddenView(entry);
      eviction.schedule(entry);
    }
  }

  function release(entry) {
    if (attachedBrowserSessionId === entry.browserSessionId) attachedBrowserSessionId = null;
  }

  function invalidate() {
    requestedAttachmentId = null;
    requestedAttachmentBounds = null;
    attachedBrowserSessionId = null;
    attachmentRevision += 1;
  }

  return {
    attach: attachNativeBrowser,
    detach: detachNativeBrowser,
    setBounds: setNativeBrowserBounds,
    setVisible: setNativeBrowserVisible,
    mountRecovered,
    release,
    invalidate,
    revision: () => attachmentRevision,
  };
}

module.exports = { createNativeBrowserLayout };
