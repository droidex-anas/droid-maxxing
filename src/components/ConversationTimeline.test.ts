import assert from 'node:assert/strict';
import test from 'node:test';
import {
  rememberTimelineCapacityBlock,
  restoreStatusForConversationTimeline,
  shouldPrimeConversationTimeline,
} from '../hooks/useConversationTimeline';

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
