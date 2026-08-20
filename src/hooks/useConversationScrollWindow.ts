import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { loadChildHistory, loadSessionHistory } from '../lib/commands';
import { setMountedTranscriptRows } from '../lib/rendererPerf';
import {
  captureViewportAnchor,
  restoreViewportAnchor,
  shouldCancelViewportRestore,
  viewportAnchorAfterScroll,
  type ViewportAnchor,
} from './conversationViewportAnchor';

const HISTORY_PAGE_EVENT_LIMIT = 240;
// Reading near the thread's top pulls a large page so reaching the start of a
// long thread takes a few loads, not dozens. Protocol mirror of
// sidecar/src/SessionTimeline.ts MAX_HISTORY_PAGE_EVENTS.
const OLDER_HISTORY_PAGE_EVENT_LIMIT = 1_600;
const TOP_AUTO_LOAD_PX = 600;
// Prepending while a flick is still in motion fights the reader's momentum and
// feels laggy; a prepend against a settled viewport restores with zero drift.
const SCROLL_SETTLE_MS = 200;
const MAX_SCROLL_SNAPSHOTS = 100;

type ScrollDispatch = (
  action:
    | { type: 'TRANSCRIPT_VIEWPORT'; appSessionId: string; pinned: boolean }
    | { type: 'TRANSCRIPT_RELEASE_VIEWPORT'; appSessionId: string }
    | { type: 'SESSION_HISTORY_LOADING_OLDER'; appSessionId: string }
    | {
        type: 'CHILD_HISTORY_LOADING_OLDER';
        parentAppSessionId: string;
        childSessionId: string;
      }
    | {
        type: 'CHILD_TRANSCRIPT_VIEWPORT';
        parentAppSessionId: string;
        childSessionId: string;
        pinned: boolean;
      }
    | {
        type: 'CHILD_TRANSCRIPT_RELEASE_VIEWPORT';
        parentAppSessionId: string;
        childSessionId: string;
      },
) => void;

interface ConversationScrollWindowOptions {
  scrollRef: RefObject<HTMLDivElement | null>;
  visibleConversationKey: string | null;
  isViewingChildSession: boolean;
  activeAppSessionId: string | undefined;
  historyAppSessionId: string | undefined;
  historyChildSessionId: string | undefined;
  olderCursor: string | undefined;
  isLoadingOlder: boolean;
  transcriptLength: number;
  transcriptTailLength: number;
  retainedTranscriptLength: number;
  isConversationLive: boolean;
  isAutoPagingOlderHistory: boolean;
  dispatch: ScrollDispatch;
}

interface PendingHistoryPrepend {
  conversationKey: string;
  requestedCursor: string;
  transcriptLength: number;
}

interface ScrollSnapshot {
  top: number;
  pinned: boolean;
  anchor: ViewportAnchor | null;
}

function rememberScrollSnapshot(
  snapshots: Map<string, ScrollSnapshot>,
  conversationKey: string | null,
  snapshot: ScrollSnapshot,
): void {
  if (!conversationKey) return;
  snapshots.delete(conversationKey);
  snapshots.set(conversationKey, snapshot);
  while (snapshots.size > MAX_SCROLL_SNAPSHOTS) {
    const oldest = snapshots.keys().next().value;
    if (typeof oldest !== 'string') return;
    snapshots.delete(oldest);
  }
}

function shouldReportPinnedViewport(
  reported: { conversationKey: string; pinned: boolean } | null,
  conversationKey: string,
  pinned: boolean,
): boolean {
  if (!reported) return true;
  return reported.conversationKey !== conversationKey || reported.pinned !== pinned;
}

function pinnedViewportAction({
  appSessionId,
  childSessionId,
  pinned,
}: {
  appSessionId: string;
  childSessionId?: string;
  pinned: boolean;
}): Parameters<ScrollDispatch>[0] {
  if (childSessionId) {
    return {
      type: 'CHILD_TRANSCRIPT_VIEWPORT',
      parentAppSessionId: appSessionId,
      childSessionId,
      pinned,
    };
  }
  return {
    type: 'TRANSCRIPT_VIEWPORT',
    appSessionId,
    pinned,
  };
}

export function shouldReleaseConversationTranscript(options: {
  isConversationLive: boolean;
  isLoadingOlder: boolean;
  isAutoPagingOlderHistory: boolean;
  isPinned: boolean;
}): boolean {
  return (
    !options.isConversationLive &&
    !options.isLoadingOlder &&
    !options.isAutoPagingOlderHistory &&
    options.isPinned
  );
}

