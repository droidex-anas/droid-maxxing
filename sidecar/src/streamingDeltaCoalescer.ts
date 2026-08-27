// Provider stream deltas arrive per token. Emitting each one costs a history
// insert, a JSON serialization, and a renderer re-render, so consecutive deltas
// of one source coalesce into a single event.
//
// Buffers are per source (a primary session or one child agent) because several
// agents stream at once: a single shared buffer is flushed by every sibling
// delta, which reduces coalescing to nothing exactly when the machine is
// busiest. A turn's opening run flushes on the next tick so a card starts
// painting at provider speed; the rest of the turn coalesces.
//
// Merging mirrors the renderer's SESSION_TRANSCRIPT delta merging
// (src/lib/transcriptIngestion.ts): text/thinking runs concatenate, tool_call
// partials collapse onto one event per toolUseId. Keep both sides synchronized
// in the same change, or live rendering and replay drift apart.

import type { TranscriptEvent } from './protocol.js';
import { hotPathMetrics } from './telemetry/hotPathMetrics.js';

export interface StreamingDeltaCoalescerOptions {
  // 0 disables coalescing: every delta is delivered immediately.
  windowMs: number;
  // Serialized payload budget for one buffered run. Crossing it delivers early
  // and starts another run; content is never truncated or dropped.
  maxBytes: number;
  // Records and publishes one event. May throw; the caller owns the failure.
  deliver: (event: TranscriptEvent) => void;
}

interface BufferedRun {
  event: TranscriptEvent;
  estimatedBytes: number;
  mergedCount: number;
  timer: ReturnType<typeof setTimeout>;
}

interface SourceState {
  run: BufferedRun | null;
  hasDeliveredThisTurn: boolean;
}

export function streamingEventOwner(event: TranscriptEvent): string {
  return event.role === 'primary' ? event.appSessionId : event.sourceSessionId;
}

function sourceKey(appSessionId: string, ownerSessionId: string): string {
  return `${appSessionId}\u0000${ownerSessionId}`;
}

export class StreamingDeltaCoalescer {
  private readonly sources = new Map<string, SourceState>();

  constructor(private readonly options: StreamingDeltaCoalescerOptions) {}

  accept(event: TranscriptEvent): void {
    if (this.options.windowMs <= 0) {
      this.options.deliver(event);
      return;
    }
    const key = sourceKey(event.appSessionId, streamingEventOwner(event));
    const existing = this.sources.get(key);
    if (existing?.run) {
      const merged = mergeStreamingDelta(existing.run.event, event);
      if (merged) {
        const incomingBytes = estimateStreamingDeltaBytes(event);
        if (existing.run.estimatedBytes + incomingBytes > this.options.maxBytes) {
          this.flush(existing);
          this.buffer(existing, event, incomingBytes);
          return;
        }
        existing.run.event = merged;
        existing.run.estimatedBytes += incomingBytes;
        existing.run.mergedCount += 1;
        return;
      }
      // Ordering within a source is exact: anything that cannot merge into the
      // buffered run must land behind it.
      this.flush(existing);
    }
    if (!isCoalescableDelta(event)) {
      this.options.deliver(event);
      return;
    }
    this.buffer(existing ?? this.openSource(key), event, estimateStreamingDeltaBytes(event));
  }

  flushSource(appSessionId: string, ownerSessionId: string): void {
    const key = sourceKey(appSessionId, ownerSessionId);
    const state = this.sources.get(key);
    if (state) this.flush(state);
  }

  // Turn settlement: deliver the buffered tail and forget the source so the
  // next turn's first delta is immediate again.
  endTurn(appSessionId: string, ownerSessionId: string): void {
    const key = sourceKey(appSessionId, ownerSessionId);
    const state = this.sources.get(key);
    if (!state) return;
    this.sources.delete(key);
    this.flush(state);
  }

  // One source's failure must not strand another's buffered tail, so every
  // source is flushed before the first error is rethrown.
  flushAll(): void {
    const detached = [...this.sources.values()];
    this.sources.clear();
    let firstError: unknown;
    let failed = false;
    for (const state of detached) {
      try {
        this.flush(state);
      } catch (error) {
        if (!failed) {
          failed = true;
          firstError = error;
        }
      }
    }
    if (failed) throw firstError;
  }

