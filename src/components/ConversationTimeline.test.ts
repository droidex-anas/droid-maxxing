import assert from 'node:assert/strict';
import test from 'node:test';
import {
  recentConversationAnchors,
  shouldPrimeConversationTimeline,
  type ConversationAnchor,
} from './chat';

function anchors(ids: string[]): ConversationAnchor[] {
  return ids.map((id) => ({ id, label: id }));
}

test('older history prepends do not rebuild the visible timeline window', () => {
  const recent = anchors(Array.from({ length: 12 }, (_, index) => `recent-${String(index)}`));
  const before = recentConversationAnchors(recent, 12);
  const after = recentConversationAnchors(
    [...anchors(['older-0', 'older-1', 'older-2']), ...recent],
    12,
  );

  assert.deepEqual(after, before);
});

test('short conversations keep every available timeline anchor', () => {
  const short = anchors(['one', 'two', 'three']);
  assert.equal(recentConversationAnchors(short, 12), short);
});

test('snapshot-backed timelines stay hidden until the initial restore settles', () => {
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
      isViewingChildSession: true,
      restoreStatus: 'loading',
    }),
    false,
  );
});
