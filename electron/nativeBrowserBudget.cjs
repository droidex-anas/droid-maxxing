// Live WebContents budget for native browser sessions. Ownership of the
// views stays in main.cjs; this module only decides which hidden sessions
// may keep a live view and what to restore after an eviction.
//
// Destroying a WebContents does not clear persist:droidex-browser. Cookies,
// localStorage, and passkeys therefore survive eviction and come back on restore.

const DEFAULT_MAX_LIVE = 2;
const DEFAULT_IDLE_MS = 0;

function boundedInt(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function createNativeBrowserBudget(options = {}) {
  const maxLive = boundedInt(options.maxLive, DEFAULT_MAX_LIVE, 1, 16);
  const idleMs = boundedInt(options.idleMs, DEFAULT_IDLE_MS, 0, 24 * 60 * 60 * 1000);
  const now = options.now || Date.now;

  function snapshotFrom(entry, extras = {}) {
    return {
      url: extras.url || entry.targetUrl || null,
      scroll: extras.scroll || entry.serialized?.scroll || { x: 0, y: 0 },
      viewport: extras.viewport ||
        entry.viewport || { width: 1200, height: 800, deviceScaleFactor: 2 },
      state: extras.state || entry.state || { designMode: false, pencilMode: false },
      screenshot: extras.screenshot || entry.serialized?.screenshot || null,
      evictedAt: now(),
    };
  }

  function liveViewEntries(entries) {
    return entries.filter((entry) => entry.hasView && !entry.attached);
  }

  function warmHiddenId(entries) {
    let warm = null;
    let latest = Number.NEGATIVE_INFINITY;
    for (const entry of liveViewEntries(entries)) {
      const used = entry.lastUsedAt ?? 0;
      if (used >= latest) {
        latest = used;
        warm = entry.browserSessionId;
      }
    }
    return warm;
  }

  function idsToEvict(entries) {
    const attachedLive = entries.filter((entry) => entry.attached && entry.hasView).length;
    const hiddenLive = liveViewEntries(entries);
    const allowedHidden = Math.min(1, Math.max(0, maxLive - attachedLive));
    const warmId = allowedHidden > 0 ? warmHiddenId(entries) : null;
    return hiddenLive
      .filter((entry) => entry.browserSessionId !== warmId)
      .map((entry) => entry.browserSessionId);
  }

  function shouldIdleEvict(entry) {
    if (!entry || entry.attached || !entry.hasView) return false;
    if (idleMs <= 0) return false;
    const age = now() - (entry.lastUsedAt ?? 0);
    return age >= idleMs;
  }

  function counts(entries) {
    let live = 0;
    let attached = 0;
    let warm = 0;
    let serialized = 0;
    const warmId = warmHiddenId(entries);
    for (const entry of entries) {
      if (entry.attached && entry.hasView) {
        attached += 1;
        live += 1;
        continue;
      }
      if (entry.hasView) {
        live += 1;
        if (entry.browserSessionId === warmId) warm += 1;
        continue;
      }
      if (entry.serialized) serialized += 1;
    }
    return {
      total: entries.length,
      live,
      attached,
      warm,
      serialized,
      maxLive,
      idleMs,
    };
  }

  function isEvictionClose(reason) {
    return reason === 'evict';
  }

  return {
    maxLive,
    idleMs,
    snapshotFrom,
    idsToEvict,
    shouldIdleEvict,
    warmHiddenId,
    counts,
    isEvictionClose,
  };
}

const CAPTURE_SCROLL_SCRIPT = '(function(){return{x:window.scrollX||0,y:window.scrollY||0};})()';

function restoreScrollScript(scroll) {
  const x = Math.max(0, Math.round(Number(scroll?.x) || 0));
  const y = Math.max(0, Math.round(Number(scroll?.y) || 0));
  return `(function(){window.scrollTo(${String(x)},${String(y)});return{x:window.scrollX||0,y:window.scrollY||0};})()`;
}

module.exports = {
  createNativeBrowserBudget,
  CAPTURE_SCROLL_SCRIPT,
  restoreScrollScript,
  DEFAULT_MAX_LIVE,
  DEFAULT_IDLE_MS,
};
