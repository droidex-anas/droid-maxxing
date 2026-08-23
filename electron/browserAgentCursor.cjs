const BROWSER_AGENT_CURSOR_DEFAULT_STYLE = 'droidex';
const BROWSER_AGENT_CURSOR_STYLES = Object.freeze(['dark', 'light', 'droidex']);
const BROWSER_AGENT_CURSOR_HOTSPOT = Object.freeze({ x: 10, y: 8 });
const CURSOR_WINDOW_SIZE = 44;
const CURSOR_VISIBLE_MS = 1_800;
const CURSOR_PRESENTATIONS = Object.freeze({
  dark: Object.freeze({ fill: '#141517', stroke: '#f7f7f8', trails: false }),
  light: Object.freeze({ fill: '#f7f7f8', stroke: '#141517', trails: false }),
  droidex: Object.freeze({ fill: '#34383f', stroke: '#aeb4bd', trails: true }),
});

function createBrowserAgentCursorController(options) {
  if (typeof options?.BrowserWindow !== 'function') {
    throw new Error('Browser agent cursor requires Electron BrowserWindow.');
  }

  let attachment = null;
  let generation = 0;
  let overlay = null;
  let overlayHost = null;
  let overlayReady = null;
  let hideTimer = null;
  let style = validateBrowserAgentCursorStyle(options.style ?? BROWSER_AGENT_CURSOR_DEFAULT_STYLE);

  function attach(input) {
    const browserSessionId = normalizeBrowserSessionId(input?.browserSessionId);
    const hostWindow = requireUsableWindow(input?.hostWindow);
    const bounds = normalizeBrowserBounds(input?.bounds);
    if (
      attachment?.browserSessionId === browserSessionId &&
      attachment.hostWindow === hostWindow &&
      browserBoundsEqual(attachment.bounds, bounds)
    ) {
      return false;
    }
    generation += 1;
    hideOverlay();
    attachment = {
      browserSessionId,
      hostWindow,
      bounds,
      point: null,
      visible: false,
    };
    ensureOverlay(hostWindow);
    return true;
  }

  function setBounds(browserSessionId, value) {
    if (!attachment || attachment.browserSessionId !== browserSessionId) return false;
    attachment.bounds = normalizeBrowserBounds(value);
    if (!attachment.visible || !attachment.point) return true;
    if (!pointInsideBounds(attachment.point, attachment.bounds)) {
      hide(browserSessionId);
      return false;
    }
    positionOverlay(overlay, attachment);
    return true;
  }

  async function show(input) {
    const current = attachment;
    if (!current || current.browserSessionId !== input?.browserSessionId) return false;
    const point = normalizePoint(input, current.bounds);
    if (!point || !isUsableWindow(current.hostWindow)) return false;
    const expectedGeneration = generation;
    const window = ensureOverlay(current.hostWindow);
    const ready = await overlayReady;
    if (
      !ready ||
      attachment !== current ||
      generation !== expectedGeneration ||
      overlay !== window ||
      !isUsableWindow(window) ||
      !isUsableWindow(current.hostWindow)
    ) {
      return false;
    }

    current.point = point;
    current.visible = true;
    positionOverlay(window, current);
    window.showInactive();
    scheduleHide(current);
    return true;
  }

  function hide(browserSessionId) {
    if (!attachment || attachment.browserSessionId !== browserSessionId) return false;
    clearHideTimer();
    attachment.visible = false;
    attachment.point = null;
    hideOverlay();
    return true;
  }

  function detach(browserSessionId) {
    if (
      browserSessionId !== undefined &&
      attachment &&
      attachment.browserSessionId !== browserSessionId
    ) {
      return false;
    }
    generation += 1;
    hideOverlay();
    attachment = null;
    return true;
  }

  function destroy() {
    generation += 1;
    attachment = null;
    destroyOverlay();
  }

  function setStyle(value) {
    const nextStyle = validateBrowserAgentCursorStyle(value);
    if (nextStyle === style) return false;
    style = nextStyle;
    generation += 1;
    if (!isUsableWindow(overlay)) return true;

    const window = overlay;
    overlayReady = loadCursorDocument(window, style);
    return true;
  }

  function ensureOverlay(hostWindow) {
    if (isUsableWindow(overlay) && overlayHost === hostWindow) return overlay;
    destroyOverlay();

    const window = new options.BrowserWindow({
      width: CURSOR_WINDOW_SIZE,
      height: CURSOR_WINDOW_SIZE,
      parent: hostWindow,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      focusable: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        devTools: false,
      },
    });
    window.setIgnoreMouseEvents(true, { forward: true });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    overlay = window;
    overlayHost = hostWindow;
    overlayReady = loadCursorDocument(window, style);
    hostWindow.once?.('closed', () => {
      if (overlayHost === hostWindow) destroyOverlay();
    });
    return window;
  }

  function loadCursorDocument(window, nextStyle) {
    const expectedGeneration = generation;
    return Promise.resolve(window.loadURL(createBrowserAgentCursorDataUrl(nextStyle))).then(
      () => true,
      (error) => {
        options.logError?.('Failed to load the browser agent cursor.', error);
        if (overlay === window && generation === expectedGeneration) destroyOverlay();
        return false;
      },
    );
  }

  function positionOverlay(window, current) {
    if (!isUsableWindow(window) || !current.point) return;
    const contentBounds = current.hostWindow.getContentBounds();
    window.setBounds(
      {
        x: Math.round(
          contentBounds.x + current.bounds.x + current.point.x - BROWSER_AGENT_CURSOR_HOTSPOT.x,
        ),
        y: Math.round(
          contentBounds.y + current.bounds.y + current.point.y - BROWSER_AGENT_CURSOR_HOTSPOT.y,
        ),
        width: CURSOR_WINDOW_SIZE,
        height: CURSOR_WINDOW_SIZE,
      },
      false,
    );
  }

  function scheduleHide(current) {
    clearHideTimer();
    const schedule = options.setTimeout ?? setTimeout;
    hideTimer = schedule(() => {
      hideTimer = null;
      if (attachment === current) hide(current.browserSessionId);
    }, CURSOR_VISIBLE_MS);
    hideTimer?.unref?.();
  }

  function clearHideTimer() {
    if (!hideTimer) return;
    (options.clearTimeout ?? clearTimeout)(hideTimer);
    hideTimer = null;
  }

  function hideOverlay() {
    if (isUsableWindow(overlay)) overlay.hide();
  }

  function destroyOverlay() {
    clearHideTimer();
    const window = overlay;
    overlay = null;
    overlayHost = null;
    overlayReady = null;
    if (isUsableWindow(window)) window.destroy();
  }

  return { attach, destroy, detach, hide, setBounds, setStyle, show };
}

