import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { loadSessionHistory } from '../lib/commands';
import {
  captureViewportAnchor,
  primaryViewportOwner,
  restoreViewportAnchor,
  viewportAnchorAfterScroll,
  type ViewportAnchor,
} from './conversationViewportAnchor';

const PREFETCH_PX = 2400;
const HISTORY_PAGE_EVENT_LIMIT = 240;
const MAX_SCROLL_SNAPSHOTS = 100;

type ScrollDispatch = (
  action:
    | { type: 'TRANSCRIPT_VIEWPORT'; appSessionId: string; pinned: boolean }
    | { type: 'TRANSCRIPT_RELEASE_VIEWPORT'; appSessionId: string }
    | { type: 'SESSION_HISTORY_LOADING_OLDER'; appSessionId: string },
) => void;

interface ConversationScrollWindowOptions {
  scrollRef: RefObject<HTMLDivElement | null>;
  visibleConversationKey: string | null;
  isViewingChildSession: boolean;
  activeAppSessionId: string | undefined;
  historyAppSessionId: string | undefined;
  olderCursor: string | undefined;
  isLoadingOlder: boolean;
  transcriptLength: number;
  transcriptTailLength: number;
  retainedTranscriptLength: number;
  isPrimaryLive: boolean;
  isAutoPagingOlderHistory: boolean;
  dispatch: ScrollDispatch;
}

interface PendingHistoryPrepend {
  conversationKey: string;
  requestedCursor: string;
  transcriptLength: number;
}

