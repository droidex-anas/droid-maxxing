// Renderer hot-path measurement for perf phase 0 (#116): timestamps the
// receive → store-commit → next-paint leg for bridge events, tracks long
// tasks, and exposes the mounted feed-row count.
//
// The module must import safely outside a browser (node --test) — every DOM
// API is resolved lazily and observers start only where they exist.

import type { ServerEvent } from '../types/bridge';

export interface RendererPerfSnapshot {
  startedAt: number;
  eventsReceived: number;
  appendedReceived: number;
  receiveToCommitMs: {
    count: number;
    p50Ms?: number;
    p95Ms?: number;
    p99Ms?: number;
    maxMs?: number;
  };
  receiveToPaintMs: {
    count: number;
    p50Ms?: number;
    p95Ms?: number;
    p99Ms?: number;
    maxMs?: number;
  };
  appendToReceiveMs: {
    count: number;
    p50Ms?: number;
    p95Ms?: number;
    p99Ms?: number;
    maxMs?: number;
  };
  longTasks: { count: number; totalMs: number; maxMs: number; over50Ms: number };
  mountedFeedRows: number;
  mountedFeedRowsMax: number;
  feedProjection: {
    fullBuilds: number;
    incrementalBuilds: number;
    cacheHits: number;
    invisibleAppendHits: number;
    eventsRebuilt: number;
    eventsReused: number;
    durationMs: {
      count: number;
      p50Ms?: number;
      p95Ms?: number;
      p99Ms?: number;
      maxMs?: number;
    };
  };
}

interface PendingEvent {
  receivedAt: number;
  source: ServerEvent;
}

const CAPACITY = 4_096;
// Backgrounded tabs throttle rAF indefinitely; never-stamped entries are
// dropped rather than recorded against a meaningless far-future frame.
const PAINT_STALE_MS = 10_000;
const MAX_AWAITING_PAINT = 4_096;

const receiveToCommit = new Float64Array(CAPACITY);
const receiveToPaint = new Float64Array(CAPACITY);
const appendToReceive = new Float64Array(CAPACITY);
const feedProjectionDuration = new Float64Array(CAPACITY);
const cursors = { commit: 0, paint: 0, append: 0, feed: 0 };
const counts = { commit: 0, paint: 0, append: 0, feed: 0 };

let startedAt = 0;
let eventsReceived = 0;
let appendedReceived = 0;
let pending: PendingEvent[] = [];
let awaitingPaint: PendingEvent[] = [];
let paintScheduled = false;
let longTasks = { count: 0, totalMs: 0, maxMs: 0, over50Ms: 0 };
let mountedFeedRows = 0;
let mountedFeedRowsMax = 0;
let observersStarted = false;
let feedProjection = {
  fullBuilds: 0,
  incrementalBuilds: 0,
  cacheHits: 0,
  invisibleAppendHits: 0,
  eventsRebuilt: 0,
  eventsReused: 0,
};

export function startRendererPerfObservers(): void {
  if (observersStarted) return;
  const observerApi = (
    globalThis as {
      PerformanceObserver?: new (cb: PerformanceObserverCallback) => PerformanceObserver;
    }
  ).PerformanceObserver;
  if (!observerApi) return;
  observersStarted = true;
  startedAt ||= Date.now();
  try {
    const observer = new observerApi((list) => {
      for (const entry of list.getEntries()) {
        noteLongTask(entry.duration);
      }
    });
    observer.observe({ type: 'longtask', buffered: true });
  } catch {
    // Older engines reject the entry type; long-task tracking is best-effort.
  }
}

/** Stamp a bridge event at socket-read time; called from Bridge.onmessage. */
export function noteBridgeEventReceived(event: ServerEvent): void {
  startedAt ||= Date.now();
  eventsReceived += 1;
  const now = performance.now();
  if (event.type === 'event.appended') {
    appendedReceived += 1;
    record(appendToReceive, 'append', now - clampEpoch(event.event.ts));
  }
  pending.push({ receivedAt: now, source: event });
}

/**
 * Drop an event's pending leg when it produces no reducer action. Without
 * this, the entry would be closed by the next unrelated commit and record a
 * fabricated receive-to-commit/paint sample.
 */
export function discardPendingBridgeEvent(event: ServerEvent): void {
  pending = pending.filter((item) => item.source !== event);
}

/**
 * Close the receive→commit leg for everything received since the previous
 * commit and schedule the paint stamp for the same batch. Called from the
 * store's post-commit layout effect.
 */
export function noteStoreCommitted(): void {
  if (pending.length === 0) return;
  const batch = pending;
  pending = [];
  const now = performance.now();
  for (const item of batch) record(receiveToCommit, 'commit', now - item.receivedAt);
  schedulePaintStamp(batch);
}

/** Report how many grouped feed rows the visible conversation currently mounts. */
export function setMountedFeedRows(count: number): void {
  mountedFeedRows = count;
  mountedFeedRowsMax = Math.max(mountedFeedRowsMax, count);
}

