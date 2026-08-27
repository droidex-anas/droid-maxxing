import type { FeedItem } from './chat';
import { feedRowId } from '../hooks/conversationViewportAnchor';

export const CONVERSATION_LIST_OVERSCAN = 8;
export const CONVERSATION_LIST_ESTIMATE_PX = 96;
export const CONVERSATION_LIST_GAP_PX = 16;
// Twice the designed row gap: larger holes are missing or still-estimated rows, not spacing.
export const CONVERSATION_VISIBLE_HOLE_PX = CONVERSATION_LIST_GAP_PX * 2;
export const CONVERSATION_LIST_PIN_THRESHOLD_PX = 80;
// Count-based overscan of 8 is only ~160px of short rows; keep this many mounted so a 1600px gentle burst stays premeasured.
export const CONVERSATION_LIST_MIN_WINDOW = 48;
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

export function conversationRangeExtractor(range: {
  startIndex: number;
  endIndex: number;
  overscan: number;
  count: number;
}): number[] {
  const visible = Math.max(0, range.endIndex - range.startIndex + 1);
  if (visible <= 0 || range.count <= 0) return [];
  const target = Math.min(
    range.count,
    Math.max(visible + 2 * range.overscan, CONVERSATION_LIST_MIN_WINDOW),
  );
  let start = range.startIndex;
  let end = range.endIndex;
  const takeBack = Math.min(start, Math.max(0, target - (end - start + 1)));
  start -= takeBack;
  const takeForward = Math.min(range.count - 1 - end, Math.max(0, target - (end - start + 1)));
  end += takeForward;
  const length = end - start + 1;
  const indexes = new Array<number>(length);
  for (let i = 0; i < length; i += 1) indexes[i] = start + i;
  return indexes;
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

export function syncMeasureConversationList(
  list: HTMLElement,
  resizeItem: (index: number, size: number) => void,
): void {
  for (let node = list.firstElementChild; node; node = node.nextElementSibling) {
    if (!(node instanceof HTMLElement)) continue;
    const measured = measuredConversationRowSize(node);
    if (!measured) continue;
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
