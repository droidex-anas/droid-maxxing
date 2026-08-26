import type { TranscriptEvent } from '../types/bridge';
import type { TranscriptMutationChange } from './transcriptMutation';
import {
  asChunkedSequence,
  insertChunkedSequence,
  replaceChunkedSequenceSuffix,
} from './chunkedSequence';
import {
  estimateAppendedTranscriptCost,
  estimateReplacedTranscriptTailCost,
} from './transcriptWindow';
import { isChildSessionTool, mergeChildSessionSpawn } from './childSessionEvents';

export interface TranscriptIngestionResult {
  events: TranscriptEvent[];
  estimatedCost: number;
  change: TranscriptMutationChange | null;
}

interface TranscriptRuntime {
  events: TranscriptEvent[];
  eventIds: EventIdIndex;
  indexes: TranscriptIndexes;
}

interface TranscriptIndexes {
  firstUserEvent: TranscriptEvent | undefined;
  firstUserIndex: number | undefined;
  latestActivityBySource: ReadonlyMap<string, TranscriptEvent>;
  childSpawns: ReadonlyMap<string, TranscriptEvent>;
}

interface EventIdIndex {
  buckets: readonly (ReadonlySet<string> | undefined)[];
}

const EVENT_ID_BUCKET_COUNT = 256;
const transcriptRuntimes = new WeakMap<readonly TranscriptEvent[], TranscriptRuntime>();

/**
 * Applies one ordered run to immutable settled chunks and a bounded live
 * chunk. Incoming streaming delta IDs intentionally do not enter the retained
 * index because coalescing does not retain those events; this mirrors the
 * sidecar's literal delta semantics.
 */
export function ingestTranscriptEvents(
  previous: TranscriptEvent[],
  previousCost: number,
  incoming: readonly TranscriptEvent[],
): TranscriptIngestionResult {
  const previousRuntime = transcriptRuntime(previous);
  let events = previousRuntime.events;
  let eventIds = previousRuntime.eventIds;
  let indexes = previousRuntime.indexes;
  let estimatedCost = previousCost;
  let firstChangedIndex: number | undefined;

  const recordChange = (index: number): void => {
    firstChangedIndex = Math.min(firstChangedIndex ?? index, index);
  };

  for (const event of incoming) {
    if (hasEventId(eventIds, event.id)) continue;
    const last = events.at(-1);

    // Protocol mirror of sidecar/src/SessionTimeline.ts mergeStreamingDelta().
    // Keep both implementations and their behavior tests synchronized.
    const textDelta = getTextDeltaRun(last, event);
    if (textDelta) {
      const changedIndex = events.length - 1;
      const mergedTail: TranscriptEvent = {
        ...textDelta.previous,
        text: (textDelta.previous.text ?? '') + textDelta.text,
        endTs: event.endTs ?? event.ts,
      };
      events = replaceChunkedSequenceSuffix(events, changedIndex, [mergedTail]);
      indexes = replaceIndexedTail(indexes, textDelta.previous, mergedTail);
      recordChange(changedIndex);
      estimatedCost = estimateReplacedTranscriptTailCost(
        estimatedCost,
        textDelta.previous,
        mergedTail,
      );
      continue;
    }

    // A tool call streams partial snapshots under one toolUseId. Keep one
    // stable event and accumulate object fields so renderer and replay match.
    const toolCallTail = getToolCallTail(last, event);
    if (toolCallTail) {
      const changedIndex = events.length - 1;
      const toolName = event.toolName ?? toolCallTail.toolName;
      const mergedTail: TranscriptEvent = {
        ...toolCallTail,
        ...(toolName !== undefined ? { toolName } : {}),
        toolArgs: mergeToolArgs(toolCallTail.toolArgs, event.toolArgs),
        endTs: event.endTs ?? event.ts,
      };
      events = replaceChunkedSequenceSuffix(events, changedIndex, [mergedTail]);
      indexes = replaceIndexedTail(indexes, toolCallTail, mergedTail);
      recordChange(changedIndex);
      estimatedCost = estimateReplacedTranscriptTailCost(estimatedCost, toolCallTail, mergedTail);
      continue;
    }

    const changedIndex = events.length;
    events = replaceChunkedSequenceSuffix(events, changedIndex, [event]);
    recordChange(changedIndex);
    eventIds = addEventId(eventIds, event.id);
    indexes = appendIndexes(indexes, event, changedIndex);
    estimatedCost = estimateAppendedTranscriptCost(estimatedCost, event);
  }

  if (firstChangedIndex !== undefined) {
    registerTranscriptRuntime(events, eventIds, indexes);
  }

  return {
    events: firstChangedIndex === undefined ? previous : events,
    estimatedCost,
    change:
      firstChangedIndex === undefined
        ? null
        : {
            kind: 'append',
            previousLength: previous.length,
            firstChangedIndex,
          },
  };
}

