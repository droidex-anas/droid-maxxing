const BROWSER_AGENT_CURSOR_DEFAULT_STYLE = 'droidex';
const BROWSER_AGENT_CURSOR_STYLES = Object.freeze(['dark', 'light', 'droidex']);
const BROWSER_AGENT_CURSOR_DEFAULT_SIZE = 36;
const BROWSER_AGENT_CURSOR_MIN_SIZE = 24;
const BROWSER_AGENT_CURSOR_MAX_SIZE = 64;
const CURSOR_VIEWBOX_SIZE = 32;
const CURSOR_VIEWBOX_HOTSPOT = Object.freeze({ x: 6, y: 3 });
const BROWSER_AGENT_CURSOR_HOTSPOT = Object.freeze(
  scaleCursorHotspot(BROWSER_AGENT_CURSOR_DEFAULT_SIZE),
);
const CURSOR_VISIBLE_MS = 1_800;
const CURSOR_PRESENTATIONS = Object.freeze({
  dark: Object.freeze({
    fill: '#3b3b3b',
    fillOpacity: '1',
    stroke: '#ffffff',
    filter: 'drop-shadow(0 1px 1.5px rgba(0,0,0,.5))',
  }),
  light: Object.freeze({
    fill: '#ffffff',
    fillOpacity: '1',
    stroke: '#3b3b3b',
    filter: 'drop-shadow(0 1px 1.5px rgba(0,0,0,.5))',
  }),
  droidex: Object.freeze({
    fill: '#303743',
    fillOpacity: '.82',
    stroke: '#dce1eb',
    filter: 'drop-shadow(0 0 5px rgba(80,139,255,.75)) drop-shadow(0 0 12px rgba(80,139,255,.35))',
  }),
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
  let size = validateBrowserAgentCursorSize(options.size ?? BROWSER_AGENT_CURSOR_DEFAULT_SIZE);

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

    const shouldAnimate = current.visible && Boolean(current.point);
    current.point = point;
    current.visible = true;
    positionOverlay(window, current, shouldAnimate);
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

  function setSize(value) {
    const nextSize = validateBrowserAgentCursorSize(value);
    if (nextSize === size) return false;
    size = nextSize;
    if (!isUsableWindow(overlay)) return true;
    overlay.setSize(size, size, false);
    if (attachment?.visible && attachment.point) positionOverlay(overlay, attachment);
    return true;
  }

  function ensureOverlay(hostWindow) {
    if (isUsableWindow(overlay) && overlayHost === hostWindow) return overlay;
    destroyOverlay();

    const window = new options.BrowserWindow({
      width: size,
      height: size,
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

  function positionOverlay(window, current, animate = false) {
    if (!isUsableWindow(window) || !current.point) return;
    const contentBounds = current.hostWindow.getContentBounds();
    const hotspot = scaleCursorHotspot(size);
    window.setBounds(
      {
        x: Math.round(contentBounds.x + current.bounds.x + current.point.x - hotspot.x),
        y: Math.round(contentBounds.y + current.bounds.y + current.point.y - hotspot.y),
        width: size,
        height: size,
      },
      animate,
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

  return { attach, destroy, detach, hide, setBounds, setSize, setStyle, show };
}

function validateBrowserAgentCursorStyle(value) {
  if (!BROWSER_AGENT_CURSOR_STYLES.includes(value)) {
    throw new Error('Browser agent cursor style must be dark, light, or droidex.');
  }
  return value;
}

function validateBrowserAgentCursorSize(value) {
  if (
    !Number.isInteger(value) ||
    value < BROWSER_AGENT_CURSOR_MIN_SIZE ||
    value > BROWSER_AGENT_CURSOR_MAX_SIZE
  ) {
    throw new Error(
      `Browser agent cursor size must be an integer from ${BROWSER_AGENT_CURSOR_MIN_SIZE} to ${BROWSER_AGENT_CURSOR_MAX_SIZE} pixels.`,
    );
  }
  return value;
}

function scaleCursorHotspot(size) {
  return {
    x: Math.round((CURSOR_VIEWBOX_HOTSPOT.x / CURSOR_VIEWBOX_SIZE) * size),
    y: Math.round((CURSOR_VIEWBOX_HOTSPOT.y / CURSOR_VIEWBOX_SIZE) * size),
  };
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
  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}
.cursor{display:block;width:100%;height:100%;filter:${presentation.filter}}
</style>
</head>
<body><svg class="cursor" aria-hidden="true" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg"><path d="M6 3L27 23.7c.8.8.3 2.1-.9 2H19c-4 0-7.9 1.2-11.2 3.4l-2.3 1.5c-.9.6-2-.1-1.9-1.2L5 4.5C5.1 3.3 5.7 2.5 6 3Z" fill="${presentation.fill}" fill-opacity="${presentation.fillOpacity}" stroke="${presentation.stroke}" stroke-width="2" stroke-linejoin="round"/></svg></body>
</html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

module.exports = {
  BROWSER_AGENT_CURSOR_DEFAULT_SIZE,
  BROWSER_AGENT_CURSOR_DEFAULT_STYLE,
  BROWSER_AGENT_CURSOR_HOTSPOT,
  BROWSER_AGENT_CURSOR_MAX_SIZE,
  BROWSER_AGENT_CURSOR_MIN_SIZE,
  BROWSER_AGENT_CURSOR_STYLES,
  createBrowserAgentCursorController,
  createBrowserAgentCursorDataUrl,
  validateBrowserAgentCursorSize,
  validateBrowserAgentCursorStyle,
};
