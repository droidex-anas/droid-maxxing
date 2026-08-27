import type { FeedItem } from './chat';
import { feedRowId } from '../hooks/conversationViewportAnchor';

export const CONVERSATION_LIST_OVERSCAN = 8;
export const CONVERSATION_LIST_ESTIMATE_PX = 96;
export const CONVERSATION_LIST_GAP_PX = 16;
export const CONVERSATION_LIST_PIN_THRESHOLD_PX = 80;
export const CONVERSATION_LIST_INITIAL_RECT = { width: 720, height: 900 } as const;

export interface ConversationVisibleRange {
  rowIds: readonly string[];
  nearRowIds: readonly string[];
}

export const EMPTY_CONVERSATION_VISIBLE_RANGE: ConversationVisibleRange = {
  rowIds: [],
  nearRowIds: [],
};

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

export function conversationVisibleRange(
  items: readonly FeedItem[],
  mountedIndexes: readonly number[],
  visibleStart: number,
  visibleEnd: number,
): ConversationVisibleRange {
  const rowIds: string[] = [];
  const nearRowIds: string[] = [];
  for (const index of mountedIndexes) {
    const item = items.at(index);
    if (!item) continue;
    const rowId = feedRowId(item);
    if (index >= visibleStart && index <= visibleEnd) rowIds.push(rowId);
    else nearRowIds.push(rowId);
  }
  return { rowIds, nearRowIds };
}

export function visibleRangeSignature(range: ConversationVisibleRange): string {
  return `${range.rowIds.join('\n')}\n--\n${range.nearRowIds.join('\n')}`;
}

export function scrollMarginBetween(list: HTMLElement, scroll: HTMLElement): number {
  return list.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop;
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
