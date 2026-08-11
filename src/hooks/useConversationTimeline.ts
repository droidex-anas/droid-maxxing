import { useEffect, useMemo, useRef } from 'react';
import { promptAnchorsFromItems, type ConversationAnchor, type FeedItem } from '../components/chat';
import type { SessionRestoreStatus } from './useStore';

const TIMELINE_TARGET_ANCHORS = 12;
const TIMELINE_CAPACITY_BLOCK_LIMIT = 100;

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
  isTranscriptWindowAtCapacity = false,
}: {
  isViewingChildSession: boolean;
  anchorCount: number;
  targetAnchorCount: number;
  restoreStatus: SessionRestoreStatus | undefined;
  isTranscriptWindowAtCapacity?: boolean;
}): boolean {
  return (
    !isViewingChildSession &&
    anchorCount < targetAnchorCount &&
    restoreStatus !== 'loaded' &&
    restoreStatus !== 'failed' &&
    !isTranscriptWindowAtCapacity
  );
}

export function rememberTimelineCapacityBlock(
  blockedConversationKeys: ReadonlySet<string>,
  conversationKey: string | null,
  isTranscriptWindowAtCapacity: boolean,
): ReadonlySet<string> {
  if (
    !conversationKey ||
    !isTranscriptWindowAtCapacity ||
    blockedConversationKeys.has(conversationKey)
  ) {
    return blockedConversationKeys;
  }
  const next = new Set(blockedConversationKeys);
  next.add(conversationKey);
  if (next.size > TIMELINE_CAPACITY_BLOCK_LIMIT) {
    const [oldestConversationKey] = next;
    if (oldestConversationKey) next.delete(oldestConversationKey);
  }
  return next;
}

export function useConversationTimeline({
  feedItems,
  isViewingChildSession,
  conversationKey,
  historyAppSessionId,
  olderCursor,
  isLoadingOlder,
  isTranscriptWindowAtCapacity,
  restoreStatus,
}: {
  feedItems: FeedItem[];
  isViewingChildSession: boolean;
  conversationKey: string | null;
  historyAppSessionId: string | undefined;
  olderCursor: string | undefined;
  isLoadingOlder: boolean;
  isTranscriptWindowAtCapacity: boolean;
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
  const capacityBlockedConversationsRef = useRef<ReadonlySet<string>>(new Set());
  useEffect(() => {
    capacityBlockedConversationsRef.current = rememberTimelineCapacityBlock(
      capacityBlockedConversationsRef.current,
      conversationKey,
      isTranscriptWindowAtCapacity,
    );
  }, [conversationKey, isTranscriptWindowAtCapacity]);
  const isTimelineCapacityBlocked =
    isTranscriptWindowAtCapacity ||
    Boolean(conversationKey && capacityBlockedConversationsRef.current.has(conversationKey));
  const isTimelinePriming = shouldPrimeConversationTimeline({
    isViewingChildSession,
    anchorCount: allTimelineAnchors.length,
    targetAnchorCount: TIMELINE_TARGET_ANCHORS,
    restoreStatus,
    isTranscriptWindowAtCapacity: isTimelineCapacityBlocked,
  });
  return {
    timelineAnchors,
    isTimelinePriming,
    isAutoPagingOlderHistory:
      isTimelinePriming &&
      !!historyAppSessionId &&
      !!olderCursor &&
      !isLoadingOlder &&
      restoreStatus !== 'failed',
  };
}
