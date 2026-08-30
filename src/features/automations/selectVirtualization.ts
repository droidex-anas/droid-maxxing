export const LARGE_LIST_THRESHOLD = 72;
export const VIRTUAL_ROW_HEIGHT = 38;
export const VIRTUAL_LIST_HEIGHT = 288;
export const VIRTUAL_OVERSCAN = 6;

export function virtualOptionWindow(
  count: number,
  scrollTop: number,
  viewportHeight = VIRTUAL_LIST_HEIGHT,
): { start: number; end: number; offset: number; totalHeight: number } {
  const visible = Math.ceil(viewportHeight / VIRTUAL_ROW_HEIGHT);
  const start = Math.max(0, Math.floor(scrollTop / VIRTUAL_ROW_HEIGHT) - VIRTUAL_OVERSCAN);
  const end = Math.min(count, start + visible + VIRTUAL_OVERSCAN * 2);
  return {
    start,
    end,
    offset: start * VIRTUAL_ROW_HEIGHT,
    totalHeight: count * VIRTUAL_ROW_HEIGHT,
  };
}
