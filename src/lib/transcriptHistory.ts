import type { TranscriptEvent } from '../types/bridge';
import { composePrompt } from './composePrompt';
import { hasAppBlock, hasCompleteAppBlock, hasIncompleteAppBlock } from './appBlocks';

// A persisted twin is emitted within moments of its live event. Same-content
// events further apart are independent occurrences and must both survive.
const REPLAY_DEDUP_TOLERANCE_MS = 5_000;
const TRUNCATED_TEXT_TAIL = /\n\n\[truncated (\d+) chars\]$/;
const PARTIAL_REPLAY_ANCHOR_CHARS = 64;

function isOptimisticEcho(event: TranscriptEvent): boolean {
  return event.id.startsWith('seed-') || event.id.startsWith('local-');
}

// An optimistic user echo stores raw input, while history persists the composed
// prompt (raw text plus skill/file context). Match either representation.
function echoMatchesPersisted(event: TranscriptEvent, persisted: Set<string | undefined>): boolean {
  const rawText = event.text ?? '';
  if (rawText && persisted.has(rawText)) return true;
  const composed = composePrompt(rawText, event.skills ?? [], event.files ?? []);
  return composed !== rawText && persisted.has(composed);
}

function sessionKey(event: TranscriptEvent): string {
  return event.role === 'primary' && event.sourceSessionId !== 'user'
    ? 'primary'
    : event.sourceSessionId;
}

function replayScope(event: TranscriptEvent): string {
  return `${sessionKey(event)}:${event.author ?? event.role}:${event.kind}`;
}

function replayTimeDifferenceMs(left: TranscriptEvent, right: TranscriptEvent): number {
  const leftStart = Math.min(left.ts, left.endTs ?? left.ts);
  const leftEnd = Math.max(left.ts, left.endTs ?? left.ts);
  const rightStart = Math.min(right.ts, right.endTs ?? right.ts);
  const rightEnd = Math.max(right.ts, right.endTs ?? right.ts);
  if (leftEnd < rightStart) return rightStart - leftEnd;
  if (rightEnd < leftStart) return leftStart - rightEnd;
  return 0;
}

function fullTextSupersedesTruncatedReplay(
  live: TranscriptEvent,
  replayed: TranscriptEvent,
): boolean {
  if (replayScope(live) !== replayScope(replayed)) return false;
  if (typeof live.text !== 'string' || typeof replayed.text !== 'string') return false;
  const tail = TRUNCATED_TEXT_TAIL.exec(replayed.text);
  if (tail?.index === undefined) return false;
  const removedCount = Number(tail[1]);
  const retainedPrefix = replayed.text.slice(0, tail.index);
  return (
    Number.isSafeInteger(removedCount) &&
    removedCount > 0 &&
    live.text.length === retainedPrefix.length + removedCount &&
    live.text.startsWith(retainedPrefix) &&
    replayTimeDifferenceMs(live, replayed) <= REPLAY_DEDUP_TOLERANCE_MS
  );
}

function isUnpersistedTextPrefix(
  candidate: TranscriptEvent,
  full: TranscriptEvent,
  page: TranscriptEvent[],
): boolean {
  if (replayScope(candidate) !== replayScope(full)) return false;
  if (typeof candidate.text !== 'string' || typeof full.text !== 'string') return false;
  if (
    candidate.text.length === 0 ||
    candidate.text.length >= full.text.length ||
    !full.text.startsWith(candidate.text) ||
    replayTimeDifferenceMs(candidate, full) > REPLAY_DEDUP_TOLERANCE_MS
  ) {
    return false;
  }
  return !page.some(
    (replayed) =>
      (replayed.id === candidate.id ||
        (replayScope(replayed) === replayScope(candidate) && replayed.text === candidate.text)) &&
      replayTimeDifferenceMs(candidate, replayed) <= REPLAY_DEDUP_TOLERANCE_MS,
  );
}

