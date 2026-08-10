import { useMemo } from 'react';
import {
  promptAnchorsFromItems,
  recentConversationAnchors,
  shouldPrimeConversationTimeline,
  type FeedItem,
} from '../components/chat';
import type { SessionRestoreStatus } from './useStore';

const TIMELINE_TARGET_ANCHORS = 12;

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
