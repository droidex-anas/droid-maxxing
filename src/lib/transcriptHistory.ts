import type { TranscriptEvent } from '../types/bridge';
import { composePrompt } from './composePrompt';

// A persisted twin is emitted within moments of its live event. Same-content
// events further apart are independent occurrences and must both survive.
const REPLAY_DEDUP_TOLERANCE_MS = 5_000;

function isOptimisticEcho(event: TranscriptEvent): boolean {
  return event.id.startsWith('seed-') || event.id.startsWith('local-');
}

// An optimistic user echo stores raw input, while history persists the composed
// prompt (raw text plus skill/file context). Match either representation.
function echoMatchesPersisted(event: TranscriptEvent, persisted: Set<string | undefined>): boolean {
  if (!event.text) return false;
  if (persisted.has(event.text)) return true;
  const composed = composePrompt(event.text, event.skills ?? [], event.files ?? []);
  return composed !== event.text && persisted.has(composed);
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
    Boolean(event.text) &&
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
  const pageIds = new Set(page.map((event) => event.id));
  const pageUserText = new Set(
    page.filter((event) => event.author === 'user' && event.text).map((event) => event.text),
  );
  const firstTs = page[0]?.ts ?? 0;
  const lastTs = page.at(-1)?.ts ?? 0;
  const supersededEcho = (event: TranscriptEvent) =>
    isOptimisticEcho(event) &&
    event.author === 'user' &&
    Boolean(event.text) &&
    event.ts <= lastTs &&
    (pageIsComplete || event.ts >= firstTs) &&
    echoMatchesPersisted(event, pageUserText);
  // Live primary events carry the provider identity while restored history
  // canonicalizes the source to "primary". Logical child identities already
  // match on both paths and therefore remain isolated from siblings.
  const sessionKey = (event: TranscriptEvent) =>
    event.role === 'primary' && event.sourceSessionId !== 'user'
      ? 'primary'
      : event.sourceSessionId;
  const contentSignature = (event: TranscriptEvent) =>
    event.toolUseId
      ? `tool:${sessionKey(event)}:${event.kind}:${event.toolUseId}`
      : `${sessionKey(event)}:${event.author ?? event.role}:${event.kind}:${event.text ?? ''}`;
  const pageSignatures = new Map<string, number[]>();
  for (const event of page) {
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
    (event) => !pageIds.has(event.id) && !supersededEcho(event) && !isReplayedDuplicate(event),
  );
  const before = liveOnly.filter((event) => event.ts < firstTs);
  const after = liveOnly.filter((event) => event.ts >= firstTs);
  return page.length > 0 ? [...before, ...page, ...after] : existing;
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
