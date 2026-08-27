import assert from 'node:assert/strict';
import test from 'node:test';
import {
  firstRowNotAboveViewport,
  restoreViewportAnchor,
  rowIntersectsViewport,
  scrollTopForPreservedAnchor,
  shouldCancelViewportRestore,
  shouldCaptureViewportAnchorAfterScroll,
  updateViewportAnchorGeometry,
} from './conversationViewportAnchor';
import {
  applyConversationContentResize,
  didCommitRequestedHistoryPrepend,
  shouldBindConversationContentResize,
  shouldCompensateConversationContentResize,
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

  const unpinnedElement = { scrollTop: 1_000, scrollHeight: 2_500 } as HTMLDivElement;
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
    { rowContentOffset: (rowId) => (rowId === 'message-42' ? 1_200 : undefined) },
  );

  assert.equal(unpinned.mode, 'preserve-anchor');
  assert.equal(unpinned.didFindRow, true);
  assert.equal(unpinnedElement.scrollTop, 1_150);
});

test('restore without a layout offset uses height fallback, not a mounted DOM row', () => {
  const row = {
    dataset: { feedRowId: 'message-42' },
    getBoundingClientRect: () => ({ top: 300 }),
  } as HTMLElement;
  const element = {
    scrollTop: 1_000,
    scrollHeight: 2_500,
    getBoundingClientRect: () => ({ top: 100 }),
    querySelector: () => row,
    querySelectorAll: () => [row],
  } as unknown as HTMLDivElement;

  const restored = restoreViewportAnchor(
    element,
    {
      rowId: 'message-42',
      rowOffsetTop: 50,
      scrollTop: 1_000,
      scrollHeight: 2_000,
    },
    true,
  );

  assert.equal(restored.didFindRow, false);
  assert.equal(element.scrollTop, 1_500);
});

test('restore falls back to height delta when the layout misses the captured row', () => {
  const element = { scrollTop: 1_000, scrollHeight: 2_500 } as HTMLDivElement;
  const restored = restoreViewportAnchor(
    element,
    {
      rowId: 'message:gone',
      rowOffsetTop: 50,
      scrollTop: 1_000,
      scrollHeight: 2_000,
    },
    true,
    { rowContentOffset: () => undefined },
  );

  assert.equal(restored.didFindRow, false);
  assert.equal(element.scrollTop, 1_500);
});

test('virtual layout restore preserves an unpinned row when it is not mounted', () => {
  const element = { scrollTop: 400, scrollHeight: 12_000 } as HTMLDivElement;
  const restored = restoreViewportAnchor(
    element,
    {
      rowId: 'message:anchor',
      rowOffsetTop: 40,
      scrollTop: 400,
      scrollHeight: 8_000,
    },
    true,
    { rowContentOffset: (rowId) => (rowId === 'message:anchor' ? 3_200 : undefined) },
  );

  assert.equal(restored.didFindRow, true);
  assert.equal(element.scrollTop, 3_160);
  assert.equal(restored.anchor.rowId, 'message:anchor');
});

test('content resize binding follows the live first child even with an empty transcript', () => {
  const container = {} as HTMLDivElement;
  const welcome = {} as Element;
  const composeSkeleton = {} as Element;

  // First bind while the transcript is still empty.
  assert.equal(
    shouldBindConversationContentResize({
      binding: null,
      element: container,
      content: welcome,
      conversationKey: 'session-a',
    }),
    true,
  );
  const binding = { element: container, content: welcome, conversationKey: 'session-a' };

  // Same child and conversation: nothing to rebind.
  assert.equal(
    shouldBindConversationContentResize({
      binding,
      element: container,
      content: welcome,
      conversationKey: 'session-a',
    }),
    false,
  );

  // The conversation content element is swapped with the transcript still at
  // zero events; the observer must follow the replacement child.
  assert.equal(
    shouldBindConversationContentResize({
      binding,
      element: container,
      content: composeSkeleton,
      conversationKey: 'session-a',
    }),
    true,
  );

  // A conversation switch rebinds even when the container keeps its child.
  assert.equal(
    shouldBindConversationContentResize({
      binding,
      element: container,
      content: welcome,
      conversationKey: 'session-b',
    }),
    true,
  );

  // No container or child means nothing can be observed.
  assert.equal(
    shouldBindConversationContentResize({
      binding: null,
      element: null,
      content: null,
      conversationKey: 'session-a',
    }),
    false,
  );
});

test('content resize compensation stays off during an unpinned user scroll', () => {
  assert.equal(
    shouldCompensateConversationContentResize({
      isPinned: false,
      isSettlingHistoryPrepend: false,
      isUserScrolling: true,
    }),
    false,
  );
  assert.equal(
    shouldCompensateConversationContentResize({
      isPinned: true,
      isSettlingHistoryPrepend: false,
      isUserScrolling: true,
    }),
    true,
  );
  assert.equal(
    shouldCompensateConversationContentResize({
      isPinned: false,
      isSettlingHistoryPrepend: true,
      isUserScrolling: true,
    }),
    true,
  );
  assert.equal(
    shouldCompensateConversationContentResize({
      isPinned: false,
      isSettlingHistoryPrepend: false,
      isUserScrolling: false,
    }),
    true,
  );
});