// Older history loads only once the reader has settled near the top: close
// enough to want more, with no page already on the way.
export function shouldLoadOlderHistoryAtTop(options: {
  scrollTop: number;
  hasOlderCursor: boolean;
  isLoadingOlder: boolean;
}): boolean {
  return options.hasOlderCursor && !options.isLoadingOlder && options.scrollTop < TOP_AUTO_LOAD_PX;
}

export function didCommitRequestedHistoryPrepend({
  requestedCursor,
  currentCursor,
  previousTranscriptLength,
  transcriptLength,
}: {
  requestedCursor: string;
  currentCursor: string | undefined;
  previousTranscriptLength: number;
  transcriptLength: number;
}): boolean {
  return requestedCursor !== currentCursor && transcriptLength > previousTranscriptLength;
}

export function useConversationScrollWindow({
  scrollRef,
  visibleConversationKey,
  isViewingChildSession,
  activeAppSessionId,
  historyAppSessionId,
  historyChildSessionId,
  olderCursor,
  isLoadingOlder,
  transcriptLength,
  transcriptTailLength,
  retainedTranscriptLength,
  isConversationLive,
  isAutoPagingOlderHistory,
  dispatch,
}: ConversationScrollWindowOptions): {
  onScroll: () => void;
  requestOlderHistory: (limit?: number) => void;
} {
  const viewportAnchor = useRef<ViewportAnchor | null>(null);
  const isRestoringViewport = useRef(false);
  const isSettlingHistoryPrepend = useRef(false);
  const expectedRestoredScrollTop = useRef<number | null>(null);
  const viewportRestoreGeneration = useRef(0);
  const pendingHistoryPrepend = useRef<PendingHistoryPrepend | null>(null);
  const isPinned = useRef(true);
  const reportedPinned = useRef<{ conversationKey: string; pinned: boolean } | null>(null);
  const isOlderRequestPending = useRef(false);
  const settledTopLoadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [scrollSnapshots] = useState(() => new Map<string, ScrollSnapshot>());

  const cancelSettledTopLoad = useCallback(() => {
    if (settledTopLoadTimer.current === null) return;
    clearTimeout(settledTopLoadTimer.current);
    settledTopLoadTimer.current = null;
  }, []);

  useEffect(() => cancelSettledTopLoad, [cancelSettledTopLoad, visibleConversationKey]);

  // Perf phase 0: the retained transcript window is what the feed mounts, so
  // report its size whenever it changes.
  useEffect(() => {
    setMountedTranscriptRows(transcriptLength);
  }, [transcriptLength]);

  useEffect(() => {
    if (isLoadingOlder) return;
    isOlderRequestPending.current = false;
    pendingHistoryPrepend.current = null;
  }, [historyAppSessionId, historyChildSessionId, isLoadingOlder, olderCursor]);

  // Scroll snapshots are current before a keyed transcript swap because every
  // user and programmatic scroll passes through onScroll.
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element || !visibleConversationKey) return;
    const snapshot = scrollSnapshots.get(visibleConversationKey);
    pendingHistoryPrepend.current = null;
    viewportRestoreGeneration.current++;
    isRestoringViewport.current = false;
    isSettlingHistoryPrepend.current = false;
    expectedRestoredScrollTop.current = null;
    viewportAnchor.current = null;
    isPinned.current = snapshot?.pinned ?? true;
    element.scrollTop = snapshot?.top ?? element.scrollHeight;
    if (!isPinned.current) {
      viewportAnchor.current = snapshot?.anchor
        ? restoreViewportAnchor(element, snapshot.anchor).anchor
        : captureViewportAnchor(element, true);
    }
    if (activeAppSessionId) {
      reportedPinned.current = {
        conversationKey: visibleConversationKey,
        pinned: isPinned.current,
      };
      dispatch(
        isViewingChildSession && historyChildSessionId
          ? {
              type: 'CHILD_TRANSCRIPT_VIEWPORT',
              parentAppSessionId: activeAppSessionId,
              childSessionId: historyChildSessionId,
              pinned: isPinned.current,
            }
          : {
              type: 'TRANSCRIPT_VIEWPORT',
              appSessionId: activeAppSessionId,
              pinned: isPinned.current,
            },
      );
    }
  }, [
    activeAppSessionId,
    dispatch,
    historyChildSessionId,
    isViewingChildSession,
    scrollRef,
    scrollSnapshots,
    visibleConversationKey,
  ]);

  const requestOlderHistory = useCallback(
    (limit: number = HISTORY_PAGE_EVENT_LIMIT) => {
      if (!historyAppSessionId || !olderCursor || isLoadingOlder || isOlderRequestPending.current)
        return;
      isOlderRequestPending.current = true;
      const element = scrollRef.current;
      if (element && visibleConversationKey) {
        if (!isPinned.current) viewportAnchor.current = captureViewportAnchor(element, true);
        pendingHistoryPrepend.current = {
          conversationKey: visibleConversationKey,
          requestedCursor: olderCursor,
          transcriptLength,
        };
      } else {
        pendingHistoryPrepend.current = null;
      }
      if (historyChildSessionId) {
        dispatch({
          type: 'CHILD_HISTORY_LOADING_OLDER',
          parentAppSessionId: historyAppSessionId,
          childSessionId: historyChildSessionId,
        });
        loadChildHistory(historyAppSessionId, historyChildSessionId, olderCursor, limit);
      } else {
        dispatch({ type: 'SESSION_HISTORY_LOADING_OLDER', appSessionId: historyAppSessionId });
        loadSessionHistory(historyAppSessionId, olderCursor, limit);
      }
    },
    [
      dispatch,
      historyAppSessionId,
      historyChildSessionId,
      isLoadingOlder,
      olderCursor,
      scrollRef,
      transcriptLength,
      visibleConversationKey,
    ],
  );

  const onScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    isPinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
    if (
      isRestoringViewport.current &&
      shouldCancelViewportRestore(expectedRestoredScrollTop.current, element.scrollTop)
    ) {
      viewportRestoreGeneration.current++;
      isRestoringViewport.current = false;
      isSettlingHistoryPrepend.current = false;
      expectedRestoredScrollTop.current = null;
      viewportAnchor.current = isPinned.current ? null : captureViewportAnchor(element, true);
    } else {
      viewportAnchor.current = viewportAnchorAfterScroll({
        element,
        anchor: viewportAnchor.current,
        isPinned: isPinned.current,
        isLoadingOlder,
        isRestoringViewport: isRestoringViewport.current,
      });
    }
    rememberScrollSnapshot(scrollSnapshots, visibleConversationKey, {
      top: element.scrollTop,
      pinned: isPinned.current,
      anchor: viewportAnchor.current,
    });

    if (activeAppSessionId && visibleConversationKey) {
      const reported = reportedPinned.current;
      if (shouldReportPinnedViewport(reported, visibleConversationKey, isPinned.current)) {
        reportedPinned.current = {
          conversationKey: visibleConversationKey,
          pinned: isPinned.current,
        };
        dispatch(
          pinnedViewportAction({
            appSessionId: activeAppSessionId,
            childSessionId: isViewingChildSession ? historyChildSessionId : undefined,
            pinned: isPinned.current,
          }),
        );
      }
    }

    // Every scroll event pushes the load out until the viewport settles, so a
    // page never prepends mid-flick.
    cancelSettledTopLoad();
    if (
      historyAppSessionId &&
      shouldLoadOlderHistoryAtTop({
        scrollTop: element.scrollTop,
        hasOlderCursor: Boolean(olderCursor),
        isLoadingOlder,
      })
    ) {
      settledTopLoadTimer.current = setTimeout(() => {
        settledTopLoadTimer.current = null;
        const settled = scrollRef.current;
        if (!settled || settled.scrollTop >= TOP_AUTO_LOAD_PX) return;
        requestOlderHistory(OLDER_HISTORY_PAGE_EVENT_LIMIT);
      }, SCROLL_SETTLE_MS);
    }
  }, [
    activeAppSessionId,
    cancelSettledTopLoad,
    dispatch,
    historyChildSessionId,
    historyAppSessionId,
    isLoadingOlder,
    isViewingChildSession,
    olderCursor,
    requestOlderHistory,
    scrollRef,
    scrollSnapshots,
    visibleConversationKey,
  ]);

  // Prepending old history keeps the exact rendered row under the user's eyes
  // fixed. A row identity is stronger than a one-shot scrollHeight delta:
  // interactive cards, diagrams, images, and content-visibility can all refine
  // their height for several frames after React commits the older page.
  useLayoutEffect(() => {
    const element = scrollRef.current;
    const pending = pendingHistoryPrepend.current;
    if (
      !element ||
      pending?.conversationKey !== visibleConversationKey ||
      !didCommitRequestedHistoryPrepend({
        requestedCursor: pending.requestedCursor,
        currentCursor: olderCursor,
        previousTranscriptLength: pending.transcriptLength,
        transcriptLength,
      }) ||
      isLoadingOlder ||
      viewportAnchor.current === null ||
      isPinned.current
    ) {
      return;
    }
    pendingHistoryPrepend.current = null;
    const restoreGeneration = ++viewportRestoreGeneration.current;
    isRestoringViewport.current = true;
    isSettlingHistoryPrepend.current = true;
    let animationFrame = 0;
    let remainingAttempts = 8;
    const settle = () => {
      if (viewportRestoreGeneration.current !== restoreGeneration) return;
      if (viewportAnchor.current === null || isPinned.current) {
        isRestoringViewport.current = false;
        isSettlingHistoryPrepend.current = false;
        expectedRestoredScrollTop.current = null;
        return;
      }
      const restored = restoreViewportAnchor(element, viewportAnchor.current);
      viewportAnchor.current = restored.anchor;
      expectedRestoredScrollTop.current = element.scrollTop;
      // content-visibility can exchange intrinsic estimates for measured row
      // heights without changing the feed's total height. Recheck for a few
      // frames even after finding the row, because a container-only observer
      // cannot see that internal redistribution.
      if (remainingAttempts > 0) {
        remainingAttempts--;
        animationFrame = requestAnimationFrame(settle);
      } else {
        if (!restored.didFindRow) {
          viewportAnchor.current = captureViewportAnchor(element, true);
        }
        isRestoringViewport.current = false;
        isSettlingHistoryPrepend.current = false;
        expectedRestoredScrollTop.current = null;
      }
    };
    settle();
    return () => {
      if (animationFrame) cancelAnimationFrame(animationFrame);
      if (viewportRestoreGeneration.current === restoreGeneration) {
        isRestoringViewport.current = false;
        isSettlingHistoryPrepend.current = false;
        expectedRestoredScrollTop.current = null;
      }
    };
  }, [isLoadingOlder, olderCursor, scrollRef, transcriptLength, visibleConversationKey]);

  // Keep compensating after the prepend commit while dynamic chat content
  // settles. This applies equally to today's markdown/tool cards and future
  // interactive app blocks whose height changes after data or animation work.
  useLayoutEffect(() => {
    const element = scrollRef.current;
    const content = element?.firstElementChild;
    if (!element || !content || typeof ResizeObserver === 'undefined') return undefined;
    let releaseFrame = 0;
    let ownedRestoreGeneration: number | null = null;
    const observer = new ResizeObserver(() => {
      if (isPinned.current || viewportAnchor.current === null) return;
      const ownsRestore = !isRestoringViewport.current;
      const restoreGeneration = ownsRestore
        ? ++viewportRestoreGeneration.current
        : viewportRestoreGeneration.current;
      isRestoringViewport.current = true;
      const restored = restoreViewportAnchor(
        element,
        viewportAnchor.current,
        isSettlingHistoryPrepend.current,
      );
      viewportAnchor.current = restored.anchor;
      expectedRestoredScrollTop.current = element.scrollTop;
      if (ownsRestore) {
        ownedRestoreGeneration = restoreGeneration;
        if (releaseFrame) cancelAnimationFrame(releaseFrame);
        releaseFrame = requestAnimationFrame(() => {
          if (viewportAnchor.current !== null && !restored.didFindRow) {
            const retried = restoreViewportAnchor(element, viewportAnchor.current, false);
            viewportAnchor.current = retried.didFindRow
              ? retried.anchor
              : captureViewportAnchor(element, true);
            expectedRestoredScrollTop.current = element.scrollTop;
          }
          if (viewportRestoreGeneration.current === restoreGeneration) {
            isRestoringViewport.current = false;
            expectedRestoredScrollTop.current = null;
          }
          ownedRestoreGeneration = null;
        });
      }
    });
    observer.observe(content);
    return () => {
      observer.disconnect();
      if (releaseFrame) cancelAnimationFrame(releaseFrame);
      if (
        ownedRestoreGeneration !== null &&
        viewportRestoreGeneration.current === ownedRestoreGeneration
      ) {
        isRestoringViewport.current = false;
        expectedRestoredScrollTop.current = null;
      }
    };
  }, [scrollRef, transcriptLength, visibleConversationKey]);

  useEffect(() => {
    const element = scrollRef.current;
    if (element && isPinned.current) element.scrollTop = element.scrollHeight;
  }, [scrollRef, transcriptLength, transcriptTailLength, visibleConversationKey]);

  useEffect(() => {
    if (
      !activeAppSessionId ||
      !shouldReleaseConversationTranscript({
        isConversationLive,
        isLoadingOlder,
        isAutoPagingOlderHistory,
        isPinned: isPinned.current,
      })
    )
      return;
    dispatch(
      isViewingChildSession && historyChildSessionId
        ? {
            type: 'CHILD_TRANSCRIPT_RELEASE_VIEWPORT',
            parentAppSessionId: activeAppSessionId,
            childSessionId: historyChildSessionId,
          }
        : { type: 'TRANSCRIPT_RELEASE_VIEWPORT', appSessionId: activeAppSessionId },
    );
  }, [
    activeAppSessionId,
    dispatch,
    historyChildSessionId,
    isAutoPagingOlderHistory,
    isConversationLive,
    isLoadingOlder,
    isViewingChildSession,
    retainedTranscriptLength,
  ]);

  return { onScroll, requestOlderHistory };
}