function replayedTextSupersedesLiveGap(live: TranscriptEvent, replayed: TranscriptEvent): boolean {
  if (replayScope(live) !== replayScope(replayed)) return false;
  if (typeof live.text !== 'string' || typeof replayed.text !== 'string') return false;
  if (
    live.text.length >= replayed.text.length ||
    replayTimeDifferenceMs(live, replayed) > REPLAY_DEDUP_TOLERANCE_MS ||
    !hasAppBlock(live.text) ||
    !hasIncompleteAppBlock(live.text) ||
    !hasCompleteAppBlock(replayed.text) ||
    hasIncompleteAppBlock(replayed.text)
  ) {
    return false;
  }

  let prefixLength = 0;
  while (
    prefixLength < live.text.length &&
    live.text[prefixLength] === replayed.text[prefixLength]
  ) {
    prefixLength += 1;
  }
  const suffix = live.text.slice(prefixLength);
  return (
    prefixLength >= PARTIAL_REPLAY_ANCHOR_CHARS &&
    suffix.length >= PARTIAL_REPLAY_ANCHOR_CHARS &&
    replayed.text.endsWith(suffix)
  );
}

function supersededLiveGapIds(existing: TranscriptEvent[], page: TranscriptEvent[]): Set<string> {
  const ids = new Set<string>();
  for (const replayed of page) {
    for (const live of existing) {
      if (replayedTextSupersedesLiveGap(live, replayed)) ids.add(live.id);
    }
  }
  return ids;
}

export function reconcilePrependedTranscript(
  existing: TranscriptEvent[],
  olderPage: TranscriptEvent[],
): TranscriptEvent[] {
  const olderUserText = new Set(
    olderPage.filter((event) => event.author === 'user' && event.text).map((event) => event.text),
  );
  const olderLastTs = olderPage.at(-1)?.ts ?? 0;
  const supersededEcho = (event: TranscriptEvent) =>
    isOptimisticEcho(event) &&
    event.author === 'user' &&
    event.ts <= olderLastTs &&
    echoMatchesPersisted(event, olderUserText);
  const kept = existing.filter((event) => !supersededEcho(event));
  const retainedIds = new Set(kept.map((event) => event.id));
  const older = olderPage.filter((event) => !retainedIds.has(event.id));
  return older.length > 0 || kept.length !== existing.length ? [...older, ...kept] : existing;
}

