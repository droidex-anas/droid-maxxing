import { transcriptEventIsVisible, transcriptForVisibleSession } from '../lib/childSessions';
import { asChunkedSequence, replaceChunkedSequenceSuffix } from '../lib/chunkedSequence';
import { noteFeedProjection } from '../lib/rendererPerf';
import type { TranscriptMutation } from '../lib/transcriptMutation';
import { INACTIVE_TRANSCRIPT_POLICY } from '../lib/transcriptWindow';
import type { TranscriptEvent } from '../types/bridge';
import { buildGroupedFeed, type FeedItem, type GroupedFeedOptions } from './chat';
import { projectPrependedFeed } from './chatFeedPrependProjector';

export interface ChatFeedProjectorInput {
  conversationKey: string;
  allTranscript: TranscriptEvent[];
  transcriptMutation: TranscriptMutation | undefined;
  childSessionId: string | null;
  pending: boolean;
  options: GroupedFeedOptions;
  retainedCost?: number;
}

export interface ChatFeedProjection {
  visibleTranscript: TranscriptEvent[];
  feedItems: FeedItem[];
  mode: 'full' | 'incremental';
  updateKind: 'full' | 'append' | 'prepend';
  rebuiltFromVisibleIndex: number;
  rebuiltFromFeedItemIndex: number;
  reusedVisibleEventCount: number;
}

interface NormalizedOptions {
  childSessionCards: boolean;
  groupChildSessions: boolean;
  specContent?: string;
  changes: boolean;
}

interface ProjectionCache extends ChatFeedProjection {
  conversationKey: string;
  allTranscript: TranscriptEvent[];
  childSessionId: string | null;
  revision: number;
  pending: boolean;
  options: NormalizedOptions;
  retainedCost: number | undefined;
  earliestToolEvent: Map<string, number>;
}

type ProjectionMode = 'full' | 'incremental' | 'cache' | 'invisible';

// Keep switching instant for the two most recent ordinary transcript windows
// without retaining pathological histories after their store window is released.
export const CHAT_FEED_WARM_CACHE_MAX_VISIBLE_EVENTS = 1_600;
export const CHAT_FEED_WARM_CACHE_MAX_RETAINED_COST = INACTIVE_TRANSCRIPT_POLICY.highWaterCost;
const CHAT_FEED_WARM_CACHE_MAX_CONVERSATIONS = 2;

export function createChatFeedProjector(): (input: ChatFeedProjectorInput) => ChatFeedProjection {
  let cache: ProjectionCache | undefined;
  const warmCaches = new Map<string, ProjectionCache>();

  return (input) => {
    const startedAt = performance.now();
    cache = cacheForConversation(cache, warmCaches, input.conversationKey);
    const options = normalizeOptions(input.options);
    const revision = input.transcriptMutation?.revision ?? 0;
    const projected = projectFeed(cache, input, options, revision);
    cache = projected.cache;
    return recordProjection(cache, projected.mode, startedAt);
  };
}

function cacheForConversation(
  cache: ProjectionCache | undefined,
  warmCaches: Map<string, ProjectionCache>,
  conversationKey: string,
): ProjectionCache | undefined {
  if (!cache || cache.conversationKey === conversationKey) return cache;
  const target = warmCaches.get(conversationKey);
  warmCaches.delete(conversationKey);
  rememberWarmCache(warmCaches, cache);
  return target;
}

function projectFeed(
  cache: ProjectionCache | undefined,
  input: ChatFeedProjectorInput,
  options: NormalizedOptions,
  revision: number,
): { cache: ProjectionCache; mode: ProjectionMode } {
  if (cache && cacheMatches(cache, input, options, revision)) return { cache, mode: 'cache' };
  if (cache && canAppend(cache, input, options)) {
    const previousVisibleTranscript = cache.visibleTranscript;
    const appended = incrementalProjection(cache, input, options, revision);
    if (appended.mode === 'full') return { cache: appended, mode: 'full' };
    return {
      cache: appended,
      mode: appended.visibleTranscript === previousVisibleTranscript ? 'invisible' : 'incremental',
    };
  }
  if (cache && canPrepend(cache, input, options)) {
    const prepended = prependProjection(cache, input, options, revision);
    if (prepended) {
      return {
        cache: prepended,
        mode: prepended.visibleTranscript === cache.visibleTranscript ? 'invisible' : 'incremental',
      };
    }
  }
  return { cache: fullProjection(input, options, revision), mode: 'full' };
}

