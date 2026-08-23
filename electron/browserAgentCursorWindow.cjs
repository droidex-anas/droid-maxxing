function isUsableWindow(window) {
  try {
    return Boolean(window && !window.isDestroyed());
  } catch {
    return false;
  }
}

function requireUsableWindow(window) {
  if (!isUsableWindow(window) || typeof window.getContentBounds !== 'function') {
    throw new Error('Browser agent cursor requires a live host window.');
  }
  return window;
}

function canPresentOverlay(hostWindow) {
  if (!isUsableWindow(hostWindow)) return false;
  if (typeof hostWindow.isVisible === 'function' && !hostWindow.isVisible()) return false;
  if (typeof hostWindow.isFocused === 'function' && !hostWindow.isFocused()) return false;
  return true;
}

module.exports = { canPresentOverlay, isUsableWindow, requireUsableWindow };
