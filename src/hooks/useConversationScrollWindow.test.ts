import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldReleaseConversationTranscript } from './useConversationScrollWindow';

const settledPinned = {
  isViewingChildSession: false,
  isPrimaryLive: false,
  isLoadingOlder: false,
  isAutoPagingOlderHistory: false,
  isPinned: true,
};

test('settled transcript release waits for older-history paging to finish', () => {
  assert.equal(shouldReleaseConversationTranscript(settledPinned), true);
  assert.equal(
    shouldReleaseConversationTranscript({
      ...settledPinned,
      isAutoPagingOlderHistory: true,
    }),
    false,
  );
  assert.equal(
    shouldReleaseConversationTranscript({
      ...settledPinned,
      isLoadingOlder: true,
    }),
    false,
  );
});

test('child and scrolled-up conversations stay pinned in memory', () => {
  assert.equal(
    shouldReleaseConversationTranscript({
      ...settledPinned,
      isViewingChildSession: true,
    }),
    false,
  );
  assert.equal(
    shouldReleaseConversationTranscript({
      ...settledPinned,
      isPinned: false,
    }),
    false,
  );
});
