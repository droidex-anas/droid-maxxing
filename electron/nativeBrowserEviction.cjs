const {
  restoreSerialized,
  CAPTURE_SCROLL_SCRIPT,
  restoreScrollScript,
} = require('./nativeBrowserBudget.cjs');
const { safeWebContents, isBrowserViewUsable } = require('./nativeBrowserHost.cjs');

const CAPTURE_SCROLL_TIMEOUT_MS = 2_000;

// A blocked renderer must not hold the view forever; a missing offset degrades to (0, 0).
function captureScroll(contents) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), CAPTURE_SCROLL_TIMEOUT_MS);
    const settle = (value) => {
      clearTimeout(timer);
      resolve(value);
    };
    contents.executeJavaScript(CAPTURE_SCROLL_SCRIPT, true).then(settle, () => settle(undefined));
  });
}

// Owns idle timers and asynchronous eviction/restore work. The manager retains
// session identity; eviction may release only the exact unused view it observed.
function createNativeBrowserEviction({ budget, entries, closeEntry, loadUrl, reportFailure }) {
  const uses = new WeakMap();
  const evictions = new Map();
  const restores = new Map();

  function clearIdle(entry) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
  }

  function touch(entry) {
    clearIdle(entry);
    uses.set(entry, (uses.get(entry) ?? 0) + 1);
    entry.lastUsedAt = Date.now();
  }

  function isActive(entry) {
    return Boolean(
      entry.agentActionActive ||
      entry.pendingAgentNavigation ||
      entry.userNavigationActive ||
      entry.captureActivityCount ||
      entry.loadingPromise ||
      restores.has(entry),
    );
  }

  function budgetEntries() {
    return [...entries()].map((entry) => ({
      browserSessionId: entry.browserSessionId,
      attached: entry.attached,
      active: isActive(entry),
      hasView: isBrowserViewUsable(entry.view),
      lastUsedAt: entry.lastUsedAt,
      serialized: entry.serialized,
    }));
  }

  function schedule(entry) {
    touch(entry);
    if (!entry.attached && budget.idleMs > 0) {
      entry.idleTimer = setTimeout(() => {
        void evict(entry).catch(reportEvictionFailure);
      }, budget.idleMs);
    }
    void enforce().catch(reportEvictionFailure);
  }

  async function enforce() {
    const targets = new Set(budget.idsToEvict(budgetEntries()));
    await Promise.all(
      [...entries()].filter((entry) => targets.has(entry.browserSessionId)).map(evict),
    );
  }

  function evict(entry) {
    if (entry.attached || isActive(entry) || !isBrowserViewUsable(entry.view)) {
      return Promise.resolve();
    }
    const pending = evictions.get(entry);
    if (pending) return pending;
    const view = entry.view;
    const contents = safeWebContents(view);
    const use = uses.get(entry);
    const generation = entry.documentGeneration;
    const operation = (async () => {
      const scroll = await captureScroll(contents);
      if (
        entry.view !== view ||
        contents.isDestroyed() ||
        entry.attached ||
        isActive(entry) ||
        uses.get(entry) !== use ||
        entry.documentGeneration !== generation
      )
        return;
      entry.serialized = budget.snapshotFrom(entry, {
        url: entry.loadingUrl || contents.getURL() || entry.targetUrl,
        scroll: Number.isFinite(scroll?.x) && Number.isFinite(scroll?.y) ? scroll : { x: 0, y: 0 },
      });
      entry.viewCloseReason = 'evict';
      closeEntry(entry, false);
    })().finally(() => {
      if (evictions.get(entry) === operation) evictions.delete(entry);
    });
    evictions.set(entry, operation);
    return operation;
  }

  function restore(entry) {
    if (!entry.serialized) return Promise.resolve(true);
    const pending = restores.get(entry);
    if (pending) return pending;
    const view = entry.view;
    const snapshot = entry.serialized;
    const isCurrent = () =>
      entry.view === view && entry.serialized === snapshot && isBrowserViewUsable(view);
    const operation = restoreSerialized(entry, {
      isCurrent,
      loadUrl: (target, url) => loadUrl(target, url, { force: true }),
      restoreScroll: async (_target, scroll) => {
        const contents = safeWebContents(view);
        if (!contents || !isCurrent()) return;
        try {
          await contents.executeJavaScript(restoreScrollScript(scroll), true);
        } catch {
          // Scroll position is best-effort; a live restored page beats failing the action.
        }
      },
      reportFailure: (target, url, error) => {
        reportFailure(target, url, error?.message || 'Browser restore failed.');
      },
      releaseFailedView: (target) => {
        target.viewCloseReason = 'restore-failed';
        closeEntry(target, false);
      },
    }).finally(() => {
      if (restores.get(entry) === operation) restores.delete(entry);
    });
    restores.set(entry, operation);
    return operation;
  }

  function evictUnattached() {
    return Promise.all([...entries()].map((entry) => evict(entry)));
  }

  function reportEvictionFailure(error) {
    console.error(`failed to release idle browser view: ${error.message}`);
  }

  return {
    touch,
    clearIdle,
    schedule,
    restore,
    evictUnattached,
    counts: () => budget.counts(budgetEntries()),
  };
}

module.exports = { createNativeBrowserEviction };