/** Measure canonical full builds versus proven transcript/feed reuse. */
export function noteFeedProjection(options: {
  mode: 'full' | 'incremental' | 'cache' | 'invisible';
  durationMs: number;
  visibleEventCount: number;
  reusedVisibleEventCount: number;
}): void {
  const visibleEventCount = validCount(options.visibleEventCount);
  const reusedEvents = Math.min(visibleEventCount, validCount(options.reusedVisibleEventCount));
  if (options.mode === 'full') feedProjection.fullBuilds += 1;
  else if (options.mode === 'incremental') feedProjection.incrementalBuilds += 1;
  else if (options.mode === 'cache') feedProjection.cacheHits += 1;
  else feedProjection.invisibleAppendHits += 1;
  feedProjection.eventsRebuilt += visibleEventCount - reusedEvents;
  feedProjection.eventsReused += reusedEvents;
  record(feedProjectionDuration, 'feed', options.durationMs);
}

export function getRendererPerfSnapshot(): RendererPerfSnapshot {
  return {
    startedAt,
    eventsReceived,
    appendedReceived,
    receiveToCommitMs: stats(receiveToCommit, 'commit'),
    receiveToPaintMs: stats(receiveToPaint, 'paint'),
    appendToReceiveMs: stats(appendToReceive, 'append'),
    longTasks: { ...longTasks },
    mountedFeedRows,
    mountedFeedRowsMax,
    feedProjection: {
      ...feedProjection,
      durationMs: stats(feedProjectionDuration, 'feed'),
    },
  };
}

/** @internal Reset module state for deterministic tests. */
export function resetRendererPerfForTest(): void {
  cursors.commit = 0;
  cursors.paint = 0;
  cursors.append = 0;
  cursors.feed = 0;
  counts.commit = 0;
  counts.paint = 0;
  counts.append = 0;
  counts.feed = 0;
  eventsReceived = 0;
  appendedReceived = 0;
  pending = [];
  awaitingPaint = [];
  paintScheduled = false;
  longTasks = { count: 0, totalMs: 0, maxMs: 0, over50Ms: 0 };
  mountedFeedRows = 0;
  mountedFeedRowsMax = 0;
  feedProjection = {
    fullBuilds: 0,
    incrementalBuilds: 0,
    cacheHits: 0,
    invisibleAppendHits: 0,
    eventsRebuilt: 0,
    eventsReused: 0,
  };
  startedAt = 0;
  observersStarted = false;
}

// Entries older than the staleness threshold can no longer describe a real
// paint (backgrounded tab, throttled or never-run frame), so they are dropped
// rather than recorded against whatever frame eventually fires.
function dropStalePaintEntries(now: number): void {
  awaitingPaint = awaitingPaint.filter((item) => now - item.receivedAt <= PAINT_STALE_MS);
}

function schedulePaintStamp(batch: PendingEvent[]): void {
  dropStalePaintEntries(performance.now());
  awaitingPaint = awaitingPaint.concat(batch);
  if (awaitingPaint.length > MAX_AWAITING_PAINT) {
    awaitingPaint = awaitingPaint.slice(awaitingPaint.length - MAX_AWAITING_PAINT);
  }
  if (paintScheduled) return;
  const raf = (globalThis as { requestAnimationFrame?: (cb: () => void) => number })
    .requestAnimationFrame;
  if (!raf) {
    // No frame API (tests, SSR): the paint leg stays unmeasured rather than
    // being faked with a timer.
    awaitingPaint = [];
    return;
  }
  paintScheduled = true;
  raf(() => {
    paintScheduled = false;
    const stampedAt = performance.now();
    dropStalePaintEntries(stampedAt);
    for (const item of awaitingPaint) record(receiveToPaint, 'paint', stampedAt - item.receivedAt);
    awaitingPaint = [];
  });
}

function noteLongTask(durationMs: number): void {
  longTasks.count += 1;
  longTasks.totalMs += durationMs;
  longTasks.maxMs = Math.max(longTasks.maxMs, durationMs);
  if (durationMs > 50) longTasks.over50Ms += 1;
}

type MetricKey = 'commit' | 'paint' | 'append' | 'feed';

function record(target: Float64Array, key: MetricKey, value: number): void {
  if (!Number.isFinite(value) || value < 0) return;
  target[cursors[key]] = value;
  cursors[key] = (cursors[key] + 1) % CAPACITY;
  counts[key] += 1;
}

function stats(ring: Float64Array, key: MetricKey): RendererPerfSnapshot['receiveToCommitMs'] {
  const count = counts[key];
  if (count === 0) return { count: 0 };
  let window: Float64Array;
  if (count <= CAPACITY) {
    window = ring.subarray(0, count);
  } else {
    // The ring wrapped: the live samples start at the cursor.
    window = Float64Array.from([...ring.subarray(cursors[key]), ...ring.subarray(0, cursors[key])]);
  }
  const sorted = Float64Array.from(window).sort();
  return {
    count,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99),
    maxMs: round(sorted[sorted.length - 1]),
  };
}

function validCount(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function percentile(sorted: Float64Array, quantile: number): number | undefined {
  if (sorted.length === 0) return undefined;
  const index = Math.min(sorted.length - 1, Math.ceil(quantile * sorted.length) - 1);
  return round(sorted[Math.max(0, index)]);
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

// Bridge `ts` values are wall-clock epoch milliseconds; performance.now() is
// relative, so only the *delta against a captured epoch baseline* is valid.
// The receive-side stamp is monotonic; the event's own epoch ts converts via
// timeOrigin so append-to-receive stays a true cross-clock difference.
function clampEpoch(epochMs: number): number {
  return epochMs - performance.timeOrigin;
}
