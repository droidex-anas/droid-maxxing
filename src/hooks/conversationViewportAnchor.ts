import type { FeedItem } from '../components/chat';

export interface ViewportAnchor {
  rowId: string;
  rowOffsetTop: number;
  scrollTop: number;
  scrollHeight: number;
}

export interface ViewportAnchorRestore {
  anchor: ViewportAnchor;
  didFindRow: boolean;
}

export function feedItemTailId(item: FeedItem): string {
  if (item.type === 'worked') {
    const tail = item.items.at(-1);
    return tail ? feedItemTailId(tail) : item.key;
  }
  if (item.type === 'tools' || item.type === 'child_sessions') {
    return item.events.at(-1)?.id ?? item.key;
  }
  if (item.type === 'diffs') {
    return item.changes.at(-1)?.event.id ?? item.key;
  }
  if (item.type === 'turnChanges') return item.tailEventId;
  return item.event.id;
}

// React keys preserve a group's component instance while live work appends, so
// composite keys intentionally start at the group's first event. Viewport
// anchoring has the opposite requirement during history prepend: an older page
// can extend that group backward, while its tail event remains unchanged.
export function feedRowId(item: FeedItem): string {
  return `${item.type}:${feedItemTailId(item)}`;
}

export function scrollTopForPreservedAnchor(
  captured: { scrollTop: number; rowOffsetTop: number },
  nextRowOffsetTop: number,
): number {
  return Math.max(0, captured.scrollTop + nextRowOffsetTop - captured.rowOffsetTop);
}

export function updateViewportAnchorGeometry(
  anchor: ViewportAnchor,
  rowOffsetTop: number,
  scrollTop: number,
  scrollHeight: number,
): ViewportAnchor {
  return {
    rowId: anchor.rowId,
    rowOffsetTop,
    scrollTop,
    scrollHeight,
  };
}

export function rowIntersectsViewport({
  viewportTop,
  viewportBottom,
  rowTop,
  rowBottom,
}: {
  viewportTop: number;
  viewportBottom: number;
  rowTop: number;
  rowBottom: number;
}): boolean {
  return rowBottom > viewportTop + 1 && rowTop < viewportBottom - 1;
}

function feedRows(element: HTMLDivElement): NodeListOf<HTMLElement> {
  return element.querySelectorAll<HTMLElement>('[data-feed-row-id]');
}

function rowNearViewportTop(element: HTMLDivElement): HTMLElement | null {
  const root = element.getBoundingClientRect();
  const x = root.left + root.width / 2;
  for (const offset of [1, 8, 24, 48, 96]) {
    const y = Math.min(root.bottom - 1, root.top + offset);
    for (const candidate of document.elementsFromPoint(x, y)) {
      const row = candidate.closest<HTMLElement>('[data-feed-row-id]');
      if (row && element.contains(row)) return row;
    }
  }
  return null;
}

function measureRowOffsetTop(element: HTMLDivElement, row: HTMLElement): number {
  return row.getBoundingClientRect().top - element.getBoundingClientRect().top;
}

export function captureViewportAnchor(
  element: HTMLDivElement,
  allowFullScan = false,
): ViewportAnchor | null {
  const visibleRow = rowNearViewportTop(element);
  const visibleRowId = visibleRow?.dataset.feedRowId;
  if (visibleRow && visibleRowId) {
    return {
      rowId: visibleRowId,
      rowOffsetTop: measureRowOffsetTop(element, visibleRow),
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
    };
  }
  if (!allowFullScan) return null;

  const rows = feedRows(element);
  const root = element.getBoundingClientRect();
  let fallback: HTMLElement | null = null;
  for (const row of rows) {
    const rect = row.getBoundingClientRect();
    if (rect.bottom <= root.top + 1) {
      fallback = row;
      continue;
    }
    if (
      rowIntersectsViewport({
        viewportTop: root.top,
        viewportBottom: root.bottom,
        rowTop: rect.top,
        rowBottom: rect.bottom,
      })
    ) {
      const rowId = row.dataset.feedRowId;
      if (!rowId) return null;
      return {
        rowId,
        rowOffsetTop: measureRowOffsetTop(element, row),
        scrollTop: element.scrollTop,
        scrollHeight: element.scrollHeight,
      };
    }
    if (rect.top >= root.bottom - 1) return null;
  }
  const rowId = fallback?.dataset.feedRowId;
  return fallback && rowId
    ? {
        rowId,
        rowOffsetTop: measureRowOffsetTop(element, fallback),
        scrollTop: element.scrollTop,
        scrollHeight: element.scrollHeight,
      }
    : null;
}

function findFeedRow(element: HTMLDivElement, rowId: string): HTMLElement | null {
  for (const row of feedRows(element)) {
    if (row.dataset.feedRowId === rowId) return row;
  }
  return null;
}

export function restoreViewportAnchor(
  element: HTMLDivElement,
  anchor: ViewportAnchor,
  allowHeightFallback = true,
): ViewportAnchorRestore {
  const row = findFeedRow(element, anchor.rowId);
  if (row) {
    const nextRowOffsetTop = measureRowOffsetTop(element, row);
    const nextScrollTop = scrollTopForPreservedAnchor(anchor, nextRowOffsetTop);
    if (Math.abs(element.scrollTop - nextScrollTop) > 0.5) element.scrollTop = nextScrollTop;
    return {
      anchor: updateViewportAnchorGeometry(
        anchor,
        measureRowOffsetTop(element, row),
        element.scrollTop,
        element.scrollHeight,
      ),
      didFindRow: true,
    };
  }

  if (allowHeightFallback) {
    const heightDelta = element.scrollHeight - anchor.scrollHeight;
    if (heightDelta !== 0) element.scrollTop = Math.max(0, anchor.scrollTop + heightDelta);
  }
  // Grouping can briefly replace the old row between React's commit and the
  // next layout frame. Keep its identity and desired viewport offset so a
  // follow-up frame can correct the coarse scrollHeight fallback precisely.
  return { anchor, didFindRow: false };
}

export function viewportAnchorAfterScroll({
  element,
  anchor,
  isPinned,
  isLoadingOlder,
  isRestoringViewport,
}: {
  element: HTMLDivElement;
  anchor: ViewportAnchor | null;
  isPinned: boolean;
  isLoadingOlder: boolean;
  isRestoringViewport: boolean;
}): ViewportAnchor | null {
  if (isPinned) return null;
  if (
    !shouldCaptureViewportAnchorAfterScroll({
      isPinned,
      isLoadingOlder,
      isRestoringViewport,
    })
  )
    return anchor;
  return captureViewportAnchor(element);
}

export function shouldCaptureViewportAnchorAfterScroll(options: {
  isPinned: boolean;
  isLoadingOlder: boolean;
  isRestoringViewport: boolean;
}): boolean {
  // A pending history request does not own the scroll position. Only active
  // restoration does, so genuine user movement selects a fresh row anchor.
  return !options.isPinned && !options.isRestoringViewport;
}

export function shouldCancelViewportRestore(
  expectedScrollTop: number | null,
  currentScrollTop: number,
): boolean {
  return expectedScrollTop !== null && Math.abs(currentScrollTop - expectedScrollTop) > 0.75;
}
