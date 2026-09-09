const {
  BROWSER_AGENT_CURSOR_DEFAULT_STYLE,
  BROWSER_AGENT_CURSOR_STYLES,
  CURSOR_GLOW_PADDING,
  createBrowserAgentCursorDataUrl,
  validateBrowserAgentCursorStyle,
} = require('./browserAgentCursorDocument.cjs');
const {
  BROWSER_AGENT_CURSOR_DEFAULT_SIZE,
  browserBoundsEqual,
  normalizeBrowserBounds,
  normalizePoint,
  pointInsideBounds,
  scaleCursorHotspot,
  validateBrowserAgentCursorSize,
} = require('./browserAgentCursorGeometry.cjs');
const { isUsableHost } = require('./nativeBrowserHost.cjs');

const CURSOR_FRAME_MS = 16;
const CURSOR_MIN_MOVE_MS = 160;
const CURSOR_MAX_MOVE_MS = 420;
function createBrowserAgentCursorController(options) {
  if (typeof options?.BrowserWindow !== 'function') {
    throw new Error('Browser agent cursor requires Electron BrowserWindow.');
  }

  let attachment = null;
  let generation = 0;
  let overlay = null;
  let overlayHost = null;
  let overlayHostListeners = null;
  let overlayReady = null;
  let movementGeneration = 0;
  let enabled = true;
  const parkedPoints = new Map();
  let style = validateBrowserAgentCursorStyle(options.style ?? BROWSER_AGENT_CURSOR_DEFAULT_STYLE);
  let size = validateBrowserAgentCursorSize(options.size ?? BROWSER_AGENT_CURSOR_DEFAULT_SIZE);

  function invalidate() {
    generation += 1;
    movementGeneration += 1;
  }

  // The overlay outlives awaits, so every resumed step re-checks that the
  // attachment, generation and overlay window it started with are still live.
  function isCurrentOverlay(expectedGeneration, window, current) {
    return (
      generation === expectedGeneration &&
      overlay === window &&
      (current === undefined || attachment === current)
    );
  }

  function attach(input) {
    const browserSessionId = normalizeBrowserSessionId(input?.browserSessionId);
    const hostWindow = requireUsableWindow(input?.hostWindow);
    const bounds = normalizeBrowserBounds(input?.bounds);
    if (attachment?.browserSessionId === browserSessionId && attachment.hostWindow === hostWindow) {
      if (browserBoundsEqual(attachment.bounds, bounds)) {
        void restoreOverlayForAttachment(attachment);
        return false;
      }
      attachment.bounds = bounds;
      if (attachment.visible && attachment.point) {
        if (!pointInsideBounds(attachment.point, bounds)) hide(browserSessionId);
        else if (attachment.overlayVisible) positionOverlay(overlay, attachment);
        else void restoreOverlayForAttachment(attachment);
      }
      return true;
    }
    invalidate();
    hideOverlay();
    const parkedPoint = parkedPoints.get(browserSessionId);
    const point = parkedPoint && pointInsideBounds(parkedPoint, bounds) ? parkedPoint : null;
    if (parkedPoint && !point) parkedPoints.delete(browserSessionId);
    attachment = {
      browserSessionId,
      hostWindow,
      bounds,
      point,
      visible: Boolean(point),
      overlayVisible: false,
    };
    ensureOverlay(hostWindow);
    void restoreOverlayForAttachment(attachment);
    return true;
  }

  function setBounds(browserSessionId, value) {
    if (!attachment || attachment.browserSessionId !== browserSessionId) return false;
    const bounds = normalizeBrowserBounds(value);
    if (browserBoundsEqual(attachment.bounds, bounds)) return true;
    invalidate();
    attachment.bounds = bounds;
    if (!attachment.visible || !attachment.point) return true;
    if (!pointInsideBounds(attachment.point, attachment.bounds)) {
      hide(browserSessionId);
      return false;
    }
    if (attachment.overlayVisible) positionOverlay(overlay, attachment);
    else void restoreOverlayForAttachment(attachment);
    return true;
  }

  async function show(input) {
    const current = attachment;
    if (!current || current.browserSessionId !== input?.browserSessionId) return false;
    const point = normalizePoint(input, current.bounds);
    if (!point || !isUsableHost(current.hostWindow)) return false;
    if (!enabled || !canPresentOverlay(current.hostWindow)) {
      movementGeneration += 1;
      current.point = point;
      current.visible = true;
      rememberPoint(current.browserSessionId, point);
      hideOverlay();
      return true;
    }
    const expectedGeneration = generation;
    const window = ensureOverlay(current.hostWindow);
    const ready = await overlayReady;
    if (
      !ready ||
      !isCurrentOverlay(expectedGeneration, window, current) ||
      !isUsableHost(window) ||
      !isUsableHost(current.hostWindow)
    ) {
      return false;
    }

    const startPoint = current.visible ? current.point : null;
    current.visible = true;
    if (!startPoint) {
      current.point = point;
      rememberPoint(current.browserSessionId, point);
      presentOverlay(window, current);
      return true;
    }
    presentOverlay(window, current);
    return moveOverlay(window, current, startPoint, point, expectedGeneration);
  }

  function hide(browserSessionId) {
    if (!attachment || attachment.browserSessionId !== browserSessionId) return false;
    invalidate();
    attachment.visible = false;
    attachment.point = null;
    parkedPoints.delete(browserSessionId);
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
    invalidate();
    hideOverlay();
    attachment = null;
    return true;
  }

  function park(input) {
    const browserSessionId = normalizeBrowserSessionId(input?.browserSessionId);
    const bounds = normalizeBrowserBounds(input?.bounds);
    const point = normalizePoint(input, bounds);
    if (!point) return false;
    rememberPoint(browserSessionId, point);
    if (attachment?.browserSessionId === browserSessionId) {
      if (!pointInsideBounds(point, attachment.bounds)) return true;
      attachment.point = point;
      attachment.visible = true;
      if (attachment.overlayVisible) positionOverlay(overlay, attachment);
    }
    return true;
  }

  function forget(browserSessionId) {
    if (browserSessionId === undefined) {
      invalidate();
      parkedPoints.clear();
      hideOverlay();
      attachment = null;
      return true;
    }
    const id = normalizeBrowserSessionId(browserSessionId);
    const forgotPoint = parkedPoints.delete(id);
    if (attachment?.browserSessionId !== id) return forgotPoint;
    invalidate();
    hideOverlay();
    attachment = null;
    return true;
  }

  function setEnabled(value) {
    const nextEnabled = Boolean(value);
    if (nextEnabled === enabled) return false;
    enabled = nextEnabled;
    movementGeneration += 1;
    if (!enabled) hideOverlay();
    else if (attachment) void restoreOverlayForAttachment(attachment);
    return true;
  }

  function destroy() {
    invalidate();
    attachment = null;
    parkedPoints.clear();
    destroyOverlay();
  }

  function setStyle(value) {
    const nextStyle = validateBrowserAgentCursorStyle(value);
    if (nextStyle === style) return false;
    style = nextStyle;
    invalidate();
    if (!isUsableHost(overlay)) return true;

    const window = overlay;
    overlayReady = loadCursorDocument(window, style);
    void restoreOverlayForAttachment(attachment);
    return true;
  }

  function setSize(value) {
    const nextSize = validateBrowserAgentCursorSize(value);
    if (nextSize === size) return false;
    size = nextSize;
    if (!isUsableHost(overlay)) return true;
    const dimension = cursorOverlayDimension(size);
    overlay.setSize(dimension, dimension, false);
    if (attachment?.overlayVisible && attachment.point) positionOverlay(overlay, attachment);
    return true;
  }

  function ensureOverlay(hostWindow) {
    if (isUsableHost(overlay) && overlayHost === hostWindow) return overlay;
    destroyOverlay();

    const window = new options.BrowserWindow({
      width: cursorOverlayDimension(size),
      height: cursorOverlayDimension(size),
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
    const onFocus = () => {
      if (overlayHost === hostWindow && attachment?.hostWindow === hostWindow) {
        void restoreOverlayForAttachment(attachment);
      }
    };
    const onBlur = () => {
      if (overlayHost === hostWindow) hideOverlay();
    };
    const onClosed = () => {
      if (overlayHost !== hostWindow) return;
      invalidate();
      if (attachment?.hostWindow === hostWindow) attachment = null;
      destroyOverlay();
    };
    hostWindow.on?.('focus', onFocus);
    hostWindow.on?.('blur', onBlur);
    hostWindow.once?.('closed', onClosed);
    overlayHostListeners = { hostWindow, onBlur, onClosed, onFocus };
    return window;
  }

  function loadCursorDocument(window, nextStyle) {
    const expectedGeneration = generation;
    return Promise.resolve(window.loadURL(createBrowserAgentCursorDataUrl(nextStyle))).then(
      () => true,
      (error) => {
        options.logError?.('Failed to load the browser agent cursor.', error);
        if (isCurrentOverlay(expectedGeneration, window)) destroyOverlay();
        return false;
      },
    );
  }

  async function moveOverlay(window, current, from, to, expectedGeneration) {
    if (from.x === to.x && from.y === to.y) {
      current.point = to;
      positionOverlay(window, current);
      return true;
    }
    const moveGeneration = ++movementGeneration;
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    const durationMs = Math.min(
      CURSOR_MAX_MOVE_MS,
      Math.max(CURSOR_MIN_MOVE_MS, Math.round(distance * 0.8)),
    );
    const frameCount = Math.max(2, Math.ceil(durationMs / CURSOR_FRAME_MS));
    const waitForFrame = options.waitForFrame ?? defaultWaitForFrame;
    for (let frame = 1; frame <= frameCount; frame += 1) {
      await waitForFrame(CURSOR_FRAME_MS);
      if (
        !isCurrentOverlay(expectedGeneration, window, current) ||
        movementGeneration !== moveGeneration ||
        !isUsableHost(window)
      ) {
        return false;
      }
      const progress = frame / frameCount;
      const eased =
        progress < 0.5 ? 4 * Math.pow(progress, 3) : 1 - Math.pow(-2 * progress + 2, 3) / 2;
      current.point = {
        x: Math.round(from.x + (to.x - from.x) * eased),
        y: Math.round(from.y + (to.y - from.y) * eased),
      };
      rememberPoint(current.browserSessionId, current.point);
      positionOverlay(window, current);
    }
    current.point = to;
    rememberPoint(current.browserSessionId, to);
    return true;
  }

  async function restoreOverlayForAttachment(current) {
    if (
      !current?.visible ||
      !current.point ||
      attachment !== current ||
      !enabled ||
      !canPresentOverlay(current.hostWindow)
    ) {
      return false;
    }
    const expectedGeneration = generation;
    const window = ensureOverlay(current.hostWindow);
    const ready = await overlayReady;
    if (
      !ready ||
      !isCurrentOverlay(expectedGeneration, window, current) ||
      !canPresentOverlay(current.hostWindow)
    ) {
      return false;
    }
    if (
      !current.visible ||
      !current.point ||
      !enabled ||
      !pointInsideBounds(current.point, current.bounds)
    ) {
      return false;
    }
    presentOverlay(window, current);
    return true;
  }

  function presentOverlay(window, current) {
    if (
      attachment !== current ||
      !current.visible ||
      !current.point ||
      !enabled ||
      !pointInsideBounds(current.point, current.bounds) ||
      !canPresentOverlay(current.hostWindow)
    ) {
      return false;
    }
    positionOverlay(window, current);
    if (!current.overlayVisible) {
      window.showInactive();
      current.overlayVisible = true;
    }
    return true;
  }

  function rememberPoint(browserSessionId, point) {
    parkedPoints.set(browserSessionId, { x: point.x, y: point.y });
  }

  function positionOverlay(window, current) {
    if (!isUsableHost(window) || !current.point) return;
    const contentBounds = current.hostWindow.getContentBounds();
    const hotspot = scaleCursorHotspot(size);
    const dimension = cursorOverlayDimension(size);
    window.setBounds(
      {
        x: Math.round(
          contentBounds.x + current.bounds.x + current.point.x - hotspot.x - CURSOR_GLOW_PADDING,
        ),
        y: Math.round(
          contentBounds.y + current.bounds.y + current.point.y - hotspot.y - CURSOR_GLOW_PADDING,
        ),
        width: dimension,
        height: dimension,
      },
      false,
    );
  }

  function hideOverlay() {
    if (attachment) attachment.overlayVisible = false;
    if (isUsableHost(overlay)) overlay.hide();
  }

  function destroyOverlay() {
    const window = overlay;
    const listeners = overlayHostListeners;
    if (attachment) attachment.overlayVisible = false;
    overlay = null;
    overlayHost = null;
    overlayHostListeners = null;
    overlayReady = null;
    listeners?.hostWindow.removeListener?.('focus', listeners.onFocus);
    listeners?.hostWindow.removeListener?.('blur', listeners.onBlur);
    listeners?.hostWindow.removeListener?.('closed', listeners.onClosed);
    if (isUsableHost(window)) window.destroy();
  }

  return {
    attach,
    destroy,
    detach,
    forget,
    hide,
    park,
    setBounds,
    setEnabled,
    setSize,
    setStyle,
    show,
  };
}

function cursorOverlayDimension(size) {
  return size + CURSOR_GLOW_PADDING * 2;
}

function requireUsableWindow(window) {
  if (!isUsableHost(window) || typeof window.getContentBounds !== 'function') {
    throw new Error('Browser agent cursor requires a live host window.');
  }
  return window;
}

function canPresentOverlay(hostWindow) {
  if (!isUsableHost(hostWindow)) return false;
  if (typeof hostWindow.isVisible === 'function' && !hostWindow.isVisible()) return false;
  return typeof hostWindow.isFocused !== 'function' || hostWindow.isFocused();
}

function defaultWaitForFrame(delayMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    timer.unref?.();
  });
}

function normalizeBrowserSessionId(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 256) {
    throw new Error('Browser agent cursor requires a browser session ID.');
  }
  return value;
}

module.exports = {
  BROWSER_AGENT_CURSOR_DEFAULT_SIZE,
  BROWSER_AGENT_CURSOR_DEFAULT_STYLE,
  BROWSER_AGENT_CURSOR_STYLES,
  createBrowserAgentCursorController,
  validateBrowserAgentCursorSize,
  validateBrowserAgentCursorStyle,
};
