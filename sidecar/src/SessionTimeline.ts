import type { HistoryIndex } from './history.js';
import {
  hydrateHistoricalSession,
  loadSessionHistory,
  loadSessionPage,
  loadSessionTranscriptWindow,
  resolveSessionChain,
} from './history.js';
import type {
  ChildSessionSummary,
  ProgressEntry,
  ServerEvent,
  SessionRole,
  SessionSummary,
  TranscriptEvent,
} from './protocol.js';
import type { CompactType } from './compaction.js';
import { errMsg } from './sessionHelpers.js';
import { hotPathMetrics } from './telemetry/hotPathMetrics.js';

type TimelineHistory = Pick<HistoryIndex, 'recordEvent'>;
type TimelineError = Omit<Extract<ServerEvent, { type: 'error' }>, 'type'>;

export interface SessionTimelineLoaders {
  list: typeof loadSessionHistory;
  page: typeof loadSessionPage;
  hydrateMission: typeof hydrateHistoricalSession;
  resolveChain: typeof resolveSessionChain;
  transcriptWindow: typeof loadSessionTranscriptWindow;
}

export interface SessionTimelineRegistry {
  resolveSummary(id: string): SessionSummary | undefined;
  getLive(id: string): unknown;
}

export interface SessionTimelineDependencies {
  registry: SessionTimelineRegistry;
  history: TimelineHistory;
  getChildSessions: (appSessionId: string) => ChildSessionSummary[];
  emit: (event: ServerEvent) => void;
  emitError: (error: TimelineError) => void;
  now?: () => number;
  loaders?: SessionTimelineLoaders;
  // Streaming deltas buffered longer than this are flushed as one event.
  // 0 disables coalescing (every delta records and emits immediately).
  streamingCoalesceMs?: number;
  // Serialized payload budget for one coalesced run. Crossing it flushes early
  // and starts another run; content is never truncated or dropped.
  streamingCoalesceMaxBytes?: number;
}

interface SessionHistoryPage {
  appSessionId: string;
  childSessionId?: string;
  progress: ProgressEntry[];
  transcripts: TranscriptEvent[];
  childSessions?: ChildSessionSummary[];
  mode: 'replace' | 'prepend';
  olderCursor?: string;
}

// Protocol mirror of src/lib/transcriptStoreMemory.ts. Scroll pages are smaller;
// this ceiling also permits one bounded recent-tail repair after local release.
const MAX_HISTORY_PAGE_EVENTS = 1_600;

// Preserve the existing enumerable `cursor: undefined` loader boundary while
// keeping the extracted module clean under exactOptionalPropertyTypes. Limits
// tune only local disk/bridge page size; they never change provider traffic.
function historyWindowOptions(
  cursor: string | undefined,
  limit: number | undefined,
  role?: SessionRole,
): { cursor?: string; limit?: number; role?: SessionRole } {
  const options: { cursor?: string; limit?: number; role?: SessionRole } = {};
  Object.defineProperty(options, 'cursor', { enumerable: true, value: cursor });
  if (limit !== undefined && Number.isFinite(limit)) {
    options.limit = Math.min(MAX_HISTORY_PAGE_EVENTS, Math.max(1, Math.floor(limit)));
  }
  if (role !== undefined) options.role = role;
  return options;
}

const DEFAULT_STREAMING_COALESCE_MS = 40;
const DEFAULT_STREAMING_COALESCE_MAX_BYTES = 64 * 1024;

function dedupeProviderSessionIds(providerSessionIds: readonly string[]): string[] {
  return [...new Set(providerSessionIds.filter(Boolean))];
}

export class StreamingTranscriptPersistenceError extends Error {
  readonly isReported = true;

  constructor(
    readonly appSessionId: string,
    readonly sourceSessionId: string,
    cause: unknown,
  ) {
    super(`Could not persist streaming transcript: ${errMsg(cause)}`, { cause });
    this.name = 'StreamingTranscriptPersistenceError';
  }
}

export function isReportedStreamingTranscriptError(
  error: unknown,
): error is StreamingTranscriptPersistenceError {
  return error instanceof StreamingTranscriptPersistenceError && error.isReported;
}

function streamingSourceKey(appSessionId: string, sourceSessionId: string): string {
  return `${appSessionId}\u0000${sourceSessionId}`;
}

function streamingEventOwner(event: TranscriptEvent): string {
  return event.role === 'primary' ? event.appSessionId : event.sourceSessionId;
}

