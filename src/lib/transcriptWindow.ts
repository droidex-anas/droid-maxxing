import type { TranscriptEvent } from '../types/bridge';

const KIB = 1024;
const MIB = 1024 * KIB;

export interface TranscriptWindowPolicy {
  highWaterCost: number;
  highWaterEvents: number;
  targetCost: number;
  targetEvents: number;
  minimumEvents: number;
  boundaryScanEvents: number;
}

export interface TranscriptWindow {
  events: TranscriptEvent[];
  estimatedCost: number;
  released: boolean;
}

// Normal active-session release is intentionally generous. It runs only after
// the viewport is bottom-pinned and the turn has settled, keeping hundreds of
// recent events (many screens) hot while older persisted history leaves React.
export const VIEWPORT_TRANSCRIPT_POLICY: TranscriptWindowPolicy = {
  highWaterCost: 32 * MIB,
  highWaterEvents: 3_200,
  targetCost: 12 * MIB,
  targetEvents: 1_200,
  minimumEvents: 400,
  boundaryScanEvents: 240,
};

// A bottom-pinned session can become colder once the user switches away. This
// still keeps a substantial instant-paint tail; scrolled-up sessions are not
// released by this policy because their reading position is authoritative.
export const INACTIVE_TRANSCRIPT_POLICY: TranscriptWindowPolicy = {
  highWaterCost: 8 * MIB,
  highWaterEvents: 800,
  targetCost: 4 * MIB,
  targetEvents: 320,
  minimumEvents: 120,
  boundaryScanEvents: 120,
};

// Last-resort protection only. This ceiling is deliberately far above normal
// viewport budgets and may run during a pathological live turn to avoid losing
// the whole renderer to an OOM. The complete transcript remains authoritative
// in session history and can be rehydrated from disk.
export const EMERGENCY_TRANSCRIPT_POLICY: TranscriptWindowPolicy = {
  highWaterCost: 256 * MIB,
  highWaterEvents: 30_000,
  targetCost: 128 * MIB,
  targetEvents: 1_200,
  minimumEvents: 400,
  boundaryScanEvents: 200,
};

const OBJECT_OVERHEAD = 48;
const ARRAY_OVERHEAD = 32;
const STRING_OVERHEAD = 16;
const SCALAR_OVERHEAD = 8;
const EVENT_ESTIMATES = new WeakMap<TranscriptEvent, number>();

// Relative retained-payload estimate used for budgeting, not a V8 heap-size
// claim. It counts UTF-8 string payloads, nested tool/reference data, and
// conservative container overhead. Actual object memory varies by engine,
// string representation, pointer compression, and sharing.
export function estimateRetainedPayloadCost(value: unknown): number {
  let cost = 0;
  const seen = new WeakSet<object>();
  const pending: unknown[] = [value];

  while (pending.length > 0) {
    const current = pending.pop();
    if (
      current === null ||
      current === undefined ||
      typeof current === 'boolean' ||
      typeof current === 'number' ||
      typeof current === 'bigint'
    ) {
      cost += SCALAR_OVERHEAD;
      continue;
    }
    if (typeof current === 'string') {
      cost += STRING_OVERHEAD + utf8ByteLength(current);
      continue;
    }
    if (typeof current === 'symbol' || typeof current === 'function') {
      cost += SCALAR_OVERHEAD;
      continue;
    }
    if (seen.has(current)) continue;
    seen.add(current);
    if (Array.isArray(current)) {
      cost += ARRAY_OVERHEAD + current.length * SCALAR_OVERHEAD;
      for (const nested of current) pending.push(nested);
      continue;
    }
    cost += OBJECT_OVERHEAD;
    for (const [key, nested] of Object.entries(current)) {
      cost += STRING_OVERHEAD + utf8ByteLength(key);
      pending.push(nested);
    }
  }

  return cost;
}

export function estimateTranscriptEventCost(event: TranscriptEvent): number {
  const cached = EVENT_ESTIMATES.get(event);
  if (cached !== undefined) return cached;
  const cost = estimateRetainedPayloadCost(event);
  EVENT_ESTIMATES.set(event, cost);
  return cost;
}

