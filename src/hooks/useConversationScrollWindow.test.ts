import assert from 'node:assert/strict';
import test from 'node:test';
import {
  firstRowNotAboveViewport,
  rowIntersectsViewport,
  scrollTopForPreservedAnchor,
  shouldCancelViewportRestore,
  shouldCaptureViewportAnchorAfterScroll,
  updateViewportAnchorGeometry,
} from './conversationViewportAnchor';
import {
  applyConversationContentResize,
  didCommitRequestedHistoryPrepend,
  shouldLoadOlderHistoryAtTop,
  shouldReleaseConversationTranscript,
} from './useConversationScrollWindow';

const settledPinned = {
  isConversationLive: false,
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

test('settled primary and child conversations can release only while bottom-pinned', () => {
  assert.equal(
    shouldReleaseConversationTranscript({
      ...settledPinned,
    }),
    true,
  );
  assert.equal(
    shouldReleaseConversationTranscript({
      ...settledPinned,
      isPinned: false,
    }),
    false,
  );
});

test('live child conversations stay pinned in memory', () => {
  assert.equal(
    shouldReleaseConversationTranscript({
      ...settledPinned,
      isConversationLive: true,
    }),
    false,
  );
});

test('user movement selects a fresh prepend anchor while older history is loading', () => {
  assert.equal(
    shouldCaptureViewportAnchorAfterScroll({
      isPinned: false,
      isLoadingOlder: true,
      isRestoringViewport: false,
    }),
    true,
  );
  assert.equal(
    shouldCaptureViewportAnchorAfterScroll({
      isPinned: false,
      isLoadingOlder: true,
      isRestoringViewport: true,
    }),
    false,
  );
});

test('active user movement cancels multi-frame viewport restoration', () => {
  assert.equal(shouldCancelViewportRestore(1_840, 1_840.4), false);
  assert.equal(shouldCancelViewportRestore(1_840, 1_920), true);
  assert.equal(shouldCancelViewportRestore(null, 1_920), false);
});

test('row anchoring compensates for prepends and later interactive height changes', () => {
  const captured = { scrollTop: 1_200, rowOffsetTop: -40 };

  // An older page inserts 640 px above the row currently under the viewport.
  assert.equal(scrollTopForPreservedAnchor(captured, 600), 1_840);

  // A widget above the same row then grows by another 180 px after it mounts.
  assert.equal(scrollTopForPreservedAnchor({ scrollTop: 1_840, rowOffsetTop: 600 }, 780), 2_020);

  // Height changes below the anchor do not move the reading position.
  assert.equal(scrollTopForPreservedAnchor({ scrollTop: 2_020, rowOffsetTop: 780 }, 780), 2_020);
});

test('anchor geometry refresh keeps tracking the originally captured row', () => {
  const anchor = {
    rowId: 'message-42',
    rowOffsetTop: 24,
    scrollTop: 0,
    scrollHeight: 20_000,
  };

  assert.deepEqual(updateViewportAnchorGeometry(anchor, 3_500, 3_476, 23_500), {
    rowId: 'message-42',
    rowOffsetTop: 3_500,
    scrollTop: 3_476,
    scrollHeight: 23_500,
  });
});

test('older history loads only near the top with a cursor and no page in flight', () => {
  const nearTop = { scrollTop: 0, hasOlderCursor: true, isLoadingOlder: false };
  assert.equal(shouldLoadOlderHistoryAtTop(nearTop), true);
  assert.equal(shouldLoadOlderHistoryAtTop({ ...nearTop, scrollTop: 599 }), true);
  assert.equal(shouldLoadOlderHistoryAtTop({ ...nearTop, scrollTop: 600 }), false);
  assert.equal(shouldLoadOlderHistoryAtTop({ ...nearTop, hasOlderCursor: false }), false);
  assert.equal(shouldLoadOlderHistoryAtTop({ ...nearTop, isLoadingOlder: true }), false);
});

test('ordinary live appends do not start prepend restoration', () => {
  assert.equal(
    didCommitRequestedHistoryPrepend({
      requestedCursor: 'cursor-2',
      currentCursor: 'cursor-2',
      previousTranscriptLength: 240,
      transcriptLength: 241,
    }),
    false,
  );
  assert.equal(
    didCommitRequestedHistoryPrepend({
      requestedCursor: 'cursor-2',
      currentCursor: 'cursor-1',
      previousTranscriptLength: 240,
      transcriptLength: 289,
    }),
    true,
  );
});

test('anchor fallback ignores feed rows entirely below non-feed viewport content', () => {
  assert.equal(
    rowIntersectsViewport({
      viewportTop: 100,
      viewportBottom: 700,
      rowTop: 760,
      rowBottom: 920,
    }),
    false,
  );
  assert.equal(
    rowIntersectsViewport({
      viewportTop: 100,
      viewportBottom: 700,
      rowTop: 620,
      rowBottom: 780,
    }),
    true,
  );
});

test('anchor fallback locates a deep viewport row logarithmically', () => {
  let geometryReads = 0;
  const index = firstRowNotAboveViewport(
    10_000,
    (rowIndex) => {
      geometryReads += 1;
      return (rowIndex + 1) * 100;
    },
    543_210,
  );

  assert.equal(index, 5_432);
  assert.ok(geometryReads <= 14, `expected logarithmic reads, observed ${geometryReads}`);
});

test('content resize follows a pinned tail and preserves an unpinned row anchor', () => {
  const pinnedElement = { scrollTop: 100, scrollHeight: 2_400 } as HTMLDivElement;
  const pinned = applyConversationContentResize(pinnedElement, null, true, false);
  assert.equal(pinned.mode, 'follow-tail');
  assert.equal(pinnedElement.scrollTop, 2_400);

  const row = {
    dataset: { feedRowId: 'message-42' },
    getBoundingClientRect: () => ({ top: 300 }),
  } as HTMLElement;
  const unpinnedElement = {
    scrollTop: 1_000,
    scrollHeight: 2_500,
    getBoundingClientRect: () => ({ top: 100 }),
    querySelectorAll: () => [row],
  } as unknown as HTMLDivElement;
  const unpinned = applyConversationContentResize(
    unpinnedElement,
    {
      rowId: 'message-42',
      rowOffsetTop: 50,
      scrollTop: 1_000,
      scrollHeight: 2_000,
    },
    false,
    true,
  );

  assert.equal(unpinned.mode, 'preserve-anchor');
  assert.equal(unpinned.didFindRow, true);
  assert.equal(unpinnedElement.scrollTop, 1_150);
});
