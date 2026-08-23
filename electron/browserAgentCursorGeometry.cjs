const CURSOR_VIEWBOX_SIZE = 32;
const CURSOR_VIEWBOX_HOTSPOT = Object.freeze({ x: 6, y: 4 });
const BROWSER_AGENT_CURSOR_DEFAULT_SIZE = 36;
const BROWSER_AGENT_CURSOR_MIN_SIZE = 24;
const BROWSER_AGENT_CURSOR_MAX_SIZE = 64;

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

module.exports = {
  BROWSER_AGENT_CURSOR_DEFAULT_SIZE,
  BROWSER_AGENT_CURSOR_MAX_SIZE,
  BROWSER_AGENT_CURSOR_MIN_SIZE,
  browserBoundsEqual,
  normalizeBrowserBounds,
  normalizePoint,
  pointInsideBounds,
  scaleCursorHotspot,
  validateBrowserAgentCursorSize,
};
