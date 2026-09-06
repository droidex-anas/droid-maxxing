// Owns renderer crash limits and cancellable retries. Layout intent is captured
// before teardown, so a delayed recovery cannot steal a newly selected pane.
function createNativeBrowserRecovery({
  budget,
  urls,
  findEntry,
  closeEntry,
  ensureView,
  loadUrl,
  reportFailure,
  getAttachmentRevision,
  hostIsUsable,
  mountRecovered,
}) {
  const pending = new Map();

  function cancel(entry) {
    const timer = pending.get(entry);
    if (timer) clearTimeout(timer);
    pending.delete(entry);
  }

  function recover(entry, view, details) {
    if (entry.view !== view || budget.isEvictionClose(entry.viewCloseReason)) return;
    const reason = String(details?.reason || 'unknown');
    const targetUrl = urls.restorableUrlForEntry(entry, entry.targetUrl);
    const revision = getAttachmentRevision();
    const bounds = view.getBounds();
    closeEntry(entry, false);
    if (reason === 'clean-exit') return;
    const now = Date.now();
    entry.rendererCrashes = entry.rendererCrashes.filter((timestamp) => now - timestamp < 30_000);
    entry.rendererCrashes.push(now);
    console.error(
      `Native browser renderer exited: browserSession=${entry.browserSessionId} reason=${reason} exitCode=${details?.exitCode}`,
    );
    reportFailure(entry, targetUrl ?? 'about:blank', `Browser renderer exited (${reason}).`);
    if (entry.rendererCrashes.length >= 3) return;
    const timer = setTimeout(() => {
      if (pending.get(entry) !== timer) return;
      pending.delete(entry);
      if (findEntry(entry.browserSessionId) !== entry || entry.view || !hostIsUsable()) return;
      try {
        ensureView(entry.browserSessionId);
        mountRecovered(entry, bounds, revision);
        if (targetUrl) void loadUrl(entry, targetUrl, { force: true });
      } catch (error) {
        console.error(`failed to recover native browser renderer: ${error.message}`);
      }
    }, 250);
    pending.set(entry, timer);
  }

  return { recover, cancel };
}

module.exports = { createNativeBrowserRecovery };