function cacheMatches(
  cache: ProjectionCache,
  input: ChatFeedProjectorInput,
  options: NormalizedOptions,
  revision: number,
): boolean {
  return (
    cache.conversationKey === input.conversationKey &&
    cache.childSessionId === input.childSessionId &&
    cache.allTranscript === input.allTranscript &&
    cache.revision === revision &&
    cache.pending === input.pending &&
    sameOptions(cache.options, options)
  );
}

function recordProjection(
  projection: ProjectionCache,
  mode: ProjectionMode,
  startedAt: number,
): ChatFeedProjection {
  let reusedVisibleEventCount = projection.reusedVisibleEventCount;
  if (mode === 'full') reusedVisibleEventCount = 0;
  else if (mode === 'cache' || mode === 'invisible') {
    reusedVisibleEventCount = projection.visibleTranscript.length;
  }
  noteFeedProjection({
    mode,
    durationMs: performance.now() - startedAt,
    visibleEventCount: projection.visibleTranscript.length,
    reusedVisibleEventCount,
  });
  return projection;
}

function rememberWarmCache(warmCaches: Map<string, ProjectionCache>, cache: ProjectionCache): void {
  if (
    cache.visibleTranscript.length > CHAT_FEED_WARM_CACHE_MAX_VISIBLE_EVENTS ||
    cache.allTranscript.length > CHAT_FEED_WARM_CACHE_MAX_VISIBLE_EVENTS ||
    cache.retainedCost === undefined ||
    cache.retainedCost > CHAT_FEED_WARM_CACHE_MAX_RETAINED_COST
  ) {
    return;
  }
  warmCaches.delete(cache.conversationKey);
  warmCaches.set(cache.conversationKey, cache);
  while (warmCaches.size > CHAT_FEED_WARM_CACHE_MAX_CONVERSATIONS) {
    const oldest = warmCaches.keys().next().value;
    if (oldest === undefined) return;
    warmCaches.delete(oldest);
  }
}

function hasIncrementalBase(
  cache: ProjectionCache,
  input: ChatFeedProjectorInput,
  options: NormalizedOptions,
): boolean {
  const mutation = input.transcriptMutation;
  return Boolean(
    mutation &&
    cache.conversationKey === input.conversationKey &&
    cache.childSessionId === input.childSessionId &&
    cache.pending === input.pending &&
    sameOptions(cache.options, options) &&
    mutation.baseRevision === cache.revision &&
    mutation.previousLength === cache.allTranscript.length &&
    mutation.firstChangedIndex <= cache.allTranscript.length,
  );
}

function canAppend(
  cache: ProjectionCache,
  input: ChatFeedProjectorInput,
  options: NormalizedOptions,
): boolean {
  const mutation = input.transcriptMutation;
  return (
    hasIncrementalBase(cache, input, options) &&
    mutation?.kind === 'append' &&
    input.allTranscript.length >= cache.allTranscript.length &&
    input.allTranscript.length >= mutation.firstChangedIndex
  );
}

function canPrepend(
  cache: ProjectionCache,
  input: ChatFeedProjectorInput,
  options: NormalizedOptions,
): boolean {
  const mutation = input.transcriptMutation;
  return (
    hasIncrementalBase(cache, input, options) &&
    mutation?.kind === 'prepend' &&
    input.allTranscript.length === cache.allTranscript.length + mutation.insertedCount
  );
}

function fullProjection(
  input: ChatFeedProjectorInput,
  options: NormalizedOptions,
  revision: number,
): ProjectionCache {
  const visibleTranscript = transcriptForVisibleSession(input.allTranscript, input.childSessionId);
  const chunkedVisibleTranscript = asChunkedSequence(visibleTranscript);
  return {
    conversationKey: input.conversationKey,
    allTranscript: input.allTranscript,
    childSessionId: input.childSessionId,
    revision,
    pending: input.pending,
    options,
    retainedCost: input.retainedCost,
    visibleTranscript: chunkedVisibleTranscript,
    feedItems: asChunkedSequence(
      buildGroupedFeed(chunkedVisibleTranscript, input.pending, options),
    ),
    earliestToolEvent: indexToolEvents(chunkedVisibleTranscript),
    mode: 'full',
    updateKind: 'full',
    rebuiltFromVisibleIndex: 0,
    rebuiltFromFeedItemIndex: 0,
    reusedVisibleEventCount: 0,
  };
}