function validateBrowserAgentCursorStyle(value) {
  if (!BROWSER_AGENT_CURSOR_STYLES.includes(value)) {
    throw new Error('Browser agent cursor style must be dark, light, or droidex.');
  }
  return value;
}

function normalizeBrowserSessionId(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 256) {
    throw new Error('Browser agent cursor requires a browser session ID.');
  }
  return value;
}

function requireUsableWindow(window) {
  if (!isUsableWindow(window) || typeof window.getContentBounds !== 'function') {
    throw new Error('Browser agent cursor requires a live host window.');
  }
  return window;
}

function isUsableWindow(window) {
  try {
    return Boolean(window && !window.isDestroyed());
  } catch {
    return false;
  }
}

function normalizeBrowserBounds(value) {
  const bounds = {
    x: Number(value?.x),
    y: Number(value?.y),
    width: Number(value?.width),
    height: Number(value?.height),
  };
  if (
    !Number.isFinite(bounds.x) ||
    !Number.isFinite(bounds.y) ||
    !Number.isFinite(bounds.width) ||
    !Number.isFinite(bounds.height) ||
    bounds.width < 1 ||
    bounds.height < 1
  ) {
    throw new Error('Browser agent cursor requires finite, positive browser bounds.');
  }
  return {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height),
  };
}

function normalizePoint(value, bounds) {
  const point = { x: Number(value?.x), y: Number(value?.y) };
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return undefined;
  point.x = Math.round(point.x);
  point.y = Math.round(point.y);
  return pointInsideBounds(point, bounds) ? point : undefined;
}

function pointInsideBounds(point, bounds) {
  return point.x >= 0 && point.y >= 0 && point.x < bounds.width && point.y < bounds.height;
}

function browserBoundsEqual(left, right) {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}

function createBrowserAgentCursorDataUrl(value) {
  const style = validateBrowserAgentCursorStyle(value);
  const presentation = CURSOR_PRESENTATIONS[style];
  const trails = presentation.trails
    ? '<path class="agent-trail agent-trail-far" d="M10 8v25.6l6.8-6.4 4.8 10.2 5.7-2.7-4.8-9.9h9.6L10 8Z" transform="translate(6 2)" fill="none" stroke="#777d86" stroke-width="1.5" stroke-linejoin="round"/><path class="agent-trail agent-trail-near" d="M10 8v25.6l6.8-6.4 4.8 10.2 5.7-2.7-4.8-9.9h9.6L10 8Z" transform="translate(3 1)" fill="none" stroke="#9298a1" stroke-width="1.6" stroke-linejoin="round"/>'
    : '';
  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>
html,body{margin:0;width:44px;height:44px;overflow:hidden;background:transparent}
.cursor{width:44px;height:44px;filter:drop-shadow(0 1px 2px rgba(0,0,0,.5))}
.agent-trail{animation:agent-working 1.1s ease-in-out infinite}
.agent-trail-far{opacity:.2}.agent-trail-near{opacity:.42;animation-delay:-.2s}
@keyframes agent-working{0%,100%{opacity:.18}50%{opacity:.58}}
@media (prefers-reduced-motion:reduce){.agent-trail{animation:none}}
</style>
</head>
<body><svg class="cursor" aria-hidden="true" viewBox="0 0 44 44" xmlns="http://www.w3.org/2000/svg">${trails}<path d="M10 8v25.6l6.8-6.4 4.8 10.2 5.7-2.7-4.8-9.9h9.6L10 8Z" fill="${presentation.fill}" stroke="${presentation.stroke}" stroke-width="2" stroke-linejoin="round"/></svg></body>
</html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

module.exports = {
  BROWSER_AGENT_CURSOR_DEFAULT_STYLE,
  BROWSER_AGENT_CURSOR_HOTSPOT,
  BROWSER_AGENT_CURSOR_STYLES,
  createBrowserAgentCursorController,
  createBrowserAgentCursorDataUrl,
  validateBrowserAgentCursorStyle,
};
