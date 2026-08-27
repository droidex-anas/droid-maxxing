import type { FeedItem } from './chat';
import { feedRowId } from '../hooks/conversationViewportAnchor';

export const CONVERSATION_LIST_OVERSCAN = 8;
export const CONVERSATION_LIST_ESTIMATE_PX = 96;
export const CONVERSATION_LIST_GAP_PX = 16;
// Twice the designed row gap: larger holes are missing or still-estimated rows, not spacing.
export const CONVERSATION_VISIBLE_HOLE_PX = CONVERSATION_LIST_GAP_PX * 2;
export const CONVERSATION_LIST_PIN_THRESHOLD_PX = 80;
// Pre-measure guess so the first window exists before the scroller is observed; a wrong size only changes overscan until measure.
export const CONVERSATION_LIST_INITIAL_RECT = { width: 720, height: 900 } as const;
// One viewport of already-mounted rows past the visible range. Today's 8-item
// overscan is 8 × (96+16) = 896 px at the estimate; keep that span in pixels
// so packing short rows cannot shrink coverage to a handful of 19 px slots.
export const CONVERSATION_OVERSCAN_PX = CONVERSATION_LIST_INITIAL_RECT.height;
// Visible short rows ≈ ceil(900/35) = 26. Cap overscan so 26 + 2×24 = 74 < 80.
export const CONVERSATION_LIST_OVERSCAN_MAX = 24;
const STRIDE_SAMPLE_LIMIT = 32;

export interface ConversationRowLookup {
  byMountKey: ReadonlyMap<string, number>;
  byViewportId: ReadonlyMap<string, number>;
}

export function conversationRowMountKey(item: FeedItem): string {
  return item.key;
}

export function conversationRowViewportId(item: FeedItem): string {
  return feedRowId(item);
}

export function estimatedListSize(count: number): number {
  if (count <= 0) return 0;
  return count * CONVERSATION_LIST_ESTIMATE_PX + Math.max(0, count - 1) * CONVERSATION_LIST_GAP_PX;
}

export function estimatedListEndOffset(
  count: number,
  viewportHeight: number = CONVERSATION_LIST_INITIAL_RECT.height,
): number {
  return Math.max(0, estimatedListSize(count) - viewportHeight);
}

export function isConversationAtLatest(
  scrollHeight: number,
  scrollTop: number,
  clientHeight: number,
  thresholdPx: number = CONVERSATION_LIST_PIN_THRESHOLD_PX,
): boolean {
  return scrollHeight - scrollTop - clientHeight < thresholdPx;
}

export function buildConversationRowLookup(items: readonly FeedItem[]): ConversationRowLookup {
  const byMountKey = new Map<string, number>();
  const byViewportId = new Map<string, number>();
  for (let index = 0; index < items.length; index += 1) {
    const item = items.at(index);
    if (!item) continue;
    byMountKey.set(item.key, index);
    byViewportId.set(feedRowId(item), index);
  }
  return { byMountKey, byViewportId };
}

export function findConversationRowIndex(
  lookup: ConversationRowLookup,
  rowId: string,
): number | undefined {
  return lookup.byViewportId.get(rowId) ?? lookup.byMountKey.get(rowId);
}

export function scrollMarginBetween(list: HTMLElement, scroll: HTMLElement): number {
  return list.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop;
}

export function measuredConversationRowSize(
  row: HTMLElement,
): { index: number; size: number } | null {
  const index = Number(row.dataset.index);
  if (!Number.isInteger(index) || index < 0) return null;
  return { index, size: Math.round(row.offsetHeight) };
}

export interface ConversationRowSizeChange {
  start: number;
  size: number;
  key: string | number | bigint;
}

export interface ConversationRowSizeChangeHost {
  isScrolling: boolean;
  scrollDirection: 'forward' | 'backward' | null;
  scrollAdjustments: number;
  itemSizeCache: { has: (key: string | number | bigint) => boolean };
  scrollOffset: number | null;
}

