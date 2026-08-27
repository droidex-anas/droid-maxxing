import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Virtualizer } from '@tanstack/virtual-core';

import type { FeedItem } from './chat';
import { MessageFeed } from './chat';
import {
  buildConversationRowLookup,
  CONVERSATION_LIST_ESTIMATE_PX,
  CONVERSATION_LIST_GAP_PX,
  CONVERSATION_LIST_INITIAL_RECT,
  CONVERSATION_LIST_OVERSCAN,
  CONVERSATION_LIST_PIN_THRESHOLD_PX,
  CONVERSATION_VISIBLE_HOLE_PX,
  conversationRowMountKey,
  conversationRowViewportId,
  estimatedListEndOffset,
  estimatedListSize,
  findConversationRowIndex,
  isConversationAtLatest,
  measuredConversationRowSize,
  shouldAdjustConversationRowOnSizeChange,
  syncMeasureConversationList,
  takeFeedRowEntrance,
} from './conversationListState';
import { applyConversationContentResize } from '../hooks/useConversationScrollWindow';
import {
  feedRowId,
  restoreViewportAnchor,
  scrollTopForPreservedAnchor,
  type ConversationViewportLayout,
} from '../hooks/conversationViewportAnchor';
import type { TranscriptEvent } from '../types/bridge';

function messageItem(id: string, author: 'user' | 'assistant' = 'assistant'): FeedItem {
  const event: TranscriptEvent = {
    id,
    appSessionId: 'm',
    sourceSessionId: 'primary',
    role: 'primary',
    ts: 1,
    kind: 'text',
    author,
    text: id,
  };
  return { type: 'message', key: id, event };
}

function history(count: number): FeedItem[] {
  return Array.from({ length: count }, (_, index) =>
    messageItem(`row-${String(index)}`, index % 2 === 0 ? 'user' : 'assistant'),
  );
}

const VARIED_ROW_HEIGHTS = [40, 72, 180, 240, 48, 320, 56, 400] as const;

function variedRowHeight(index: number): number {
  return VARIED_ROW_HEIGHTS[index % VARIED_ROW_HEIGHTS.length]!;
}

function createListEngine(options: {
  items: readonly FeedItem[];
  viewportHeight?: number;
  scrollTop?: number;
}) {
  const itemsRef = { current: options.items };
  const viewportHeight = options.viewportHeight ?? CONVERSATION_LIST_INITIAL_RECT.height;
  let scrollTop = options.scrollTop ?? estimatedListEndOffset(options.items.length, viewportHeight);
  let scrollHeight = estimatedListSize(options.items.length);
  let offsetObserver: ((offset: number, isScrolling: boolean) => void) | undefined;
  const element = {
    clientHeight: viewportHeight,
    clientWidth: CONVERSATION_LIST_INITIAL_RECT.width,
    offsetHeight: viewportHeight,
    offsetWidth: CONVERSATION_LIST_INITIAL_RECT.width,
    get scrollHeight() {
      return scrollHeight;
    },
    set scrollHeight(value: number) {
      scrollHeight = value;
    },
    get scrollTop() {
      return scrollTop;
    },
    set scrollTop(value: number) {
      scrollTop = value;
    },
  } as HTMLDivElement;

  const virtualizer = new Virtualizer<HTMLDivElement, HTMLDivElement>({
    count: itemsRef.current.length,
    getScrollElement: () => element,
    estimateSize: () => CONVERSATION_LIST_ESTIMATE_PX,
    overscan: CONVERSATION_LIST_OVERSCAN,
    gap: CONVERSATION_LIST_GAP_PX,
    getItemKey: (index) => itemsRef.current[index]?.key ?? index,
    initialRect: { width: CONVERSATION_LIST_INITIAL_RECT.width, height: viewportHeight },
    initialOffset: scrollTop,
    scrollEndThreshold: CONVERSATION_LIST_PIN_THRESHOLD_PX,
    observeElementRect: (_instance, cb) => {
      cb({ width: CONVERSATION_LIST_INITIAL_RECT.width, height: viewportHeight });
    },
    observeElementOffset: (_instance, cb) => {
      offsetObserver = cb;
      cb(scrollTop, false);
    },
    scrollToFn: (offset) => {
      scrollTop = offset;
      offsetObserver?.(offset, false);
    },
  });
  virtualizer._willUpdate();
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = shouldAdjustConversationRowOnSizeChange;
  return {
    virtualizer,
    element,
    itemsRef,
    syncMeasuredHeight() {
      scrollHeight = virtualizer.getTotalSize();
    },
    notifyOffset() {
      offsetObserver?.(scrollTop, false);
      virtualizer._willUpdate();
    },
  };
}