/**
 * Adapts reducer replacements to the canonical runtime. Proven appends and
 * prepends retain chunk identity; resets build a fresh authoritative index.
 */
export function normalizeTranscriptUpdate(
  previous: TranscriptEvent[],
  next: TranscriptEvent[],
  mutation: TranscriptMutationChange,
): TranscriptEvent[] {
  const existing = transcriptRuntimes.get(next);
  if (existing) return next;

  if (mutation.previousLength !== previous.length) {
    throw new RangeError('Transcript mutation previousLength does not match retained state.');
  }

  if (mutation.kind === 'reset') return buildTranscriptRuntime(next).events;

  const previousRuntime = transcriptRuntime(previous);
  if (mutation.kind === 'prepend') {
    if (next.length !== previous.length + mutation.insertedCount) {
      throw new RangeError('Transcript prepend length does not match insertedCount.');
    }
    const inserted = next.slice(
      mutation.firstChangedIndex,
      mutation.firstChangedIndex + mutation.insertedCount,
    );
    const insertedIndexes = buildIndexes(inserted);
    const events = insertChunkedSequence(
      previousRuntime.events,
      mutation.firstChangedIndex,
      inserted,
    );
    const insertedFirstUserIndex = insertedIndexes.firstUserIndex;
    const previousFirstUserIndex = previousRuntime.indexes.firstUserIndex;
    const shiftedPreviousFirstUserIndex = shiftIndexForInsertion(
      previousFirstUserIndex,
      mutation.firstChangedIndex,
      mutation.insertedCount,
    );
    const absoluteInsertedFirstUserIndex =
      insertedFirstUserIndex === undefined
        ? undefined
        : mutation.firstChangedIndex + insertedFirstUserIndex;
    const insertedUserComesFirst =
      absoluteInsertedFirstUserIndex !== undefined &&
      (shiftedPreviousFirstUserIndex === undefined ||
        absoluteInsertedFirstUserIndex < shiftedPreviousFirstUserIndex);
    registerTranscriptRuntime(events, addEventIds(previousRuntime.eventIds, inserted), {
      firstUserEvent: insertedUserComesFirst
        ? insertedIndexes.firstUserEvent
        : previousRuntime.indexes.firstUserEvent,
      firstUserIndex: insertedUserComesFirst
        ? absoluteInsertedFirstUserIndex
        : shiftedPreviousFirstUserIndex,
      latestActivityBySource: mergeLatestActivityIndexes(
        insertedIndexes.latestActivityBySource,
        previousRuntime.indexes.latestActivityBySource,
      ),
      childSpawns: mergeChildSpawnIndexes(
        insertedIndexes.childSpawns,
        previousRuntime.indexes.childSpawns,
      ),
    });
    return events;
  }

  const replacement = next.slice(mutation.firstChangedIndex);
  const events = replaceChunkedSequenceSuffix(
    previousRuntime.events,
    mutation.firstChangedIndex,
    replacement,
  );
  return buildTranscriptRuntime(events).events;
}

