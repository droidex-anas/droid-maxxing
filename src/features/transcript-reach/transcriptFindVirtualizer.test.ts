import assert from 'node:assert/strict';
import test from 'node:test';
import { Virtualizer } from '@tanstack/virtual-core';

import type { FeedItem } from '../../components/chat';
import {
  buildConversationRowLookup,
  CONVERSATION_LIST_ESTIMATE_PX,
  CONVERSATION_LIST_GAP_PX,
  CONVERSATION_LIST_INITIAL_RECT,
  CONVERSATION_LIST_OVERSCAN,
  CONVERSATION_LIST_PIN_THRESHOLD_PX,
  estimatedListEndOffset,
  findConversationRowIndex,
} from '../../components/conversationListState';
import { feedRowId } from '../../hooks/conversationViewportAnchor';
import type { TranscriptEvent } from '../../types/bridge';
import { findTranscriptMatches, projectTranscriptSearchIndex } from './transcriptFind';

function messageItem(id: string, text: string): FeedItem {
  const event: TranscriptEvent = {
    id,
    appSessionId: 'm',
    sourceSessionId: 'primary',
    role: 'primary',
    ts: 1,
    kind: 'text',
    text,
  };
  return { type: 'message', key: id, event };
}

function history(count: number): FeedItem[] {
  return Array.from({ length: count }, (_, index) =>
    messageItem(`row-${String(index)}`, index === 4 ? 'needleFromTurnTwo' : `row ${String(index)}`),
  );
}

function createListEngine(items: readonly FeedItem[]) {
  const viewportHeight = CONVERSATION_LIST_INITIAL_RECT.height;
  let scrollTop = estimatedListEndOffset(items.length, viewportHeight);
  let offsetObserver: ((offset: number, isScrolling: boolean) => void) | undefined;
  const element = {
    clientHeight: viewportHeight,
    clientWidth: CONVERSATION_LIST_INITIAL_RECT.width,
    get scrollTop() {
      return scrollTop;
    },
    set scrollTop(value: number) {
      scrollTop = value;
    },
  } as HTMLDivElement;

  const virtualizer = new Virtualizer<HTMLDivElement, HTMLDivElement>({
    count: items.length,
    getScrollElement: () => element,
    estimateSize: () => CONVERSATION_LIST_ESTIMATE_PX,
    overscan: CONVERSATION_LIST_OVERSCAN,
    gap: CONVERSATION_LIST_GAP_PX,
    getItemKey: (index) => items[index]?.key ?? index,
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
  return { virtualizer };
}

test('finding and scrolling to an unmounted row keeps the mounted window bounded', () => {
  const items = history(400);
  const engine = createListEngine(items);
  const before = engine.virtualizer.getVirtualIndexes();
  assert.ok(before.length > 0);
  assert.ok(before.length < 80);
  assert.ok(!before.includes(4), 'the early needle row starts unmounted');

  const index = projectTranscriptSearchIndex(null, 'chat:primary', items, 'full', 0);
  const matches = findTranscriptMatches(index, 'needleFromTurnTwo');
  assert.equal(matches.length, 1);
  const rowId = matches[0]?.rowId;
  assert.equal(rowId, feedRowId(items[4]!));
  const lookup = buildConversationRowLookup(items);
  const rowIndex = findConversationRowIndex(lookup, rowId ?? '');
  assert.equal(rowIndex, 4);
  engine.virtualizer.scrollToIndex(rowIndex ?? 0, { align: 'start' });
  const after = engine.virtualizer.getVirtualIndexes();
  assert.ok(after.includes(4));
  assert.ok(after.length < 80);
  assert.equal(after.length <= before.length + CONVERSATION_LIST_OVERSCAN * 2, true);
  assert.ok(after.length < items.length);
});