function measureVariedRows(
  virtualizer: Virtualizer<HTMLDivElement, HTMLDivElement>,
  count: number,
) {
  for (let index = 0; index < count; index += 1) {
    virtualizer.resizeItem(index, variedRowHeight(index));
  }
}

function pinFollowMeasuredEnd(engine: ReturnType<typeof createListEngine>) {
  engine.syncMeasuredHeight();
  applyConversationContentResize(engine.element, null, true, false);
  const maxTop = Math.max(0, engine.element.scrollHeight - engine.element.clientHeight);
  engine.element.scrollTop = Math.min(engine.element.scrollTop, maxTop);
  engine.notifyOffset();
}

test('visible-hole threshold is twice the list gap, not an estimated row', () => {
  assert.equal(CONVERSATION_VISIBLE_HOLE_PX, CONVERSATION_LIST_GAP_PX * 2);
  assert.ok(CONVERSATION_VISIBLE_HOLE_PX < CONVERSATION_LIST_ESTIMATE_PX);
});

test('size-change compensation is off while the user is scrolling', () => {
  const aboveFold = { start: 0, size: 96, key: 'row-0' };
  const scrolling = {
    isScrolling: true,
    scrollDirection: 'backward' as const,
    scrollAdjustments: 0,
    itemSizeCache: new Map<string | number | bigint, number>(),
    scrollOffset: 2_000,
  };
  assert.equal(shouldAdjustConversationRowOnSizeChange(aboveFold, -77, scrolling), false);

  const idle = { ...scrolling, isScrolling: false, scrollDirection: null };
  assert.equal(shouldAdjustConversationRowOnSizeChange(aboveFold, -77, idle), true);

  const growingInView = { start: 1_920, size: 96, key: 'live' };
  const idleMeasured = {
    ...idle,
    itemSizeCache: new Map<string | number | bigint, number>([['live', 96]]),
  };
  assert.equal(shouldAdjustConversationRowOnSizeChange(growingInView, 24, idleMeasured), false);
});

test('first measure above the fold does not write scrollTop while scrolling', () => {
  const { virtualizer, element } = createListEngine({ items: history(80), scrollTop: 2_000 });
  virtualizer.getVirtualItems();
  const before = element.scrollTop;
  virtualizer.isScrolling = true;
  virtualizer.resizeItem(0, 19);
  assert.equal(element.scrollTop, before);
  virtualizer.getVirtualItems();
  assert.equal(virtualizer.measurementsCache[0]?.size, 19);
});

test('sync measure skips resize when the cached size already matches', () => {
  const calls: Array<[number, number]> = [];
  const list = {
    firstElementChild: {
      dataset: { index: '3' },
      offsetHeight: 40,
      nextElementSibling: null,
    },
  } as unknown as HTMLElement;
  syncMeasureConversationList(
    list,
    (index, size) => calls.push([index, size]),
    () => 40,
  );
  assert.deepEqual(calls, []);
  syncMeasureConversationList(
    list,
    (index, size) => calls.push([index, size]),
    () => 96,
  );
  assert.deepEqual(calls, [[3, 40]]);
});

test('row measure reads the index attribute and rounds layout height', () => {
  const row = {
    dataset: { index: '12' },
    offsetHeight: 19.4,
  } as unknown as HTMLElement;
  assert.deepEqual(measuredConversationRowSize(row), { index: 12, size: 19 });
  const missing = { dataset: {}, offsetHeight: 40 } as unknown as HTMLElement;
  assert.equal(measuredConversationRowSize(missing), null);
});

test('measuring a short row packs the next row to the list gap', () => {
  const { virtualizer } = createListEngine({ items: history(80), scrollTop: 0 });
  virtualizer.getVirtualItems();
  assert.equal(virtualizer.measurementsCache[0]?.size, CONVERSATION_LIST_ESTIMATE_PX);
  virtualizer.resizeItem(0, 19);
  virtualizer.getVirtualItems();
  const measured = virtualizer.measurementsCache[0];
  const next = virtualizer.measurementsCache[1];
  assert.ok(measured);
  assert.ok(next);
  assert.equal(measured.size, 19);
  assert.equal(next.start - measured.end, CONVERSATION_LIST_GAP_PX);
});

