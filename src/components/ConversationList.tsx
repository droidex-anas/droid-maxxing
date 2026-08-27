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

import type { FeedItem } from './chat';
import type { ConversationViewportLayout } from '../hooks/conversationViewportAnchor';
import {
  buildConversationRowLookup,
  CONVERSATION_LIST_ESTIMATE_PX,
  CONVERSATION_LIST_GAP_PX,
  CONVERSATION_LIST_INITIAL_RECT,
  CONVERSATION_LIST_OVERSCAN,
  CONVERSATION_LIST_PIN_THRESHOLD_PX,
  estimatedListEndOffset,
  findConversationRowIndex,
  isConversationAtLatest,
  nearestOverflowParent,
  scrollMarginBetween,
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
    // Skip flushSync during scroll; write spacer height here so pin-follow sees the new total this frame.
    useFlushSync: false,
    onChange: (instance) => {
      const list = listElRef.current;
      // Height must be in the DOM this frame; React's style below lands next commit and would clip a pinned tail.
      if (list) list.style.height = `${String(instance.getTotalSize())}px`;
      onMountedRowsChangeRef.current?.(instance.getVirtualIndexes().length);
    },
  });

  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();

  useLayoutEffect(() => {
    onMountedRowsChangeRef.current?.(virtualItems.length);
  }, [virtualItems.length]);

  useLayoutEffect(
    () => () => {
      onMountedRowsChangeRef.current?.(0);
    },
    [],
  );

  useLayoutEffect(() => {
    const list = listElRef.current;
    const scroll = getScrollElement();
    if (!list || !scroll) return;
    const next = scrollMarginBetween(list, scroll);
    setScrollMargin((current) => (Math.abs(next - current) > 0.5 ? next : current));
  }, [getScrollElement, items.length, totalSize]);

  useLayoutEffect(() => {
    const list = listElRef.current;
    if (!list || typeof ResizeObserver === 'undefined') return;
    let lastWidth = list.clientWidth;
    let frame = 0;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? list.clientWidth;
      if (Math.abs(width - lastWidth) < 0.5) return;
      lastWidth = width;
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = 0;
        virtualizer.measure();
      });
    });
    observer.observe(list);
    return () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [virtualizer]);

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
      <div ref={listElRef} style={{ height: totalSize, width: '100%', position: 'relative' }}>
        {virtualItems.map((virtualRow) => {
          const item = items.at(virtualRow.index);
          if (!item) return null;
          return (
            <div
              key={virtualRow.key}
              data-index={virtualRow.index}
              ref={virtualizer.measureElement}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translate3d(0, ${String(virtualRow.start - scrollMargin)}px, 0)`,
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