// Mirrors TanStack's default, except user-driven scroll: estimate→actual must
// not write scrollTop while the wheel already owns it.
export function shouldAdjustConversationRowOnSizeChange(
  item: ConversationRowSizeChange,
  _delta: number,
  instance: ConversationRowSizeChangeHost,
): boolean {
  if (instance.isScrolling) return false;
  const scrollOffsetWithAdj = (instance.scrollOffset ?? 0) + instance.scrollAdjustments;
  const isFirstMeasure = !instance.itemSizeCache.has(item.key);
  if (isFirstMeasure) return item.start < scrollOffsetWithAdj;
  return item.start + item.size <= scrollOffsetWithAdj && instance.scrollDirection !== 'backward';
}

export function conversationOverscanItems(options: {
  stridePx: number;
  overscanPx?: number;
  minItems?: number;
  maxItems?: number;
}): number {
  const overscanPx = options.overscanPx ?? CONVERSATION_OVERSCAN_PX;
  const minItems = options.minItems ?? CONVERSATION_LIST_OVERSCAN;
  const maxItems = options.maxItems ?? CONVERSATION_LIST_OVERSCAN_MAX;
  const stridePx = Math.max(1, options.stridePx);
  return Math.min(maxItems, Math.max(minItems, Math.round(overscanPx / stridePx)));
}

export function conversationRangeIndexes(
  range: { startIndex: number; endIndex: number; count: number },
  stridePx: number,
  overscanPx: number = CONVERSATION_OVERSCAN_PX,
): number[] {
  const overscan = conversationOverscanItems({ stridePx, overscanPx });
  const start = Math.max(range.startIndex - overscan, 0);
  const end = Math.min(range.endIndex + overscan, range.count - 1);
  const length = Math.max(0, end - start + 1);
  const indexes = new Array<number>(length);
  for (let index = 0; index < length; index += 1) indexes[index] = start + index;
  return indexes;
}

export function createConversationRowStride(): {
  observe: (sizePx: number) => void;
  stridePx: () => number;
} {
  const recent: number[] = [];
  const fallbackPx = CONVERSATION_LIST_ESTIMATE_PX + CONVERSATION_LIST_GAP_PX;
  let sumPx = 0;
  return {
    observe(sizePx: number) {
      if (sizePx <= 0) return;
      recent.push(sizePx);
      sumPx += sizePx;
      if (recent.length > STRIDE_SAMPLE_LIMIT) {
        sumPx -= recent.shift() ?? 0;
      }
    },
    stridePx() {
      return recent.length === 0 ? fallbackPx : sumPx / recent.length + CONVERSATION_LIST_GAP_PX;
    },
  };
}

export function syncMeasureConversationList(
  list: HTMLElement,
  resizeItem: (index: number, size: number) => void,
  cachedSize?: (index: number) => number | undefined,
): void {
  for (let node = list.firstElementChild; node; node = node.nextElementSibling) {
    const measured = measuredConversationRowSize(node as HTMLElement);
    if (!measured) continue;
    if (cachedSize?.(measured.index) === measured.size) continue;
    resizeItem(measured.index, measured.size);
  }
}

export function nearestOverflowParent(start: HTMLElement): HTMLElement | null {
  let node: HTMLElement | null = start.parentElement;
  while (node) {
    const overflowY =
      node.style.overflowY ||
      (typeof getComputedStyle === 'function' ? getComputedStyle(node).overflowY : '');
    if (overflowY === 'auto' || overflowY === 'scroll') return node;
    node = node.parentElement;
  }
  return null;
}

export function takeFeedRowEntrance(
  key: string,
  animateKeys: ReadonlySet<string>,
  enteredKeys: Set<string>,
): boolean {
  if (!animateKeys.has(key) || enteredKeys.has(key)) return false;
  enteredKeys.add(key);
  return true;
}