test('mounted row count stays bounded for 3k and 10k histories', () => {
  for (const count of [3_000, 10_000]) {
    const { virtualizer } = createListEngine({ items: history(count) });
    const mounted = virtualizer.getVirtualItems().length;
    assert.ok(mounted > 0, `expected a visible window for ${String(count)} rows`);
    assert.ok(
      mounted < 80,
      `expected a bounded window for ${String(count)} rows, mounted ${String(mounted)}`,
    );
    assert.ok(mounted < count);
  }
});

test('streaming the last row does not remount or remeasure settled rows', () => {
  const items = history(400);
  const { virtualizer, itemsRef } = createListEngine({ items });
  for (let index = 0; index < items.length - 1; index += 1) {
    virtualizer.resizeItem(index, 120);
  }
  const settledKeys = items.slice(0, -1).map((item) => item.key);
  const sizesBefore = settledKeys.map((key) => virtualizer.itemSizeCache.get(key));

  const tail = items[items.length - 1];
  assert.ok(tail);
  itemsRef.current = [...items.slice(0, -1), messageItem(tail.key, 'assistant')];
  virtualizer.setOptions({ ...virtualizer.options, count: itemsRef.current.length });
  virtualizer.resizeItem(items.length - 1, 180);

  assert.deepEqual(
    settledKeys.map((key) => virtualizer.itemSizeCache.get(key)),
    sizesBefore,
  );
  for (const key of settledKeys) {
    assert.equal(virtualizer.itemSizeCache.get(key), 120);
  }
  assert.equal(virtualizer.itemSizeCache.get(tail.key), 180);
});

test('prepending older history preserves the viewport anchor through virtual offsets', () => {
  const visible = history(80);
  const { virtualizer, itemsRef } = createListEngine({
    items: visible,
    scrollTop: 200,
    viewportHeight: 900,
  });
  const anchorItem = visible[2];
  assert.ok(anchorItem);
  const lookupBefore = buildConversationRowLookup(visible);
  const anchorIndex = findConversationRowIndex(lookupBefore, feedRowId(anchorItem));
  assert.equal(anchorIndex, 2);
  virtualizer.getVirtualItems();
  const capturedStart = virtualizer.measurementsCache[2]?.start;
  assert.ok(typeof capturedStart === 'number');
  const captured = { scrollTop: 200, rowOffsetTop: capturedStart - 200 };

  const older = history(40).map((item, index) =>
    messageItem(
      `older-${String(index)}`,
      item.type === 'message' ? item.event.author : 'assistant',
    ),
  );
  itemsRef.current = [...older, ...visible];
  virtualizer.setOptions({ ...virtualizer.options, count: itemsRef.current.length });
  virtualizer.getVirtualItems();

  const lookupAfter = buildConversationRowLookup(itemsRef.current);
  const nextIndex = findConversationRowIndex(lookupAfter, feedRowId(anchorItem));
  assert.equal(nextIndex, 42);
  const nextStart = virtualizer.measurementsCache[nextIndex]?.start;
  assert.ok(typeof nextStart === 'number');
  const restoredTop = scrollTopForPreservedAnchor(captured, nextStart - 200);
  assert.equal(restoredTop, 200 + (nextStart - capturedStart));
  assert.ok(
    Math.abs(restoredTop - (capturedStart + (nextStart - capturedStart) - captured.rowOffsetTop)) <
      0.01,
  );
});