export function estimateTranscriptCost(events: readonly TranscriptEvent[]): number {
  let cost = ARRAY_OVERHEAD + events.length * SCALAR_OVERHEAD;
  for (const event of events) cost += estimateTranscriptEventCost(event);
  return cost;
}

export function estimateAppendedTranscriptCost(
  previousCost: number,
  event: TranscriptEvent,
): number {
  return previousCost + SCALAR_OVERHEAD + estimateTranscriptEventCost(event);
}

export function estimateReplacedTranscriptTailCost(
  previousCost: number,
  previousTail: TranscriptEvent,
  nextTail: TranscriptEvent,
): number {
  return (
    previousCost - estimateTranscriptEventCost(previousTail) + estimateTranscriptEventCost(nextTail)
  );
}

export function shouldReleaseTranscriptWindow(
  events: readonly TranscriptEvent[],
  estimatedCost: number,
  policy: TranscriptWindowPolicy,
): boolean {
  return events.length > policy.highWaterEvents || estimatedCost > policy.highWaterCost;
}

export function releaseTranscriptWindow(
  events: TranscriptEvent[],
  estimatedCost: number,
  policy: TranscriptWindowPolicy,
): TranscriptWindow {
  if (!shouldReleaseTranscriptWindow(events, estimatedCost, policy)) {
    return { events, estimatedCost, released: false };
  }

  let start = events.length;
  let keptCount = 0;
  let keptCost = ARRAY_OVERHEAD;
  while (start > 0) {
    const eventCost = estimateTranscriptEventCost(events[start - 1]) + SCALAR_OVERHEAD;
    // Keep a generous event floor while it remains safe, but never let that
    // floor defeat the byte ceiling for payload-heavy tool/reference events.
    // The newest complete event is always retained, even if it is indivisibly
    // larger than the heuristic ceiling.
    const mustKeep =
      keptCount === 0 ||
      (keptCount < policy.minimumEvents && keptCost + eventCost <= policy.highWaterCost);
    const fitsTargets =
      keptCount < policy.targetEvents && keptCost + eventCost <= policy.targetCost;
    if (!mustKeep && !fitsTargets) break;
    start -= 1;
    keptCount += 1;
    keptCost += eventCost;
  }

  // Prefer a prompt boundary near the target so the retained tail opens on a
  // coherent turn rather than in the middle of a tool run. The bounded scan
  // and byte guard prevent one enormous turn from defeating the window budget.
  const earliestBoundary = Math.max(0, start - policy.boundaryScanEvents);
  let boundaryCost = keptCost;
  for (let i = start; i >= earliestBoundary; i--) {
    if (i < start) {
      boundaryCost += estimateTranscriptEventCost(events[i]) + SCALAR_OVERHEAD;
      if (boundaryCost > policy.highWaterCost) break;
    }
    if (events[i]?.author === 'user') {
      start = i;
      break;
    }
  }

  if (start <= 0) return { events, estimatedCost, released: false };
  const retained = events.slice(start);
  return {
    events: retained,
    estimatedCost: estimateTranscriptCost(retained),
    released: true,
  };
}

export function releaseChildTranscriptWindow(
  events: TranscriptEvent[],
  childSessionId: string,
  policy: TranscriptWindowPolicy,
): TranscriptWindow {
  const childEvents = events.filter((event) => event.sourceSessionId === childSessionId);
  const retained = releaseTranscriptWindow(
    childEvents,
    estimateTranscriptCost(childEvents),
    policy,
  );
  if (!retained.released) {
    return {
      events,
      estimatedCost: estimateTranscriptCost(events),
      released: false,
    };
  }

  const merged: TranscriptEvent[] = [];
  let inserted = false;
  for (const event of events) {
    if (event.sourceSessionId !== childSessionId) {
      merged.push(event);
      continue;
    }
    if (!inserted) {
      merged.push(...retained.events);
      inserted = true;
    }
  }
  if (!inserted) merged.push(...retained.events);
  return {
    events: merged,
    estimatedCost: estimateTranscriptCost(merged),
    released: true,
  };
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}
