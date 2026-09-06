import assert from 'node:assert/strict';
import test from 'node:test';
import {
  projectTimelineAnchors,
  rememberTimelineCapacityBlock,
  restoreStatusForConversationTimeline,
  shouldPrimeConversationTimeline,
} from '../hooks/useConversationTimeline';
import type { FeedItem } from './chatFeed';
import type { TranscriptEvent } from '../types/bridge';

function message(
  id: string,
  text: string,
  author?: 'user',
): Extract<FeedItem, { type: 'message' }> {
  const event: TranscriptEvent = {
    id,
    appSessionId: 'app-1',
    sourceSessionId: 'app-1',
    role: 'primary',
    ts: Number(id.replace(/\D/g, '')),
    kind: 'text',
    text,
    author,
  };
  return { type: 'message', key: id, event };
}

test('timeline capacity blocks survive conversation switches', () => {
  let blocked = rememberTimelineCapacityBlock(new Set(), 'app-1:primary', true);
  blocked = rememberTimelineCapacityBlock(blocked, 'app-2:primary', false);

  assert.equal(blocked.has('app-1:primary'), true);
  assert.equal(blocked.has('app-2:primary'), false);
});

test('desktop timelines prime until initial restore settles', () => {
  const base = {
    isViewingChildSession: false,
    anchorCount: 5,
    targetAnchorCount: 12,
  };

  assert.equal(shouldPrimeConversationTimeline({ ...base, restoreStatus: undefined }), true);
  assert.equal(shouldPrimeConversationTimeline({ ...base, restoreStatus: 'loading' }), true);
  assert.equal(shouldPrimeConversationTimeline({ ...base, restoreStatus: 'paged' }), true);
  assert.equal(shouldPrimeConversationTimeline({ ...base, restoreStatus: 'loaded' }), false);
  assert.equal(shouldPrimeConversationTimeline({ ...base, restoreStatus: 'failed' }), false);
  assert.equal(
    shouldPrimeConversationTimeline({
      ...base,
      restoreStatus: 'paged',
      isTranscriptWindowAtCapacity: true,
    }),
    false,
  );
  assert.equal(
    shouldPrimeConversationTimeline({
      ...base,
      isViewingChildSession: true,
      restoreStatus: 'loading',
    }),
    false,
  );
});

test('embedded timelines treat their intentionally skipped restore as loaded', () => {
  assert.equal(restoreStatusForConversationTimeline(undefined, false), 'loaded');
  assert.equal(restoreStatusForConversationTimeline(undefined, true), 'loading');
  assert.equal(restoreStatusForConversationTimeline('paged', false), 'paged');
});

test('incremental assistant output reuses long timeline anchors until a prompt changes', () => {
  const firstPrompt = message('prompt-1', 'First question', 'user');
  const initial = projectTimelineAnchors(undefined, {
    conversationKey: 'app-1:primary',
    feedItems: [firstPrompt, message('answer-1', 'Initial answer')],
    projectionMode: 'full',
  });
  const streamed = projectTimelineAnchors(initial, {
    conversationKey: 'app-1:primary',
    feedItems: [firstPrompt, message('answer-1', 'Initial answer plus more')],
    projectionMode: 'incremental',
  });

  assert.strictEqual(streamed.anchors, initial.anchors);

  const secondPrompt = message('prompt-2', 'Second question', 'user');
  const nextTurn = projectTimelineAnchors(streamed, {
    conversationKey: 'app-1:primary',
    feedItems: [firstPrompt, message('answer-1', 'Done'), secondPrompt],
    projectionMode: 'incremental',
  });
  assert.notStrictEqual(nextTurn.anchors, streamed.anchors);
  assert.deepEqual(
    nextTurn.anchors.map((anchor) => anchor.id),
    ['prompt-1', 'prompt-2'],
  );
});

test('history rebuilds and conversation switches never reuse timeline anchors', () => {
  const currentPrompt = message('prompt-2', 'Current question', 'user');
  const initial = projectTimelineAnchors(undefined, {
    conversationKey: 'app-1:primary',
    feedItems: [currentPrompt],
    projectionMode: 'full',
  });
  const prepended = projectTimelineAnchors(initial, {
    conversationKey: 'app-1:primary',
    feedItems: [message('prompt-1', 'Older question', 'user'), currentPrompt],
    projectionMode: 'full',
  });
  assert.deepEqual(
    prepended.anchors.map((anchor) => anchor.id),
    ['prompt-1', 'prompt-2'],
  );

  const switched = projectTimelineAnchors(prepended, {
    conversationKey: 'app-2:primary',
    feedItems: [currentPrompt],
    projectionMode: 'incremental',
  });
  assert.notStrictEqual(switched.anchors, prepended.anchors);
  assert.deepEqual(
    switched.anchors.map((anchor) => anchor.id),
    ['prompt-2'],
  );
});

test('incremental timeline reuse inspects only the current turn in a long chat', () => {
  const feedItems: FeedItem[] = [];
  for (let index = 0; index < 5_000; index += 1) {
    feedItems.push(message(`prompt-${index}`, `Question ${index}`, 'user'));
    feedItems.push(message(`answer-${index}`, `Answer ${index}`));
  }
  const initial = projectTimelineAnchors(undefined, {
    conversationKey: 'app-1:primary',
    feedItems,
    projectionMode: 'full',
  });
  const streamedItems = feedItems.slice();
  streamedItems[streamedItems.length - 1] = message('answer-4999', 'Answer 4999 continued');
  let itemReads = 0;
  const observedItems = new Proxy(streamedItems, {
    get(target, property, receiver) {
      if (typeof property === 'string' && /^\d+$/.test(property)) itemReads += 1;
      return Reflect.get(target, property, receiver);
    },
  });

  const streamed = projectTimelineAnchors(initial, {
    conversationKey: 'app-1:primary',
    feedItems: observedItems,
    projectionMode: 'incremental',
  });

  assert.strictEqual(streamed.anchors, initial.anchors);
  assert.ok(itemReads <= 2, `expected a tail-only scan, observed ${itemReads} item reads`);
});
