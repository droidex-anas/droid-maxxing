import { useEffect, useMemo, useRef } from 'react';
import { promptAnchorsFromItems, type ConversationAnchor, type FeedItem } from '../components/chat';
import type { TranscriptEvent } from '../types/bridge';
import type { SessionRestoreStatus } from './storeChildSession';

const TIMELINE_TARGET_ANCHORS = 12;
const TIMELINE_CAPACITY_BLOCK_LIMIT = 100;
const NO_TIMELINE_ANCHORS: ConversationAnchor[] = [];

export interface TimelineAnchorProjection {
  conversationKey: string | null;
  latestPromptEvent: TranscriptEvent | undefined;
  anchors: ConversationAnchor[];
}

export function projectTimelineAnchors(
  previous: TimelineAnchorProjection | undefined,
  {
    conversationKey,
    feedItems,
    projectionMode,
  }: {
    conversationKey: string | null;
    feedItems: FeedItem[];
    projectionMode: 'full' | 'incremental';
  },
): TimelineAnchorProjection {
  let latestPromptEvent: TranscriptEvent | undefined;
  for (let index = feedItems.length - 1; index >= 0; index -= 1) {
    const item = feedItems[index];
    if (item.type === 'message' && item.event.author === 'user') {
      latestPromptEvent = item.event;
      break;
    }
  }

  // Incremental projection can only change the transcript tail. If the latest
  // user event is still the same object, every timeline id and label is still
  // identical, so long-running assistant output reuses the complete anchor set.
  if (
    projectionMode === 'incremental' &&
    previous?.conversationKey === conversationKey &&
    previous.latestPromptEvent === latestPromptEvent
  ) {
    return previous;
  }

  return {
    conversationKey,
    latestPromptEvent,
    anchors: promptAnchorsFromItems(feedItems),
  };
}

export function restoreStatusForConversationTimeline(
  restoreStatus: SessionRestoreStatus | undefined,
  restorationEnabled: boolean,
): SessionRestoreStatus {
  return restoreStatus ?? (restorationEnabled ? 'loading' : 'loaded');
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
  projectionMode,
  isViewingChildSession,
  conversationKey,
  historyAppSessionId,
  olderCursor,
  isLoadingOlder,
  isTranscriptWindowAtCapacity,
  restoreStatus,
}: {
  feedItems: FeedItem[];
  projectionMode: 'full' | 'incremental';
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
  // Every loaded prompt gets a dot so the rail mirrors the whole reachable
  // thread; the rail itself scrolls once the dot list outgrows its gutter.
  // Render only reads the projection; the committed ref update happens in the
  // effect below, and a child view commits undefined to clear it.
  const anchorProjectionRef = useRef<TimelineAnchorProjection | undefined>(undefined);
  const anchorProjection = useMemo(() => {
    if (isViewingChildSession) return undefined;
    return projectTimelineAnchors(anchorProjectionRef.current, {
      conversationKey,
      feedItems,
      projectionMode,
    });
  }, [conversationKey, feedItems, isViewingChildSession, projectionMode]);
  useEffect(() => {
    anchorProjectionRef.current = anchorProjection;
  }, [anchorProjection]);
  const timelineAnchors = anchorProjection?.anchors ?? NO_TIMELINE_ANCHORS;
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
    anchorCount: timelineAnchors.length,
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