export class SessionTimeline {
  private statusSeq = 0;
  private readonly loaders: SessionTimelineLoaders;
  private readonly streamingCoalesceMs: number;
  private readonly streamingCoalesceMaxBytes: number;
  // At most one buffered run: the most recent streaming delta and everything
  // merged into it. A single slot mirrors the renderer reducer, which only
  // merges into the *last* transcript event, so interleaved sources flush each
  // other and ordering is preserved exactly.
  private streamingBuffer: {
    event: TranscriptEvent;
    estimatedBytes: number;
    // Deltas merged into this buffered run so far; reported at flush as the
    // coalescing batch-size metric.
    mergedCount: number;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  private readonly streamingFlushFailures = new Map<string, StreamingTranscriptPersistenceError>();

  constructor(private readonly dependencies: SessionTimelineDependencies) {
    this.loaders = dependencies.loaders ?? {
      list: loadSessionHistory,
      page: loadSessionPage,
      hydrateMission: hydrateHistoricalSession,
      resolveChain: resolveSessionChain,
      transcriptWindow: loadSessionTranscriptWindow,
    };
    this.streamingCoalesceMs = dependencies.streamingCoalesceMs ?? DEFAULT_STREAMING_COALESCE_MS;
    this.streamingCoalesceMaxBytes =
      dependencies.streamingCoalesceMaxBytes ?? DEFAULT_STREAMING_COALESCE_MAX_BYTES;
  }

  list(): void {
    try {
      this.dependencies.emit({ type: 'history.list', sessions: this.loaders.list() });
    } catch (error) {
      this.dependencies.emitError({ message: errMsg(error) });
    }
  }

  load(appSessionIdOrProviderSessionId: string, cursor?: string, limit?: number): void {
    const summary = this.dependencies.registry.resolveSummary(appSessionIdOrProviderSessionId);
    const appSessionId = summary?.appSessionId ?? appSessionIdOrProviderSessionId;
    const providerSessionId = summary?.providerSessionId ?? appSessionIdOrProviderSessionId;
    try {
      const history =
        summary?.sessionPurpose === 'mission-control'
          ? this.loaders.hydrateMission(appSessionId, historyWindowOptions(cursor, limit))
          : this.loadStandard(appSessionId, providerSessionId, cursor, limit);
      const transcripts = history.transcripts.map((event) => ({ ...event, appSessionId }));
      this.record(transcripts);
      if (cursor) {
        this.emitHistory({
          appSessionId,
          progress: [],
          transcripts,
          mode: 'prepend',
          ...(history.olderCursor ? { olderCursor: history.olderCursor } : {}),
        });
        return;
      }
      this.emitHistory({
        appSessionId,
        progress: history.progress,
        transcripts,
        childSessions: this.dependencies.getChildSessions(appSessionId),
        mode: 'replace',
        ...(history.olderCursor ? { olderCursor: history.olderCursor } : {}),
      });
    } catch (error) {
      if (cursor) {
        this.emitHistory({
          appSessionId,
          progress: [],
          transcripts: [],
          mode: 'prepend',
        });
        return;
      }
      if (this.dependencies.registry.getLive(appSessionId)) {
        this.emitHistory({
          appSessionId,
          progress: [],
          transcripts: [],
          childSessions: this.dependencies.getChildSessions(appSessionId),
          mode: 'replace',
        });
        return;
      }
      const message = errMsg(error);
      this.dependencies.emit({ type: 'session.history.error', appSessionId, message });
      this.dependencies.emitError({
        appSessionId,
        providerSessionId,
        message,
        recoverable: true,
      });
    }
  }

  loadProviderPage(providerSessionId: string, cursor?: string, limit?: number): void {
    const summary = this.dependencies.registry.resolveSummary(providerSessionId);
    const appSessionId = summary?.appSessionId ?? providerSessionId;
    const resolvedProviderSessionId = summary?.providerSessionId ?? providerSessionId;
    try {
      const page = this.loaders.page(resolvedProviderSessionId, appSessionId, cursor, limit);
      this.record(page.events);
      this.dependencies.emit({
        type: 'session.history',
        appSessionId,
        progress: [],
        transcripts: page.events,
      });
    } catch (error) {
      this.dependencies.emitError({
        appSessionId,
        providerSessionId: resolvedProviderSessionId,
        message: errMsg(error),
      });
    }
  }

  loadChildHistory({
    appSessionId,
    childSessionId,
    childProviderSessionIds,
    role,
    cursor,
    limit,
  }: {
    appSessionId: string;
    childSessionId: string;
    childProviderSessionIds: readonly string[];
    role: SessionRole;
    cursor?: string;
    limit?: number;
  }): void {
    try {
      const currentProviderSessionId = childProviderSessionIds.at(-1) ?? childSessionId;
      const discoveredChain = this.loaders.resolveChain(childSessionId, currentProviderSessionId);
      const chain = dedupeProviderSessionIds([
        ...childProviderSessionIds.slice(0, -1),
        ...discoveredChain.filter((id) => id !== currentProviderSessionId),
        currentProviderSessionId,
      ]);
      const window = this.loaders.transcriptWindow(
        appSessionId,
        chain,
        historyWindowOptions(cursor, limit, role),
      );
      const transcripts = window.events.map((event) => ({
        ...event,
        appSessionId,
        sourceSessionId: childSessionId,
        role,
      }));
      this.emitHistory({
        appSessionId,
        childSessionId,
        progress: [],
        transcripts,
        mode: cursor ? 'prepend' : 'replace',
        ...(window.olderCursor ? { olderCursor: window.olderCursor } : {}),
      });
    } catch (error) {
      const providerSessionId = childProviderSessionIds.at(-1) ?? childSessionId;
      const message = errMsg(error);
      this.dependencies.emit({
        type: 'session.history.error',
        appSessionId,
        childSessionId,
        message,
      });
      this.dependencies.emitError({
        appSessionId,
        providerSessionId,
        message,
        recoverable: true,
      });
    }
  }

  append(event: TranscriptEvent): void {
    // Non-streaming appends (status lines, compaction dividers, replay) must
    // never overtake a buffered delta run, so the buffer flushes first.
    this.flushStreamingBefore(event);
    this.recordAndEmit(event);
  }

  // Live provider stream deltas arrive per token. Emitting each one costs a
  // history insert, a JSON serialization, and a full renderer re-render, so
  // consecutive deltas of one run coalesce into a single event flushed after
  // at most `streamingCoalesceMs`. The merge mirrors the renderer reducer's
  // delta merging exactly (same shape either way), so live UI output is
  // unchanged; only the message rate drops.
  appendStreaming(event: TranscriptEvent): void {
    if (this.streamingCoalesceMs <= 0) {
      this.append(event);
      return;
    }
    const buffer = this.streamingBuffer;
    if (buffer) {
      const merged = mergeStreamingDelta(buffer.event, event);
      if (merged) {
        const incomingBytes = estimateStreamingDeltaBytes(event);
        if (buffer.estimatedBytes + incomingBytes > this.streamingCoalesceMaxBytes) {
          this.flushStreamingBefore(event);
          this.bufferStreamingEvent(event, incomingBytes);
          return;
        }
        buffer.event = merged;
        buffer.estimatedBytes += incomingBytes;
        buffer.mergedCount += 1;
        return;
      }
    }
    this.flushStreamingBefore(event);
    if (isCoalescableDelta(event)) {
      this.bufferStreamingEvent(event, estimateStreamingDeltaBytes(event));
      return;
    }
    this.recordAndEmit(event);
  }

  private flushStreamingBefore(event: TranscriptEvent): void {
    try {
      this.flushStreaming();
    } catch (error) {
      if (
        !isReportedStreamingTranscriptError(error) ||
        (error.appSessionId === event.appSessionId &&
          error.sourceSessionId === streamingEventOwner(event))
      ) {
        throw error;
      }
      // One conversation's sticky persistence failure must not abort another
      // conversation that happened to arrive while its buffered tail flushed.
    }
  }

  // Emits any buffered delta run immediately. Called at turn settlement so the
  // final text lands before the turn reads as settled, and by every
  // non-streaming append to preserve transcript ordering.
  flushStreaming(): void {
    const buffer = this.streamingBuffer;
    if (!buffer) return;
    this.streamingBuffer = null;
    clearTimeout(buffer.timer);
    hotPathMetrics.recordCoalesce(buffer.mergedCount);
    try {
      this.recordAndEmit(buffer.event);
    } catch (error) {
      throw this.rememberStreamingFailure(buffer.event, error);
    }
  }

  flushStreamingFor(appSessionId: string, sourceSessionId: string): void {
    const buffer = this.streamingBuffer;
    if (!buffer) return;
    if (buffer.event.appSessionId !== appSessionId) return;
    if (streamingEventOwner(buffer.event) !== sourceSessionId) return;
    this.flushStreaming();
  }

  settleStreaming(appSessionId: string, sourceSessionId: string): void {
    let flushError: Error | undefined;
    try {
      this.flushStreamingFor(appSessionId, sourceSessionId);
    } catch (error) {
      flushError =
        error instanceof Error
          ? error
          : new Error('Could not persist streaming transcript', { cause: error });
    }
    const key = streamingSourceKey(appSessionId, sourceSessionId);
    const failure = this.streamingFlushFailures.get(key);
    if (failure) {
      this.streamingFlushFailures.delete(key);
      throw failure;
    }
    if (flushError) throw flushError;
  }

  private bufferStreamingEvent(event: TranscriptEvent, estimatedBytes: number): void {
    if (estimatedBytes >= this.streamingCoalesceMaxBytes) {
      this.recordAndEmit(event);
      return;
    }
    const timer = setTimeout(() => {
      try {
        this.flushStreaming();
      } catch {
        // The failure is reported and retained by flushStreaming. Turn
        // settlement remains its sole consumer.
      }
    }, this.streamingCoalesceMs);
    timer.unref();
    this.streamingBuffer = { event, estimatedBytes, mergedCount: 1, timer };
  }

  private rememberStreamingFailure(
    event: TranscriptEvent,
    cause: unknown,
  ): StreamingTranscriptPersistenceError {
    const sourceSessionId = streamingEventOwner(event);
    const key = streamingSourceKey(event.appSessionId, sourceSessionId);
    const existing = this.streamingFlushFailures.get(key);
    if (existing) return existing;
    const failure = new StreamingTranscriptPersistenceError(
      event.appSessionId,
      sourceSessionId,
      cause,
    );
    this.streamingFlushFailures.set(key, failure);
    if (event.role === 'primary') {
      this.dependencies.emitError({
        appSessionId: event.appSessionId,
        message: failure.message,
        recoverable: true,
      });
    } else {
      this.dependencies.emit({
        type: 'child.error',
        parentAppSessionId: event.appSessionId,
        childSessionId: event.sourceSessionId,
        operation: 'send',
        requestId: null,
        code: 'child.transcript_persist_failed',
        message: `Unable to persist buffered child output: ${errMsg(cause)}`,
        recoverable: true,
      });
    }
    return failure;
  }

  private recordAndEmit(event: TranscriptEvent): void {
    this.dependencies.history.recordEvent(event);
    // Emit timing wraps the configured sink. In production that sink is the
    // bridge broadcast, so emitMs contains transportMs by construction; the
    // transport histogram isolates the bridge's serialize + fan-out slice.
    // recordEvent reports its own persist stage from inside HistoryIndex.
    const emitStartedAt = performance.now();
    this.dependencies.emit({ type: 'event.appended', event });
    hotPathMetrics.recordEmit(performance.now() - emitStartedAt);
  }

  appendStatus(
    appSessionId: string,
    text: string,
    compactType?: CompactType,
    sourceSessionId = appSessionId,
    role: SessionRole = 'primary',
  ): void {
    const now = this.dependencies.now ?? Date.now;
    this.append({
      id: `status-${now().toString(36)}-${(this.statusSeq++).toString(36)}`,
      appSessionId,
      sourceSessionId,
      role,
      ts: now(),
      kind: 'status',
      text,
      ...(compactType ? { compactType } : {}),
    });
  }

  appendCompaction(
    appSessionId: string,
    removedCount: number,
    sourceSessionId = appSessionId,
    role: SessionRole = 'primary',
    summaryId?: string,
  ): void {
    const now = this.dependencies.now ?? Date.now;
    const ts = now();
    this.append({
      id: summaryId
        ? `compaction-${sourceSessionId}-${summaryId}`
        : `compaction-${ts.toString(36)}-${(this.statusSeq++).toString(36)}`,
      appSessionId,
      sourceSessionId,
      role,
      ts,
      kind: 'compaction',
      removedCount,
      compactType: 'auto',
    });
  }

  private loadStandard(
    appSessionId: string,
    providerSessionId: string,
    cursor?: string,
    limit?: number,
  ): ReturnType<typeof hydrateHistoricalSession> {
    const chain = this.loaders.resolveChain(appSessionId, providerSessionId);
    if (chain.length === 0) throw new Error(`Session history not found for ${providerSessionId}`);
    const window = this.loaders.transcriptWindow(
      appSessionId,
      chain,
      historyWindowOptions(cursor, limit),
    );
    return {
      progress: [],
      transcripts: window.events,
      ...(window.olderCursor ? { olderCursor: window.olderCursor } : {}),
    };
  }

  private emitHistory(page: SessionHistoryPage): void {
    this.dependencies.emit({
      type: 'session.history',
      appSessionId: page.appSessionId,
      ...(page.childSessionId ? { childSessionId: page.childSessionId } : {}),
      progress: page.progress,
      transcripts: page.transcripts,
      ...(page.childSessions ? { childSessions: page.childSessions } : {}),
      mode: page.mode,
      ...(page.olderCursor ? { olderCursor: page.olderCursor } : {}),
      loadedCount: page.transcripts.length,
      hasMore: Boolean(page.olderCursor),
    });
  }

  private record(events: TranscriptEvent[]): void {
    for (const event of events) this.dependencies.history.recordEvent(event);
  }
}

/* ── Streaming delta coalescing ──
   Mirrors the renderer's SESSION_TRANSCRIPT delta merging (src/hooks/
   useStore.tsx): text/thinking runs concatenate, tool_call partials collapse
   onto one event per toolUseId. Keep both sides synchronized in the same
   change, or live rendering and replay drift apart. */

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

// Protocol mirror of the renderer's mergeToolArgs (src/hooks/useStore.tsx).
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
