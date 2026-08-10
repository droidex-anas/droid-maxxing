import { useMemo } from 'react';
import { promptAnchorsFromItems, type ConversationAnchor, type FeedItem } from '../components/chat';
import type { SessionRestoreStatus } from './useStore';

const TIMELINE_TARGET_ANCHORS = 12;

export function recentConversationAnchors(
  anchors: ConversationAnchor[],
  limit: number,
): ConversationAnchor[] {
  return anchors.length > limit ? anchors.slice(-limit) : anchors;
}

export function shouldPrimeConversationTimeline({
  isViewingChildSession,
  anchorCount,
  targetAnchorCount,
  restoreStatus,
}: {
  isViewingChildSession: boolean;
  anchorCount: number;
  targetAnchorCount: number;
  restoreStatus: SessionRestoreStatus | undefined;
}): boolean {
  return (
    !isViewingChildSession &&
    anchorCount < targetAnchorCount &&
    restoreStatus !== 'loaded' &&
    restoreStatus !== 'failed'
  );
}

export function useConversationTimeline({
  feedItems,
  isViewingChildSession,
  historyAppSessionId,
  olderCursor,
  isLoadingOlder,
  restoreStatus,
}: {
  feedItems: FeedItem[];
  isViewingChildSession: boolean;
  historyAppSessionId: string | undefined;
  olderCursor: string | undefined;
  isLoadingOlder: boolean;
  restoreStatus: SessionRestoreStatus | undefined;
}): {
  timelineAnchors: ReturnType<typeof promptAnchorsFromItems>;
  isTimelinePriming: boolean;
  isAutoPagingOlderHistory: boolean;
} {
  const allTimelineAnchors = useMemo(
    () => (isViewingChildSession ? [] : promptAnchorsFromItems(feedItems)),
    [feedItems, isViewingChildSession],
  );
  const timelineAnchors = useMemo(
    () => recentConversationAnchors(allTimelineAnchors, TIMELINE_TARGET_ANCHORS),
    [allTimelineAnchors],
  );
  return {
    timelineAnchors,
    isTimelinePriming: shouldPrimeConversationTimeline({
      isViewingChildSession,
      anchorCount: allTimelineAnchors.length,
      targetAnchorCount: TIMELINE_TARGET_ANCHORS,
      restoreStatus,
    }),
    isAutoPagingOlderHistory:
      !isViewingChildSession &&
      !!historyAppSessionId &&
      !!olderCursor &&
      !isLoadingOlder &&
      allTimelineAnchors.length < TIMELINE_TARGET_ANCHORS &&
      restoreStatus !== 'failed',
  };
}