test('scroll-to-row lookup remains accurate for prompt, tool, and turn identities', () => {
  const prompt = messageItem('prompt-1', 'user');
  const answer = messageItem('answer-1', 'assistant');
  const toolCall: TranscriptEvent = {
    id: 'tool-1',
    appSessionId: 'm',
    sourceSessionId: 'primary',
    role: 'primary',
    ts: 3,
    kind: 'tool_call',
    toolName: 'Grep',
    toolArgs: { pattern: 'x' },
  };
  const tools: FeedItem = { type: 'tools', key: 'tool-1', events: [toolCall] };
  const child: FeedItem = {
    type: 'child_session',
    key: 'child-session-wave',
    event: {
      id: 'child-1',
      appSessionId: 'm',
      sourceSessionId: 'primary',
      role: 'primary',
      ts: 4,
      kind: 'tool_call',
      toolName: 'Task',
      toolUseId: 'tu-child',
      toolArgs: { description: 'explore' },
    },
  };
  const items = [prompt, tools, child, answer];
  const lookup = buildConversationRowLookup(items);

  assert.equal(findConversationRowIndex(lookup, prompt.key), 0);
  assert.equal(findConversationRowIndex(lookup, conversationRowViewportId(prompt)), 0);
  assert.equal(findConversationRowIndex(lookup, tools.key), 1);
  assert.equal(findConversationRowIndex(lookup, feedRowId(tools)), 1);
  assert.equal(findConversationRowIndex(lookup, child.key), 2);
  assert.equal(findConversationRowIndex(lookup, feedRowId(child)), 2);
  assert.equal(findConversationRowIndex(lookup, 'missing'), undefined);
});

test('bottom-follow is a cheap end-threshold, not full geometry', () => {
  assert.equal(isConversationAtLatest(2_000, 1_100, 900), true);
  assert.equal(isConversationAtLatest(2_000, 1_000, 900), false);
  assert.equal(isConversationAtLatest(2_000, 1_921, 900), true);
});

test('mermaid growth above an unpinned reader is compensated by the virtual row offset', () => {
  const items = history(60);
  const viewportHeight = 900;
  const scrollTop = 2_400;
  const { virtualizer, element } = createListEngine({ items, scrollTop, viewportHeight });
  virtualizer.getVirtualItems();

  const anchorIndex = 25;
  const mermaidIndex = 8;
  const mermaidGrowthPx = 280;
  const anchorItem = items[anchorIndex];
  assert.ok(anchorItem);
  const capturedStart = virtualizer.measurementsCache[anchorIndex]?.start;
  const mermaidBefore = virtualizer.measurementsCache[mermaidIndex]?.size;
  assert.ok(typeof capturedStart === 'number');
  assert.ok(typeof mermaidBefore === 'number');
  const capturedOffset = capturedStart - element.scrollTop;

  virtualizer.resizeItem(mermaidIndex, mermaidBefore + mermaidGrowthPx);
  virtualizer.getVirtualItems();

  const layout: ConversationViewportLayout = {
    rowContentOffset: (rowId) => {
      const index = items.findIndex((item) => feedRowId(item) === rowId);
      if (index < 0) return undefined;
      return virtualizer.measurementsCache[index]?.start;
    },
  };
  const restored = applyConversationContentResize(
    element,
    {
      rowId: feedRowId(anchorItem),
      rowOffsetTop: capturedOffset,
      scrollTop,
      scrollHeight: estimatedListSize(items.length),
    },
    false,
    true,
    layout,
  );

  const nextStart = virtualizer.measurementsCache[anchorIndex]?.start;
  assert.ok(typeof nextStart === 'number');
  assert.equal(restored.mode, 'preserve-anchor');
  assert.equal(restored.didFindRow, true);
  assert.equal(nextStart, capturedStart + mermaidGrowthPx);
  assert.equal(element.scrollTop, scrollTop + mermaidGrowthPx);
  assert.equal(nextStart - element.scrollTop, capturedOffset);
});

test('mermaid growth below an unpinned reader does not move the reading position', () => {
  const items = history(60);
  const viewportHeight = 900;
  const scrollTop = 2_400;
  const { virtualizer, element } = createListEngine({ items, scrollTop, viewportHeight });
  virtualizer.getVirtualItems();

  const anchorIndex = 25;
  const mermaidIndex = 40;
  const mermaidGrowthPx = 280;
  const anchorItem = items[anchorIndex];
  assert.ok(anchorItem);
  const capturedStart = virtualizer.measurementsCache[anchorIndex]?.start;
  const mermaidBefore = virtualizer.measurementsCache[mermaidIndex]?.size;
  assert.ok(typeof capturedStart === 'number');
  assert.ok(typeof mermaidBefore === 'number');
  const capturedOffset = capturedStart - element.scrollTop;

  virtualizer.resizeItem(mermaidIndex, mermaidBefore + mermaidGrowthPx);
  virtualizer.getVirtualItems();

  const layout: ConversationViewportLayout = {
    rowContentOffset: (rowId) => {
      const index = items.findIndex((item) => feedRowId(item) === rowId);
      if (index < 0) return undefined;
      return virtualizer.measurementsCache[index]?.start;
    },
  };
  const restored = applyConversationContentResize(
    element,
    {
      rowId: feedRowId(anchorItem),
      rowOffsetTop: capturedOffset,
      scrollTop,
      scrollHeight: estimatedListSize(items.length),
    },
    false,
    true,
    layout,
  );

  const nextStart = virtualizer.measurementsCache[anchorIndex]?.start;
  assert.ok(typeof nextStart === 'number');
  assert.equal(restored.mode, 'preserve-anchor');
  assert.equal(nextStart, capturedStart);
  assert.equal(element.scrollTop, scrollTop);
  assert.equal(nextStart - element.scrollTop, capturedOffset);
});