export function firstUserTranscriptEvent(
  events: readonly TranscriptEvent[],
): TranscriptEvent | undefined {
  return transcriptRuntime(events).indexes.firstUserEvent;
}

export function latestTranscriptActivityForSource(
  events: readonly TranscriptEvent[],
  sourceSessionId: string,
): TranscriptEvent | undefined {
  return transcriptRuntime(events).indexes.latestActivityBySource.get(sourceSessionId);
}

export function childSpawnTranscriptEvents(events: readonly TranscriptEvent[]): TranscriptEvent[] {
  return [...transcriptRuntime(events).indexes.childSpawns.values()];
}

function transcriptRuntime(events: readonly TranscriptEvent[]): TranscriptRuntime {
  return transcriptRuntimes.get(events) ?? buildTranscriptRuntime(events);
}

function buildTranscriptRuntime(source: readonly TranscriptEvent[]): TranscriptRuntime {
  const events = asChunkedSequence(source);
  let eventIds = emptyEventIdIndex();
  for (const event of events) eventIds = addEventId(eventIds, event.id);
  return registerTranscriptRuntime(events, eventIds, buildIndexes(events));
}

function registerTranscriptRuntime(
  events: TranscriptEvent[],
  eventIds: EventIdIndex,
  indexes: TranscriptIndexes,
): TranscriptRuntime {
  const runtime = { events, eventIds, indexes };
  transcriptRuntimes.set(events, runtime);
  return runtime;
}

function buildIndexes(events: readonly TranscriptEvent[]): TranscriptIndexes {
  let indexes: TranscriptIndexes = {
    firstUserEvent: undefined,
    firstUserIndex: undefined,
    latestActivityBySource: new Map(),
    childSpawns: new Map(),
  };
  for (let index = 0; index < events.length; index += 1) {
    const event = events.at(index);
    if (event) indexes = appendIndexes(indexes, event, index);
  }
  return indexes;
}

function appendIndexes(
  indexes: TranscriptIndexes,
  event: TranscriptEvent,
  eventIndex: number,
): TranscriptIndexes {
  const firstUserEvent = indexes.firstUserEvent ?? (event.author === 'user' ? event : undefined);
  const firstUserIndex =
    indexes.firstUserIndex ?? (event.author === 'user' ? eventIndex : undefined);
  let latestActivityBySource = indexes.latestActivityBySource;
  if (isChildActivityEvent(event)) {
    const updated = new Map(latestActivityBySource);
    updated.set(event.sourceSessionId, event);
    latestActivityBySource = updated;
  }
  let childSpawns = indexes.childSpawns;
  if (isChildSpawnEvent(event)) {
    const key = childSpawnKey(event);
    const existing = childSpawns.get(key);
    const updated = new Map(childSpawns);
    updated.set(key, existing ? mergeChildSessionSpawn(existing, event) : event);
    childSpawns = updated;
  }
  return { firstUserEvent, firstUserIndex, latestActivityBySource, childSpawns };
}

function replaceIndexedTail(
  indexes: TranscriptIndexes,
  previous: TranscriptEvent,
  next: TranscriptEvent,
): TranscriptIndexes {
  let latestActivityBySource = indexes.latestActivityBySource;
  if (latestActivityBySource.get(previous.sourceSessionId) === previous) {
    const updated = new Map(latestActivityBySource);
    if (isChildActivityEvent(next)) updated.set(next.sourceSessionId, next);
    else updated.delete(previous.sourceSessionId);
    latestActivityBySource = updated;
  }

  let childSpawns = indexes.childSpawns;
  const previousKey = isChildSpawnEvent(previous) ? childSpawnKey(previous) : undefined;
  const nextKey = isChildSpawnEvent(next) ? childSpawnKey(next) : undefined;
  if (previousKey || nextKey) {
    const updated = new Map(childSpawns);
    if (previousKey && previousKey !== nextKey) updated.delete(previousKey);
    if (nextKey) {
      const existing = updated.get(nextKey);
      updated.set(nextKey, existing ? mergeChildSessionSpawn(existing, next) : next);
    }
    childSpawns = updated;
  }
  return { ...indexes, latestActivityBySource, childSpawns };
}

