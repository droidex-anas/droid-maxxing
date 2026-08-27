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

const ESTIMATE_SAMPLE_LIMIT = 32;
const ESTIMATE_NEIGHBOR_DISTANCE = 32;

export function conversationRowEstimateKind(item: FeedItem | undefined): string {
  if (!item) return 'unknown';
  if (item.type === 'message') return item.event.author === 'user' ? 'user' : 'assistant';
  return item.type;
}

export function createConversationRowSizeEstimator(): {
  observe: (sizePx: number, kind?: string) => void;
  guess: (kind?: string) => number;
} {
  const recent: number[] = [];
  const byKind = new Map<string, number[]>();
  let medianPx = CONVERSATION_LIST_ESTIMATE_PX;
  let samples = 0;

  const medianOf = (values: readonly number[]): number => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] ?? CONVERSATION_LIST_ESTIMATE_PX;
  };

  return {
    observe(sizePx: number, kind?: string) {
      if (sizePx <= 0) return;
      recent.push(sizePx);
      if (recent.length > ESTIMATE_SAMPLE_LIMIT) recent.shift();
      samples += 1;
      medianPx = medianOf(recent);
      if (!kind) return;
      const bucket = byKind.get(kind) ?? [];
      bucket.push(sizePx);
      if (bucket.length > ESTIMATE_SAMPLE_LIMIT) bucket.shift();
      byKind.set(kind, bucket);
    },
    guess(kind?: string) {
      if (kind) {
        const bucket = byKind.get(kind);
        if (bucket && bucket.length > 0) return medianOf(bucket);
      }
      return samples === 0 ? CONVERSATION_LIST_ESTIMATE_PX : medianPx;
    },
  };
}

export function nearestMeasuredRowSize(
  index: number,
  getKey: (index: number) => string | number | bigint,
  measuredSize: (key: string | number | bigint) => number | undefined,
  maxDistance: number = ESTIMATE_NEIGHBOR_DISTANCE,
  sameKind?: (index: number) => boolean,
): number | undefined {
  for (let distance = 1; distance <= maxDistance; distance += 1) {
    const afterIndex = index + distance;
    if (!sameKind || sameKind(afterIndex)) {
      const after = measuredSize(getKey(afterIndex));
      if (typeof after === 'number') return after;
    }
    if (index >= distance) {
      const beforeIndex = index - distance;
      if (!sameKind || sameKind(beforeIndex)) {
        const before = measuredSize(getKey(beforeIndex));
        if (typeof before === 'number') return before;
      }
    }
  }
  return undefined;
}

export function conversationRowEstimateNear(
  index: number,
  range: { startIndex: number; endIndex: number } | null,
  overscan: number,
): boolean {
  if (range == null) return false;
  const pad = Math.max(overscan * 2, ESTIMATE_NEIGHBOR_DISTANCE);
  return index >= range.startIndex - pad && index <= range.endIndex + pad;
}

export function conversationRowEstimatePx(options: {
  index: number;
  range: { startIndex: number; endIndex: number } | null;
  overscan: number;
  fallbackPx: number;
  guessPx: number;
  measuredNearPx: number | undefined;
}): number {
  if (!conversationRowEstimateNear(options.index, options.range, options.overscan)) {
    return options.fallbackPx;
  }
  return options.measuredNearPx ?? options.guessPx;
}

export function stampConversationRowEstimates(
  indexes: readonly number[],
  getKey: (index: number) => string | number | bigint,
  itemSizeCache: { has: (key: string | number | bigint) => boolean },
  resizeItem: (index: number, size: number) => void,
  guessForIndex: (index: number) => number,
): void {
  for (const index of indexes) {
    const key = getKey(index);
    if (itemSizeCache.has(key)) continue;
    const guessPx = guessForIndex(index);
    if (guessPx === CONVERSATION_LIST_ESTIMATE_PX) continue;
    resizeItem(index, guessPx);
    return;
  }
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