function incrementalProjection(
  previous: ProjectionCache,
  input: ChatFeedProjectorInput,
  options: NormalizedOptions,
  revision: number,
): ProjectionCache {
  const firstSourceChange = input.transcriptMutation?.firstChangedIndex ?? 0;
  let visiblePrefixLength = previous.visibleTranscript.length;
  for (let index = firstSourceChange; index < previous.allTranscript.length; index += 1) {
    const event = previous.allTranscript.at(index);
    if (event && transcriptEventIsVisible(event, input.childSessionId)) {
      visiblePrefixLength -= 1;
    }
  }

  const visibleSuffix: TranscriptEvent[] = [];
  for (let index = firstSourceChange; index < input.allTranscript.length; index += 1) {
    const event = input.allTranscript.at(index);
    if (event && transcriptEventIsVisible(event, input.childSessionId)) visibleSuffix.push(event);
  }
  const previousSuffix = previous.visibleTranscript.slice(visiblePrefixLength);
  const visibleChanged = !sameEvents(previousSuffix, visibleSuffix);

  if (!visibleChanged) {
    return {
      ...previous,
      allTranscript: input.allTranscript,
      revision,
      retainedCost: input.retainedCost,
      mode: 'incremental',
      updateKind: 'append',
      rebuiltFromVisibleIndex: previous.visibleTranscript.length,
      rebuiltFromFeedItemIndex: previous.feedItems.length,
      reusedVisibleEventCount: previous.visibleTranscript.length,
    };
  }

  const visibleTranscript = replaceChunkedSequenceSuffix(
    previous.visibleTranscript,
    visiblePrefixLength,
    visibleSuffix,
  );
  const newToolEvents = indexToolEvents(visibleSuffix, visiblePrefixLength);
  const rewindIndex = safeTurnStart(
    previous,
    visibleTranscript,
    visiblePrefixLength,
    newToolEvents,
  );
  const prefixItemCount = feedPrefixItemCount(previous.feedItems, visibleTranscript, rewindIndex);
  if (prefixItemCount === undefined) return fullProjection(input, options, revision);

  updateToolEventIndex(previous.earliestToolEvent, previous.visibleTranscript, visiblePrefixLength);
  for (const [toolUseId, index] of newToolEvents) {
    if (!previous.earliestToolEvent.has(toolUseId)) {
      previous.earliestToolEvent.set(toolUseId, index);
    }
  }
  const rebuiltItems = buildGroupedFeed(
    visibleTranscript.slice(rewindIndex),
    input.pending,
    options,
  );
  const feedItems = replaceChunkedSequenceSuffix(previous.feedItems, prefixItemCount, rebuiltItems);

  return {
    conversationKey: input.conversationKey,
    allTranscript: input.allTranscript,
    childSessionId: input.childSessionId,
    revision,
    pending: input.pending,
    options,
    retainedCost: input.retainedCost,
    visibleTranscript,
    feedItems,
    earliestToolEvent: previous.earliestToolEvent,
    mode: 'incremental',
    updateKind: 'append',
    rebuiltFromVisibleIndex: rewindIndex,
    rebuiltFromFeedItemIndex: prefixItemCount,
    reusedVisibleEventCount: rewindIndex,
  };
}

function prependProjection(
  previous: ProjectionCache,
  input: ChatFeedProjectorInput,
  options: NormalizedOptions,
  revision: number,
): ProjectionCache | undefined {
  const mutation = input.transcriptMutation;
  if (mutation?.kind !== 'prepend') return undefined;
  const projection = projectPrependedFeed({
    previous,
    allTranscript: input.allTranscript,
    mutation,
    childSessionId: input.childSessionId,
    options,
  });
  if (!projection) return undefined;
  const visibleChanged = projection.visibleTranscript !== previous.visibleTranscript;

  return {
    conversationKey: input.conversationKey,
    allTranscript: input.allTranscript,
    childSessionId: input.childSessionId,
    revision,
    pending: input.pending,
    options,
    retainedCost: input.retainedCost,
    visibleTranscript: projection.visibleTranscript,
    feedItems: projection.feedItems,
    earliestToolEvent: projection.earliestToolEvent,
    mode: 'incremental',
    updateKind: visibleChanged ? 'prepend' : 'append',
    rebuiltFromVisibleIndex: visibleChanged ? 0 : previous.visibleTranscript.length,
    rebuiltFromFeedItemIndex: visibleChanged ? 0 : previous.feedItems.length,
    reusedVisibleEventCount: projection.reusedVisibleEventCount,
  };
}