test('resize restore uses virtual content offsets without a mounted row', () => {
  const layout: ConversationViewportLayout = {
    rowContentOffset: (rowId) => (rowId === 'message:keep' ? 4_800 : undefined),
  };
  const element = { scrollTop: 1_200, scrollHeight: 8_000 } as HTMLDivElement;
  const restored = restoreViewportAnchor(
    element,
    { rowId: 'message:keep', rowOffsetTop: 24, scrollTop: 1_200, scrollHeight: 6_000 },
    true,
    layout,
  );
  assert.equal(restored.didFindRow, true);
  assert.equal(element.scrollTop, 1_200 + 4_800 - 1_200 - 24);
});

test('entrance animation fires once per append and not when a settled row remounts', () => {
  const entered = new Set<string>();
  const appended = new Set(['new-tail']);
  assert.equal(takeFeedRowEntrance('new-tail', appended, entered), true);
  assert.equal(takeFeedRowEntrance('new-tail', appended, entered), false);
  assert.equal(takeFeedRowEntrance('old-row', appended, entered), false);
});

test('row mount identity follows FeedItem.key while viewport identity follows feedRowId', () => {
  const item = messageItem('evt-9', 'user');
  assert.equal(conversationRowMountKey(item), item.key);
  assert.equal(conversationRowViewportId(item), feedRowId(item));
  assert.equal(conversationRowViewportId(item), 'message:evt-9');
});

test('MessageFeed mounts a bounded window for a long synthetic history', () => {
  const events: TranscriptEvent[] = Array.from({ length: 400 }, (_, index) => ({
    id: `e${String(index)}`,
    appSessionId: 'm',
    sourceSessionId: 'primary',
    role: 'primary',
    ts: index + 1,
    kind: 'text',
    author: index % 2 === 0 ? 'user' : 'assistant',
    text: `row ${String(index)}`,
  }));
  const html = renderToStaticMarkup(createElement(MessageFeed, { events, pending: false }));
  const mounted = html.match(/data-feed-row-id=/g)?.length ?? 0;
  assert.ok(mounted > 0);
  assert.ok(mounted < 80, `expected a virtual window, mounted ${String(mounted)}`);
  assert.match(html, /row 399/);
  assert.doesNotMatch(html, /row 0</);
});

test('opening a 3k history with varied heights lands on the latest row after measure', () => {
  const items = history(3_000);
  const viewportHeight = CONVERSATION_LIST_INITIAL_RECT.height;
  const engine = createListEngine({ items, viewportHeight });
  const estimatedEnd = estimatedListEndOffset(items.length, viewportHeight);
  assert.equal(engine.element.scrollTop, estimatedEnd);

  measureVariedRows(engine.virtualizer, items.length);
  pinFollowMeasuredEnd(engine);

  const totalSize = engine.virtualizer.getTotalSize();
  const measuredEnd = Math.max(0, totalSize - viewportHeight);
  assert.ok(
    Math.abs(measuredEnd - estimatedEnd) > 50_000,
    `varied heights must diverge from the 96px estimate; estimated ${String(estimatedEnd)} measured ${String(measuredEnd)}`,
  );
  assert.equal(engine.element.scrollTop, measuredEnd);
  assert.equal(
    isConversationAtLatest(engine.element.scrollHeight, engine.element.scrollTop, viewportHeight),
    true,
  );
  assert.equal(engine.element.scrollTop + viewportHeight, totalSize);

  const lastIndex = items.length - 1;
  const last = engine.virtualizer.measurementsCache[lastIndex];
  assert.ok(last);
  assert.equal(last.size, variedRowHeight(lastIndex));
  assert.equal(last.start + last.size, last.end);
  const viewportTop = engine.element.scrollTop;
  const viewportBottom = viewportTop + viewportHeight;
  assert.ok(last.end <= viewportBottom + 0.5);
  assert.ok(last.start < viewportBottom);
  assert.ok(last.end > viewportTop);
  assert.ok(
    engine.virtualizer.getVirtualItems().some((row) => row.index === lastIndex),
    'the latest row must be in the mounted window',
  );
});