  private openSource(key: string): SourceState {
    const state: SourceState = { run: null, hasDeliveredThisTurn: false };
    this.sources.set(key, state);
    return state;
  }

  private buffer(state: SourceState, event: TranscriptEvent, estimatedBytes: number): void {
    if (estimatedBytes >= this.options.maxBytes) {
      state.hasDeliveredThisTurn = true;
      this.options.deliver(event);
      return;
    }
    // A turn's opening run is flushed on the next tick instead of after the
    // full window: first-token latency is what makes a card look alive, and
    // one extra event per turn per source is a negligible price. Steady-state
    // cadence keeps the full window.
    const delayMs = state.hasDeliveredThisTurn ? this.options.windowMs : 0;
    const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
      // A retired run's timer must never publish the source's newer run.
      if (state.run?.timer !== timer) return;
      try {
        this.flush(state);
      } catch {
        // The failure is remembered by the deliver callback and owned by turn
        // settlement; a timer must never reject.
      }
    }, delayMs);
    timer.unref();
    state.run = { event, estimatedBytes, mergedCount: 1, timer };
  }

  private flush(state: SourceState): void {
    const run = state.run;
    if (!run) return;
    // Clear before delivering so a throwing deliver cannot replay the run.
    state.run = null;
    state.hasDeliveredThisTurn = true;
    clearTimeout(run.timer);
    hotPathMetrics.recordCoalesce(run.mergedCount);
    this.options.deliver(run.event);
  }
}

function isTextDelta(event: TranscriptEvent): boolean {
  return (
    (event.kind === 'text' || event.kind === 'thinking') &&
    !event.author &&
    !!event.text &&
    !event.toolName &&
    !event.toolUseId
  );
}

function isToolCallDelta(event: TranscriptEvent): boolean {
  return event.kind === 'tool_call' && !event.author && !!event.toolUseId;
}

function isCoalescableDelta(event: TranscriptEvent): boolean {
  return isTextDelta(event) || isToolCallDelta(event);
}

function estimateStreamingDeltaBytes(event: TranscriptEvent): number {
  let bytes = 192;
  if (event.text) bytes += Buffer.byteLength(event.text, 'utf8');
  if (event.toolName) bytes += Buffer.byteLength(event.toolName, 'utf8');
  if (event.toolArgs !== undefined) {
    try {
      const serialized = JSON.stringify(event.toolArgs);
      if (serialized) bytes += Buffer.byteLength(serialized, 'utf8');
    } catch {
      // Cyclic provider payloads are not valid bridge JSON anyway. Treat them
      // as over-budget so they bypass the coalescer and fail at the usual seam.
      return Number.POSITIVE_INFINITY;
    }
  }
  return bytes;
}

function sameDeltaRun(previous: TranscriptEvent, next: TranscriptEvent): boolean {
  return (
    previous.appSessionId === next.appSessionId &&
    previous.sourceSessionId === next.sourceSessionId &&
    previous.role === next.role
  );
}

function mergeToolArgs(previous: unknown, next: unknown): unknown {
  if (isPlainRecord(previous) && isPlainRecord(next)) return { ...previous, ...next };
  return next ?? previous;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mergeStreamingDelta(
  previous: TranscriptEvent,
  next: TranscriptEvent,
): TranscriptEvent | null {
  if (!sameDeltaRun(previous, next)) return null;
  if (isTextDelta(previous) && isTextDelta(next) && previous.kind === next.kind) {
    return {
      ...previous,
      text: (previous.text ?? '') + (next.text ?? ''),
      endTs: next.endTs ?? next.ts,
    };
  }
  if (isToolCallDelta(previous) && isToolCallDelta(next) && previous.toolUseId === next.toolUseId) {
    return {
      ...previous,
      toolName: next.toolName ?? previous.toolName,
      toolArgs: mergeToolArgs(previous.toolArgs, next.toolArgs),
      endTs: next.endTs ?? next.ts,
    };
  }
  return null;
}
