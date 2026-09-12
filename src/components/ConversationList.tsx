import {
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

import type { FeedItem } from './chatFeed';
import type { ConversationViewportLayout } from '../hooks/conversationViewportAnchor';
import {
  buildConversationRowLookup,
  CONVERSATION_LIST_ESTIMATE_PX,
  CONVERSATION_LIST_GAP_PX,
  CONVERSATION_LIST_INITIAL_RECT,
  CONVERSATION_LIST_OVERSCAN,
  CONVERSATION_LIST_PIN_THRESHOLD_PX,
  CONVERSATION_LIST_WIDTH_SETTLE_MS,
  estimatedListEndOffset,
  findConversationRowIndex,
  isConversationAtLatest,
  nearestOverflowParent,
  scrollMarginBetween,
  shouldAdjustConversationRowOnSizeChange,
  syncMeasureConversationList,
} from './conversationListState';

export interface ConversationListHandle {
  scrollToRow: (rowId: string) => void;
  scrollToLatest: () => void;
  isAtLatest: () => boolean;
}

export interface ConversationListProps {
  items: readonly FeedItem[];
  children: (item: FeedItem, index: number) => ReactNode;
  scrollElementRef?: RefObject<HTMLElement | null>;
  viewportLayoutRef?: RefObject<ConversationViewportLayout | null>;
  listRef?: RefObject<ConversationListHandle | null>;
  initialScrollOffset?: number;
  onMountedRowsChange?: (count: number) => void;
}

export function ConversationList({
  items,
  children,
  scrollElementRef,
  viewportLayoutRef,
  listRef,
  initialScrollOffset,
  onMountedRowsChange,
}: ConversationListProps) {
  const listElRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const lookup = useMemo(() => buildConversationRowLookup(items), [items]);
  const lookupRef = useRef(lookup);
  lookupRef.current = lookup;
  const onMountedRowsChangeRef = useRef(onMountedRowsChange);
  onMountedRowsChangeRef.current = onMountedRowsChange;
  const [scrollMargin, setScrollMargin] = useState(0);

  const getScrollElement = useCallback((): HTMLElement | null => {
    if (scrollElementRef?.current) return scrollElementRef.current;
    const host = hostRef.current;
    return host ? nearestOverflowParent(host) : null;
  }, [scrollElementRef]);

  const getItemKey = useCallback((index: number) => {
    return itemsRef.current[index]?.key ?? index;
  }, []);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement,
    estimateSize: () => CONVERSATION_LIST_ESTIMATE_PX,
    overscan: CONVERSATION_LIST_OVERSCAN,
    gap: CONVERSATION_LIST_GAP_PX,
    getItemKey,
    scrollMargin,
    initialRect: CONVERSATION_LIST_INITIAL_RECT,
    initialOffset: initialScrollOffset ?? estimatedListEndOffset(items.length),
    scrollEndThreshold: CONVERSATION_LIST_PIN_THRESHOLD_PX,
    useFlushSync: false,
    directDomUpdates: true,
    onChange: (instance) => {
      onMountedRowsChangeRef.current?.(instance.getVirtualIndexes().length);
    },
  });

  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = shouldAdjustConversationRowOnSizeChange;

  const cachedRowSize = useCallback(
    (index: number) => virtualizer.itemSizeCache.get(itemsRef.current[index]?.key ?? index),
    [virtualizer],
  );

  const setListNode = useCallback(
    (node: HTMLDivElement | null) => {
      listElRef.current = node;
      virtualizer.containerRef(node);
    },
    [virtualizer],
  );

  const virtualItems = virtualizer.getVirtualItems();

  useLayoutEffect(() => {
    onMountedRowsChangeRef.current?.(virtualItems.length);
  }, [virtualItems.length]);

  useLayoutEffect(
    () => () => {
      onMountedRowsChangeRef.current?.(0);
    },
    [],
  );

  // History chrome above the list can appear without a range change; keep margin in this layout.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- size-stable; re-run after every commit
  useLayoutEffect(() => {
    const list = listElRef.current;
    if (list) syncMeasureConversationList(list, virtualizer.resizeItem, cachedRowSize);
    const scroll = getScrollElement();
    if (!list || !scroll) return;
    const next = scrollMarginBetween(list, scroll);
    setScrollMargin((current) => (Math.abs(next - current) > 0.5 ? next : current));
  });

  // A narrower or wider transcript reflows every row, but only the rows the
  // virtualizer has mounted can be measured. Clearing the whole size cache
  // would replace every other row's height with the estimate, so the list's
  // total height — and with it the scrollbar and the reader's place in the
  // transcript — would lurch by thousands of pixels on a sidebar toggle that
  // did not change a single row's height. Re-measure the mounted rows instead,
  // once the width has settled; the rest keep the height they were measured at
  // until they scroll back into view and measure themselves.
  useLayoutEffect(() => {
    const list = listElRef.current;
    if (!list || typeof ResizeObserver === 'undefined') return;
    let lastWidth = list.clientWidth;
    let settle: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? list.clientWidth;
      if (Math.abs(width - lastWidth) < 0.5) return;
      lastWidth = width;
      clearTimeout(settle);
      settle = setTimeout(() => {
        syncMeasureConversationList(list, virtualizer.resizeItem, cachedRowSize);
      }, CONVERSATION_LIST_WIDTH_SETTLE_MS);
    });
    observer.observe(list);
    return () => {
      observer.disconnect();
      clearTimeout(settle);
    };
  }, [cachedRowSize, virtualizer]);

  const rowContentOffset = useCallback(
    (rowId: string): number | undefined => {
      const index = findConversationRowIndex(lookupRef.current, rowId);
      if (index === undefined) return undefined;
      // getVirtualItems rebuilds measurementsCache; start is otherwise missing for never-measured rows.
      virtualizer.getVirtualItems();
      return virtualizer.measurementsCache[index]?.start;
    },
    [virtualizer],
  );

  useLayoutEffect(() => {
    if (!viewportLayoutRef) return;
    viewportLayoutRef.current = { rowContentOffset };
    return () => {
      viewportLayoutRef.current = null;
    };
  }, [rowContentOffset, viewportLayoutRef]);

  useImperativeHandle(
    listRef,
    (): ConversationListHandle => ({
      scrollToRow(rowId: string) {
        const index = findConversationRowIndex(lookupRef.current, rowId);
        if (index === undefined) return;
        virtualizer.scrollToIndex(index, { align: 'start' });
      },
      scrollToLatest() {
        if (itemsRef.current.length === 0) return;
        virtualizer.scrollToIndex(itemsRef.current.length - 1, { align: 'end' });
      },
      isAtLatest() {
        const element = getScrollElement();
        if (!element) return true;
        return isConversationAtLatest(
          element.scrollHeight,
          element.scrollTop,
          element.clientHeight,
        );
      },
    }),
    [getScrollElement, virtualizer],
  );

  return (
    <div ref={hostRef}>
      <div ref={setListNode} style={{ width: '100%', position: 'relative' }}>
        {virtualItems.map((virtualRow) => {
          const item = items.at(virtualRow.index);
          if (!item) return null;
          return (
            <div
              key={virtualRow.key}
              data-index={virtualRow.index}
              ref={virtualizer.measureElement}
              // Rows are positioned siblings, so a later row paints over the
              // one before it. A message's copy control floats in the row gap
              // and would sit under the next row; the hovered row rises above.
              className="hover:z-[1] focus-within:z-[1]"
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
              }}
            >
              {children(item, virtualRow.index)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