function safeTurnStart(
  previous: ProjectionCache,
  events: TranscriptEvent[],
  firstChangedIndex: number,
  newToolEvents: ReadonlyMap<string, number>,
): number {
  let earliest = firstChangedIndex;
  for (let index = firstChangedIndex; index < previous.visibleTranscript.length; index += 1) {
    const event = previous.visibleTranscript.at(index);
    if (!event) continue;
    earliest = earliestCorrelatedIndex(
      event,
      earliest,
      previous.earliestToolEvent,
      newToolEvents,
      firstChangedIndex,
    );
  }
  for (let index = firstChangedIndex; index < events.length; index += 1) {
    const event = events.at(index);
    if (!event) continue;
    earliest = earliestCorrelatedIndex(
      event,
      earliest,
      previous.earliestToolEvent,
      newToolEvents,
      firstChangedIndex,
    );
  }

  let boundary = enclosingUserTurn(events, earliest);
  const changedEvent = events.at(firstChangedIndex);
  if (
    changedEvent?.author === 'user' &&
    previous.visibleTranscript[firstChangedIndex] !== changedEvent
  ) {
    boundary = enclosingUserTurn(events, Math.max(0, boundary - 1));
  }

  while (boundary > 0) {
    let correlated = boundary;
    for (let index = boundary; index < events.length; index += 1) {
      const event = events.at(index);
      if (!event) continue;
      correlated = earliestCorrelatedIndex(
        event,
        correlated,
        previous.earliestToolEvent,
        newToolEvents,
        firstChangedIndex,
      );
    }
    const expanded = enclosingUserTurn(events, correlated);
    if (expanded >= boundary) break;
    boundary = expanded;
  }
  return boundary;
}

function earliestCorrelatedIndex(
  event: TranscriptEvent,
  current: number,
  previous: ReadonlyMap<string, number>,
  added: ReadonlyMap<string, number>,
  retainedLength: number,
): number {
  if (!event.toolUseId) return current;
  const previousIndex = previous.get(event.toolUseId);
  const retainedIndex =
    previousIndex !== undefined && previousIndex < retainedLength ? previousIndex : undefined;
  return Math.min(current, retainedIndex ?? Infinity, added.get(event.toolUseId) ?? Infinity);
}

function enclosingUserTurn(events: readonly TranscriptEvent[], fromIndex: number): number {
  for (let index = Math.min(fromIndex, events.length - 1); index >= 0; index -= 1) {
    if (events.at(index)?.author === 'user') return index;
  }
  return 0;
}

function feedPrefixItemCount(
  items: readonly FeedItem[],
  events: readonly TranscriptEvent[],
  rewindIndex: number,
): number | undefined {
  if (rewindIndex === 0) return 0;
  const boundary = events.at(rewindIndex);
  if (!boundary) return undefined;
  if (boundary.author !== 'user') return undefined;
  const boundaryId = boundary.id;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items.at(index);
    if (item?.type === 'message' && item.event.id === boundaryId) return index;
  }
  return undefined;
}

function updateToolEventIndex(
  index: Map<string, number>,
  previousEvents: readonly TranscriptEvent[],
  retainedLength: number,
): void {
  for (let eventIndex = retainedLength; eventIndex < previousEvents.length; eventIndex += 1) {
    const toolUseId = previousEvents.at(eventIndex)?.toolUseId;
    if (toolUseId && index.get(toolUseId) === eventIndex) index.delete(toolUseId);
  }
}

function indexToolEvents(events: readonly TranscriptEvent[], offset = 0): Map<string, number> {
  const index = new Map<string, number>();
  for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
    const toolUseId = events.at(eventIndex)?.toolUseId;
    if (toolUseId && !index.has(toolUseId)) index.set(toolUseId, offset + eventIndex);
  }
  return index;
}

function sameEvents(left: readonly TranscriptEvent[], right: readonly TranscriptEvent[]): boolean {
  return left.length === right.length && left.every((event, index) => event === right[index]);
}

function normalizeOptions(options: GroupedFeedOptions): NormalizedOptions {
  return {
    childSessionCards: options.childSessionCards ?? false,
    groupChildSessions: options.groupChildSessions ?? false,
    ...(options.specContent !== undefined ? { specContent: options.specContent } : {}),
    changes: options.changes ?? false,
  };
}

function sameOptions(left: NormalizedOptions, right: NormalizedOptions): boolean {
  return (
    left.childSessionCards === right.childSessionCards &&
    left.groupChildSessions === right.groupChildSessions &&
    left.specContent === right.specContent &&
    left.changes === right.changes
  );
}