test('restored unpinned offset lands on the same captured row after varied measure', () => {
  const items = history(3_000);
  const engine = createListEngine({ items, scrollTop: 0 });
  engine.virtualizer.getVirtualItems();
  const anchorIndex = 1_500;
  const anchorItem = items[anchorIndex];
  assert.ok(anchorItem);
  const capturedStart = engine.virtualizer.measurementsCache[anchorIndex]?.start;
  assert.ok(typeof capturedStart === 'number');
  const rowOffsetTop = 40;
  const captured = {
    rowId: feedRowId(anchorItem),
    rowOffsetTop,
    scrollTop: capturedStart - rowOffsetTop,
    scrollHeight: engine.element.scrollHeight,
  };
  engine.element.scrollTop = captured.scrollTop;
  engine.notifyOffset();

  measureVariedRows(engine.virtualizer, items.length);
  engine.syncMeasuredHeight();
  engine.virtualizer.getVirtualItems();
  const nextStart = engine.virtualizer.measurementsCache[anchorIndex]?.start;
  assert.ok(typeof nextStart === 'number');
  assert.notEqual(nextStart, capturedStart);

  const layout: ConversationViewportLayout = {
    rowContentOffset: (rowId) => {
      engine.virtualizer.getVirtualItems();
      const index = findConversationRowIndex(buildConversationRowLookup(items), rowId);
      return index === undefined ? undefined : engine.virtualizer.measurementsCache[index]?.start;
    },
  };
  const restored = restoreViewportAnchor(engine.element, captured, true, layout);
  assert.equal(restored.didFindRow, true);
  assert.ok(Math.abs(nextStart - engine.element.scrollTop - rowOffsetTop) < 0.5);
  assert.equal(restored.anchor.rowId, captured.rowId);
});

test('pinned follow stays at the latest row when the tail grows after a deferred measure', () => {
  const items = history(80);
  const engine = createListEngine({ items });
  for (let index = 0; index < items.length - 1; index += 1) {
    engine.virtualizer.resizeItem(index, 80);
  }
  engine.virtualizer.resizeItem(items.length - 1, 96);
  pinFollowMeasuredEnd(engine);
  assert.equal(
    isConversationAtLatest(
      engine.element.scrollHeight,
      engine.element.scrollTop,
      engine.element.clientHeight,
    ),
    true,
  );

  engine.virtualizer.resizeItem(items.length - 1, 400);
  pinFollowMeasuredEnd(engine);
  assert.equal(
    isConversationAtLatest(
      engine.element.scrollHeight,
      engine.element.scrollTop,
      engine.element.clientHeight,
    ),
    true,
  );
  const last = engine.virtualizer.measurementsCache[items.length - 1];
  assert.ok(last);
  assert.equal(last.size, 400);
  assert.equal(
    engine.element.scrollTop + engine.element.clientHeight,
    engine.virtualizer.getTotalSize(),
  );
  assert.ok(last.end > engine.element.scrollTop);
  assert.ok(last.end <= engine.element.scrollTop + engine.element.clientHeight + 0.5);
});

test('a single tall message is one virtual row and stays fully addressable', () => {
  const items = history(5);
  const engine = createListEngine({ items, scrollTop: 0 });
  engine.virtualizer.resizeItem(2, 4_000);
  engine.syncMeasuredHeight();
  engine.element.scrollTop = engine.virtualizer.measurementsCache[2]?.start ?? 0;
  engine.notifyOffset();
  const mounted = engine.virtualizer.getVirtualItems();
  const tall = mounted.find((row) => row.index === 2);
  assert.ok(tall);
  assert.equal(tall.size, 4_000);
  assert.equal(mounted.filter((row) => row.index === 2).length, 1);
});
