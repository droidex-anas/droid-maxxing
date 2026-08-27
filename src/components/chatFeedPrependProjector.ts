import { transcriptEventIsVisible } from '../lib/childSessions';
import { insertChunkedSequence, replaceChunkedSequencePrefix } from '../lib/chunkedSequence';
import type { TranscriptMutation } from '../lib/transcriptMutation';
import type { TranscriptEvent } from '../types/bridge';
import type { FeedItem } from './chatFeed';
import { buildGroupedFeed, type GroupedFeedOptions } from './chatFeedTurns';

interface PreviousFeedProjection {
  allTranscript: TranscriptEvent[];
  visibleTranscript: TranscriptEvent[];
  feedItems: FeedItem[];
  earliestToolEvent: Map<string, number>;
}

export interface PrependedFeedProjection {
  visibleTranscript: TranscriptEvent[];
  feedItems: FeedItem[];
  earliestToolEvent: Map<string, number>;
  reusedVisibleEventCount: number;
}

/**
 * Builds an exact older-history prefix while retaining the cached feed from the
 * first safe user-turn boundary. Uncertain middle insertions, boundary-less
 * histories, and cross-boundary tool correlation return undefined so the
 * caller uses the canonical full projector.
 */
export function projectPrependedFeed({
  previous,
  allTranscript,
  mutation,
  childSessionId,
  options,
}: {
  previous: PreviousFeedProjection;
  allTranscript: TranscriptEvent[];
  mutation: Extract<TranscriptMutation, { kind: 'prepend' }>;
  childSessionId: string | null;
  options: GroupedFeedOptions;
}): PrependedFeedProjection | undefined {
  const insertedSourceEvents = allTranscript.slice(
    mutation.firstChangedIndex,
    mutation.firstChangedIndex + mutation.insertedCount,
  );
  const insertedVisibleEvents = insertedSourceEvents.filter((event) =>
    transcriptEventIsVisible(event, childSessionId),
  );

  if (insertedVisibleEvents.length === 0) {
    return {
      visibleTranscript: previous.visibleTranscript,
      feedItems: previous.feedItems,
      earliestToolEvent: previous.earliestToolEvent,
      reusedVisibleEventCount: previous.visibleTranscript.length,
    };
  }

  const visibleInsertionIndex = countVisibleEventsBefore(
    previous.allTranscript,
    mutation.firstChangedIndex,
    childSessionId,
  );
  if (visibleInsertionIndex !== 0) return undefined;

  const reusableEventIndex = previous.visibleTranscript.findIndex(
    (event) => event.author === 'user',
  );
  if (reusableEventIndex < 0) return undefined;
  const boundaryEvent = previous.visibleTranscript.at(reusableEventIndex);
  if (!boundaryEvent) return undefined;
  const reusableFeedIndex = previous.feedItems.findIndex(
    (item) => item.type === 'message' && item.event === boundaryEvent,
  );
  if (reusableFeedIndex < 0) return undefined;

  const rebuiltPrefixEvents = insertedVisibleEvents.concat(
    previous.visibleTranscript.slice(0, reusableEventIndex),
  );
  const prefixToolUseIds = new Set<string>();
  for (const event of rebuiltPrefixEvents) {
    if (event.toolUseId) prefixToolUseIds.add(event.toolUseId);
  }
  if (prefixToolUseIds.size > 0) {
    for (let index = reusableEventIndex; index < previous.visibleTranscript.length; index += 1) {
      const toolUseId = previous.visibleTranscript.at(index)?.toolUseId;
      if (toolUseId && prefixToolUseIds.has(toolUseId)) return undefined;
    }
  }

  // The boundary prompt is read-only lookahead: a trailing thinking row derives
  // its duration from the next event. Its cached row is retained below.
  const rebuiltFeed = buildGroupedFeed([...rebuiltPrefixEvents, boundaryEvent], false, options);
  const rebuiltBoundaryIndex = rebuiltFeed.findIndex(
    (item) => item.type === 'message' && item.event === boundaryEvent,
  );
  if (rebuiltBoundaryIndex < 0) return undefined;
  const feedItems = replaceChunkedSequencePrefix(
    previous.feedItems,
    reusableFeedIndex,
    rebuiltFeed.slice(0, rebuiltBoundaryIndex),
  );

  return {
    visibleTranscript: insertChunkedSequence(previous.visibleTranscript, 0, insertedVisibleEvents),
    feedItems,
    earliestToolEvent: shiftedToolEventIndex(previous.earliestToolEvent, insertedVisibleEvents),
    reusedVisibleEventCount: previous.visibleTranscript.length - reusableEventIndex,
  };
}

function countVisibleEventsBefore(
  events: readonly TranscriptEvent[],
  end: number,
  childSessionId: string | null,
): number {
  let count = 0;
  for (let index = 0; index < end; index += 1) {
    const event = events.at(index);
    if (event && transcriptEventIsVisible(event, childSessionId)) count += 1;
  }
  return count;
}

function shiftedToolEventIndex(
  previous: ReadonlyMap<string, number>,
  inserted: readonly TranscriptEvent[],
): Map<string, number> {
  const shifted = new Map<string, number>();
  for (let index = 0; index < inserted.length; index += 1) {
    const toolUseId = inserted.at(index)?.toolUseId;
    if (toolUseId && !shifted.has(toolUseId)) shifted.set(toolUseId, index);
  }
  for (const [toolUseId, index] of previous) {
    if (!shifted.has(toolUseId)) shifted.set(toolUseId, index + inserted.length);
  }
  return shifted;
}
