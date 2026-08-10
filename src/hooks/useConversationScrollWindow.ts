import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { loadSessionHistory } from '../lib/commands';

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
  const prependAnchor = useRef<{ height: number; top: number } | null>(null);
  const isPinned = useRef(true);
  const reportedPinned = useRef<{ appSessionId: string; pinned: boolean } | null>(null);
  const isOlderRequestPending = useRef(false);
  const [scrollSnapshots] = useState(() => new Map<string, { top: number; pinned: boolean }>());

  useEffect(() => {
    if (!isLoadingOlder) isOlderRequestPending.current = false;
  }, [historyAppSessionId, isLoadingOlder, olderCursor]);

  // Scroll snapshots are current before a keyed transcript swap because every
  // user and programmatic scroll passes through onScroll.
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element || !visibleConversationKey) return;
    const snapshot = scrollSnapshots.get(visibleConversationKey);
    prependAnchor.current = null;
    isPinned.current = snapshot?.pinned ?? true;
    element.scrollTop = snapshot?.top ?? element.scrollHeight;
    if (activeAppSessionId) {
      reportedPinned.current = {
        appSessionId: activeAppSessionId,
        pinned: isPinned.current,
      };
      dispatch({
        type: 'TRANSCRIPT_VIEWPORT',
        appSessionId: activeAppSessionId,
        pinned: isPinned.current,
      });
    }
  }, [
    activeAppSessionId,
    dispatch,
    isViewingChildSession,
    scrollRef,
    scrollSnapshots,
    visibleConversationKey,
  ]);

  const requestOlderHistory = useCallback(() => {
    if (!historyAppSessionId || !olderCursor || isLoadingOlder || isOlderRequestPending.current)
      return;
    isOlderRequestPending.current = true;
    const element = scrollRef.current;
    if (element) {
      prependAnchor.current = { height: element.scrollHeight, top: element.scrollTop };
    }
    dispatch({ type: 'SESSION_HISTORY_LOADING_OLDER', appSessionId: historyAppSessionId });
    loadSessionHistory(historyAppSessionId, olderCursor, HISTORY_PAGE_EVENT_LIMIT);
  }, [dispatch, historyAppSessionId, isLoadingOlder, olderCursor, scrollRef]);

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

    if (activeAppSessionId) {
      const reported = reportedPinned.current;
      if (reported?.appSessionId !== activeAppSessionId || reported.pinned !== isPinned.current) {
        reportedPinned.current = {
          appSessionId: activeAppSessionId,
          pinned: isPinned.current,
        };
        dispatch({
          type: 'TRANSCRIPT_VIEWPORT',
          appSessionId: activeAppSessionId,
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
    activeAppSessionId,
    dispatch,
    historyAppSessionId,
    isLoadingOlder,
    isViewingChildSession,
    olderCursor,
    requestOlderHistory,
    scrollRef,
    scrollSnapshots,
    visibleConversationKey,
  ]);

  // Prepending old history keeps the content under the user's eyes fixed.
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element || prependAnchor.current === null || isLoadingOlder) return;
    const delta = element.scrollHeight - prependAnchor.current.height;
    if (delta > 0) element.scrollTop = prependAnchor.current.top + delta;
    prependAnchor.current = null;
  }, [isLoadingOlder, scrollRef, transcriptLength]);

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
