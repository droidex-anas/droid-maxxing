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

export interface ConversationViewportLayout {
  rowContentOffset(rowId: string): number | undefined;
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
  const rowType = item.type === 'diffs' ? 'diff' : item.type;
  return `${rowType}:${feedItemTailId(item)}`;
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

/** Return the first vertically ordered row whose bottom is below the viewport top. */
export function firstRowNotAboveViewport(
  rowCount: number,
  rowBottomAt: (index: number) => number,
  viewportTop: number,
): number {
  let low = 0;
  let high = rowCount;
  const cutoff = viewportTop + 1;

  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (rowBottomAt(middle) <= cutoff) low = middle + 1;
    else high = middle;
  }

  return low;
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
  if (!allowFullScan) {
    const visibleRow = rowNearViewportTop(element);
    const visibleRowId = visibleRow?.dataset.feedRowId;
    return visibleRow && visibleRowId
      ? {
          rowId: visibleRowId,
          rowOffsetTop: measureRowOffsetTop(element, visibleRow),
          scrollTop: element.scrollTop,
          scrollHeight: element.scrollHeight,
        }
      : null;
  }

  const rows = feedRows(element);
  const root = element.getBoundingClientRect();
  const visibleIndex = firstRowNotAboveViewport(
    rows.length,
    (index) => rows[index].getBoundingClientRect().bottom,
    root.top,
  );
  if (visibleIndex < rows.length) {
    const row = rows[visibleIndex];
    const rect = row.getBoundingClientRect();
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
        rowOffsetTop: rect.top - root.top,
        scrollTop: element.scrollTop,
        scrollHeight: element.scrollHeight,
      };
    }
    return null;
  }

  if (rows.length === 0) return null;
  const fallback = rows[rows.length - 1];
  const rowId = fallback.dataset.feedRowId;
  return rowId
    ? {
        rowId,
        rowOffsetTop: fallback.getBoundingClientRect().top - root.top,
        scrollTop: element.scrollTop,
        scrollHeight: element.scrollHeight,
      }
    : null;
}

function findFeedRow(element: HTMLDivElement, rowId: string): HTMLElement | null {
  const escape = (globalThis as { CSS?: { escape?: (value: string) => string } }).CSS?.escape;
  if (escape) {
    return element.querySelector<HTMLElement>(`[data-feed-row-id="${escape(rowId)}"]`);
  }

  // CSS.escape is unavailable in Node-based tests and older DOM shims.
  for (const row of feedRows(element)) {
    if (row.dataset.feedRowId === rowId) return row;
  }
  return null;
}

export function restoreViewportAnchor(
  element: HTMLDivElement,
  anchor: ViewportAnchor,
  allowHeightFallback = true,
  layout?: ConversationViewportLayout | null,
): ViewportAnchorRestore {
  const contentOffset = layout?.rowContentOffset(anchor.rowId);
  if (contentOffset !== undefined) {
    const nextRowOffsetTop = contentOffset - element.scrollTop;
    const nextScrollTop = scrollTopForPreservedAnchor(anchor, nextRowOffsetTop);
    if (Math.abs(element.scrollTop - nextScrollTop) > 0.5) element.scrollTop = nextScrollTop;
    return {
      anchor: updateViewportAnchorGeometry(
        anchor,
        contentOffset - element.scrollTop,
        element.scrollTop,
        element.scrollHeight,
      ),
      didFindRow: true,
    };
  }

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