export function reconcileRestoredTranscript(
  existing: TranscriptEvent[],
  page: TranscriptEvent[],
  pageIsComplete: boolean,
): TranscriptEvent[] {
  // Persisted history deliberately caps very large text blocks. When a live
  // event still carries that block in full, keep the lossless event and remove
  // its replay twin instead of rendering both versions as separate answers.
  const liveReplacementByPageId = new Map<string, TranscriptEvent>();
  const matchedLiveIds = new Set<string>();
  const supersededLiveIds = supersededLiveGapIds(existing, page);
  for (const replayed of page) {
    let closestLive: TranscriptEvent | undefined;
    let closestDifferenceMs = Infinity;
    for (const live of existing) {
      if (matchedLiveIds.has(live.id) || !fullTextSupersedesTruncatedReplay(live, replayed)) {
        continue;
      }
      const differenceMs = replayTimeDifferenceMs(live, replayed);
      if (differenceMs < closestDifferenceMs) {
        closestLive = live;
        closestDifferenceMs = differenceMs;
      }
    }
    if (!closestLive) continue;
    liveReplacementByPageId.set(replayed.id, closestLive);
    matchedLiveIds.add(closestLive.id);
    for (const candidate of existing) {
      if (
        candidate.id !== closestLive.id &&
        isUnpersistedTextPrefix(candidate, closestLive, page)
      ) {
        supersededLiveIds.add(candidate.id);
      }
    }
  }
  const authoritativePage = page.map((event) => liveReplacementByPageId.get(event.id) ?? event);
  const pageIds = new Set(authoritativePage.map((event) => event.id));
  const pageUserText = new Set(
    authoritativePage
      .filter((event) => event.author === 'user' && event.text)
      .map((event) => event.text),
  );
  const firstTs = authoritativePage[0]?.ts ?? 0;
  const lastTs = authoritativePage.at(-1)?.ts ?? 0;
  const supersededEcho = (event: TranscriptEvent) =>
    isOptimisticEcho(event) &&
    event.author === 'user' &&
    event.ts <= lastTs &&
    (pageIsComplete || event.ts >= firstTs) &&
    echoMatchesPersisted(event, pageUserText);
  // Live primary events carry the provider identity while restored history
  // canonicalizes the source to "primary". Logical child identities already
  // match on both paths and therefore remain isolated from siblings.
  const contentSignature = (event: TranscriptEvent) =>
    event.toolUseId
      ? `tool:${sessionKey(event)}:${event.kind}:${event.toolUseId}`
      : `${sessionKey(event)}:${event.author ?? event.role}:${event.kind}:${event.text ?? ''}`;
  const pageSignatures = new Map<string, number[]>();
  for (const event of authoritativePage) {
    const signature = contentSignature(event);
    const timestamps = pageSignatures.get(signature);
    if (timestamps) timestamps.push(event.ts);
    else pageSignatures.set(signature, [event.ts]);
  }
  const isReplayedDuplicate = (event: TranscriptEvent) => {
    // Echo reconciliation intentionally has stricter time-window semantics.
    if (isOptimisticEcho(event)) return false;
    const timestamps = pageSignatures.get(contentSignature(event));
    if (!timestamps || timestamps.length === 0) return false;
    const startTs = Math.min(event.ts, event.endTs ?? event.ts);
    const endTs = Math.max(event.ts, event.endTs ?? event.ts);
    let closestIndex = -1;
    let closestDifferenceMs = Infinity;
    for (let index = 0; index < timestamps.length; index++) {
      const timestamp = timestamps[index];
      let differenceMs = 0;
      if (timestamp < startTs) differenceMs = startTs - timestamp;
      else if (timestamp > endTs) differenceMs = timestamp - endTs;
      if (differenceMs < closestDifferenceMs) {
        closestDifferenceMs = differenceMs;
        closestIndex = index;
      }
    }
    if (closestIndex < 0 || closestDifferenceMs > REPLAY_DEDUP_TOLERANCE_MS) return false;
    timestamps.splice(closestIndex, 1);
    return true;
  };
  const liveOnly = existing.filter(
    (event) =>
      !supersededLiveIds.has(event.id) &&
      !pageIds.has(event.id) &&
      !supersededEcho(event) &&
      !isReplayedDuplicate(event),
  );
  if (page.length === 0) return existing;
  const merged = [...authoritativePage];
  for (const event of liveOnly) {
    const insertionIndex = merged.findIndex((candidate) => candidate.ts > event.ts);
    if (insertionIndex < 0) merged.push(event);
    else merged.splice(insertionIndex, 0, event);
  }
  return merged;
}

export function reconcileTranscriptPage(
  existing: TranscriptEvent[],
  page: TranscriptEvent[],
  mode: 'replace' | 'prepend',
  hasMore: boolean,
): TranscriptEvent[] {
  return mode === 'prepend'
    ? reconcilePrependedTranscript(existing, page)
    : reconcileRestoredTranscript(existing, page, !hasMore);
}

export function reconcileTranscriptSourcePage(
  transcript: TranscriptEvent[],
  sourceSessionId: string,
  page: TranscriptEvent[],
  mode: 'replace' | 'prepend',
  hasMore: boolean,
): { transcript: TranscriptEvent[]; sourceEvents: TranscriptEvent[] } {
  const existingSourceEvents = transcript.filter(
    (event) => event.sourceSessionId === sourceSessionId,
  );
  const sourceEvents = reconcileTranscriptPage(existingSourceEvents, page, mode, hasMore);
  if (sourceEvents === existingSourceEvents) return { transcript, sourceEvents };

  const merged: TranscriptEvent[] = [];
  let inserted = false;
  for (const event of transcript) {
    if (event.sourceSessionId !== sourceSessionId) {
      merged.push(event);
      continue;
    }
    if (!inserted) {
      merged.push(...sourceEvents);
      inserted = true;
    }
  }
  if (!inserted) merged.push(...sourceEvents);
  return { transcript: merged, sourceEvents };
}