export function shouldReleaseConversationTranscript(options: {
  isViewingChildSession: boolean;
  isPrimaryLive: boolean;
  isLoadingOlder: boolean;
  isAutoPagingOlderHistory: boolean;
  isPinned: boolean;
}): boolean {
  return (
    !options.isViewingChildSession &&
    !options.isPrimaryLive &&
    !options.isLoadingOlder &&
    !options.isAutoPagingOlderHistory &&
    options.isPinned
  );
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
  olderCursor,
  isLoadingOlder,
  transcriptLength,
  transcriptTailLength,
  retainedTranscriptLength,
  isPrimaryLive,
  isAutoPagingOlderHistory,
  dispatch,
}: ConversationScrollWindowOptions): {
  onScroll: () => void;
  requestOlderHistory: () => void;
} {
  const viewportAnchor = useRef<ViewportAnchor | null>(null);
  const isRestoringViewport = useRef(false);
  const isSettlingHistoryPrepend = useRef(false);
  const viewportRestoreGeneration = useRef(0);
  const pendingHistoryPrepend = useRef<PendingHistoryPrepend | null>(null);
  const isPinned = useRef(true);
  const reportedPinned = useRef<{ appSessionId: string; pinned: boolean } | null>(null);
  const isOlderRequestPending = useRef(false);
  const [scrollSnapshots] = useState(() => new Map<string, { top: number; pinned: boolean }>());
  const viewportAppSessionId = primaryViewportOwner(activeAppSessionId, isViewingChildSession);

  useEffect(() => {
    if (isLoadingOlder) return;
    isOlderRequestPending.current = false;
    pendingHistoryPrepend.current = null;
  }, [historyAppSessionId, isLoadingOlder, olderCursor]);

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
    viewportAnchor.current = null;
    isPinned.current = snapshot?.pinned ?? true;
    element.scrollTop = snapshot?.top ?? element.scrollHeight;
    if (!isPinned.current) viewportAnchor.current = captureViewportAnchor(element, true);
    if (viewportAppSessionId) {
      reportedPinned.current = {
        appSessionId: viewportAppSessionId,
        pinned: isPinned.current,
      };
      dispatch({
        type: 'TRANSCRIPT_VIEWPORT',
        appSessionId: viewportAppSessionId,
        pinned: isPinned.current,
      });
    }
  }, [dispatch, scrollRef, scrollSnapshots, viewportAppSessionId, visibleConversationKey]);

  const requestOlderHistory = useCallback(() => {
    if (!historyAppSessionId || !olderCursor || isLoadingOlder || isOlderRequestPending.current)
      return;
    isOlderRequestPending.current = true;
    const element = scrollRef.current;
    if (element && visibleConversationKey && !isPinned.current) {
      viewportAnchor.current = captureViewportAnchor(element, true);
      pendingHistoryPrepend.current = {
        conversationKey: visibleConversationKey,
        requestedCursor: olderCursor,
        transcriptLength,
      };
    } else {
      pendingHistoryPrepend.current = null;
    }
    dispatch({ type: 'SESSION_HISTORY_LOADING_OLDER', appSessionId: historyAppSessionId });
    loadSessionHistory(historyAppSessionId, olderCursor, HISTORY_PAGE_EVENT_LIMIT);
  }, [
    dispatch,
    historyAppSessionId,
    isLoadingOlder,
    olderCursor,
    scrollRef,
    transcriptLength,
    visibleConversationKey,
  ]);

  const onScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    isPinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
    if (visibleConversationKey) {
      scrollSnapshots.delete(visibleConversationKey);
      scrollSnapshots.set(visibleConversationKey, {
        top: element.scrollTop,
        pinned: isPinned.current,
      });
      while (scrollSnapshots.size > MAX_SCROLL_SNAPSHOTS) {
        const oldest = scrollSnapshots.keys().next().value;
        if (typeof oldest !== 'string') break;
        scrollSnapshots.delete(oldest);
      }
    }
    viewportAnchor.current = viewportAnchorAfterScroll({
      element,
      anchor: viewportAnchor.current,
      isPinned: isPinned.current,
      isLoadingOlder,
      isRestoringViewport: isRestoringViewport.current,
    });

    if (viewportAppSessionId) {
      const reported = reportedPinned.current;
      if (reported?.appSessionId !== viewportAppSessionId || reported.pinned !== isPinned.current) {
        reportedPinned.current = {
          appSessionId: viewportAppSessionId,
          pinned: isPinned.current,
        };
        dispatch({
          type: 'TRANSCRIPT_VIEWPORT',
          appSessionId: viewportAppSessionId,
          pinned: isPinned.current,
        });
      }
    }

    if (
      !isViewingChildSession &&
      historyAppSessionId &&
      olderCursor &&
      !isLoadingOlder &&
      element.scrollTop < PREFETCH_PX
    ) {
      requestOlderHistory();
    }
  }, [
    dispatch,
    historyAppSessionId,
    isLoadingOlder,
    isViewingChildSession,
    olderCursor,
    requestOlderHistory,
    scrollRef,
    scrollSnapshots,
    viewportAppSessionId,
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
      if (viewportAnchor.current === null || isPinned.current) {
        if (viewportRestoreGeneration.current === restoreGeneration) {
          isRestoringViewport.current = false;
          isSettlingHistoryPrepend.current = false;
        }
        return;
      }
      const restored = restoreViewportAnchor(element, viewportAnchor.current);
      viewportAnchor.current = restored.anchor;
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
        if (viewportRestoreGeneration.current === restoreGeneration) {
          isRestoringViewport.current = false;
          isSettlingHistoryPrepend.current = false;
        }
      }
    };
    settle();
    return () => {
      if (animationFrame) cancelAnimationFrame(animationFrame);
      if (viewportRestoreGeneration.current === restoreGeneration) {
        isRestoringViewport.current = false;
        isSettlingHistoryPrepend.current = false;
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
      if (ownsRestore) {
        ownedRestoreGeneration = restoreGeneration;
        if (releaseFrame) cancelAnimationFrame(releaseFrame);
        releaseFrame = requestAnimationFrame(() => {
          if (viewportAnchor.current !== null && !restored.didFindRow) {
            const retried = restoreViewportAnchor(element, viewportAnchor.current, false);
            viewportAnchor.current = retried.didFindRow
              ? retried.anchor
              : captureViewportAnchor(element, true);
          }
          if (viewportRestoreGeneration.current === restoreGeneration) {
            isRestoringViewport.current = false;
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
        isViewingChildSession,
        isPrimaryLive,
        isLoadingOlder,
        isAutoPagingOlderHistory,
        isPinned: isPinned.current,
      })
    )
      return;
    dispatch({ type: 'TRANSCRIPT_RELEASE_VIEWPORT', appSessionId: activeAppSessionId });
  }, [
    activeAppSessionId,
    dispatch,
    isAutoPagingOlderHistory,
    isLoadingOlder,
    isPrimaryLive,
    isViewingChildSession,
    retainedTranscriptLength,
  ]);

  return { onScroll, requestOlderHistory };
}