function mergeLatestActivityIndexes(
  older: ReadonlyMap<string, TranscriptEvent>,
  newer: ReadonlyMap<string, TranscriptEvent>,
): ReadonlyMap<string, TranscriptEvent> {
  const merged = new Map(older);
  for (const [sourceSessionId, event] of newer) merged.set(sourceSessionId, event);
  return merged;
}

function mergeChildSpawnIndexes(
  older: ReadonlyMap<string, TranscriptEvent>,
  newer: ReadonlyMap<string, TranscriptEvent>,
): ReadonlyMap<string, TranscriptEvent> {
  const merged = new Map(older);
  for (const [key, event] of newer) {
    const existing = merged.get(key);
    merged.set(key, existing ? mergeChildSessionSpawn(existing, event) : event);
  }
  return merged;
}

function isChildActivityEvent(event: TranscriptEvent): boolean {
  return event.author !== 'user' && !(event.kind === 'tool_result' && !event.isError);
}

function isChildSpawnEvent(event: TranscriptEvent): boolean {
  return event.kind === 'tool_call' && isChildSessionTool(event.toolName, event.toolArgs);
}

function childSpawnKey(event: TranscriptEvent): string {
  return event.toolUseId ?? event.id;
}

function emptyEventIdIndex(): EventIdIndex {
  return { buckets: new Array<ReadonlySet<string> | undefined>(EVENT_ID_BUCKET_COUNT) };
}

function hasEventId(index: EventIdIndex, eventId: string): boolean {
  return index.buckets[eventIdBucket(eventId)]?.has(eventId) ?? false;
}

function addEventIds(index: EventIdIndex, events: readonly TranscriptEvent[]): EventIdIndex {
  let next = index;
  for (const event of events) {
    if (!hasEventId(next, event.id)) next = addEventId(next, event.id);
  }
  return next;
}

function addEventId(index: EventIdIndex, eventId: string): EventIdIndex {
  const bucketIndex = eventIdBucket(eventId);
  const previousBucket = index.buckets[bucketIndex];
  if (previousBucket?.has(eventId)) return index;
  const buckets = index.buckets.slice();
  const bucket = new Set(previousBucket);
  bucket.add(eventId);
  buckets[bucketIndex] = bucket;
  return { buckets };
}

function eventIdBucket(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) & (EVENT_ID_BUCKET_COUNT - 1);
}

function mergeToolArgs(previous: unknown, next: unknown): unknown {
  if (isPlainRecord(previous) && isPlainRecord(next)) return { ...previous, ...next };
  return next ?? previous;
}

function shiftIndexForInsertion(
  index: number | undefined,
  insertionIndex: number,
  insertedCount: number,
): number | undefined {
  if (index === undefined) return undefined;
  return index >= insertionIndex ? index + insertedCount : index;
}

function getTextDeltaRun(
  previous: TranscriptEvent | undefined,
  next: TranscriptEvent,
): { previous: TranscriptEvent; text: string } | undefined {
  if (
    previous !== undefined &&
    !next.author &&
    previous.kind === next.kind &&
    previous.sourceSessionId === next.sourceSessionId &&
    previous.author === next.author &&
    (next.kind === 'text' || next.kind === 'thinking') &&
    typeof next.text === 'string' &&
    next.text.length > 0 &&
    !next.toolName
  ) {
    return { previous, text: next.text };
  }
  return undefined;
}

function getToolCallTail(
  previous: TranscriptEvent | undefined,
  next: TranscriptEvent,
): TranscriptEvent | undefined {
  if (
    previous !== undefined &&
    !next.author &&
    next.kind === 'tool_call' &&
    previous.kind === 'tool_call' &&
    previous.sourceSessionId === next.sourceSessionId &&
    !!next.toolUseId &&
    previous.toolUseId === next.toolUseId
  ) {
    return previous;
  }
  return undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
