import {
  hydrateHistoricalSession,
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
import type { TranscriptStore } from './persistence/TranscriptStore.js';
import { errMsg } from './sessionHelpers.js';
import type { ShutdownDeadline } from './providers/shutdownDeadline.js';
import {
  liftRendererTranscriptEvent,
  projectTranscriptEvent,
  type CanonicalIdentity,
} from './sessionEvents.js';
import { StreamingDeltaCoalescer, streamingEventOwner } from './streamingDeltaCoalescer.js';
import { hotPathMetrics } from './telemetry/hotPathMetrics.js';

interface TimelineHistory {
  recordEvent(event: TranscriptEvent): void;
}
type TimelineError = Omit<Extract<ServerEvent, { type: 'error' }>, 'type'>;

export interface SessionTimelineLoaders {
  page: typeof loadSessionPage;
  hydrateMission: typeof hydrateHistoricalSession;
  resolveChain: typeof resolveSessionChain;
  transcriptWindow: typeof loadSessionTranscriptWindow;
}

export interface SessionTimelineRegistry {
  resolveSummary(id: string): SessionSummary | undefined;
  getCanonicalSummary(id: string): SessionSummary | undefined;
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
  transcriptStore?: Pick<TranscriptStore, 'append'>;
  canonicalIdentity?: CanonicalIdentity;
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

export class SessionTimeline {
  private statusSeq = 0;
  private readonly loaders: SessionTimelineLoaders;
  private readonly streaming: StreamingDeltaCoalescer;
  private readonly streamingFlushFailures = new Map<string, StreamingTranscriptPersistenceError>();

  constructor(private readonly dependencies: SessionTimelineDependencies) {
    this.loaders = dependencies.loaders ?? {
      page: loadSessionPage,
      hydrateMission: hydrateHistoricalSession,
      resolveChain: resolveSessionChain,
      transcriptWindow: loadSessionTranscriptWindow,
    };
    this.streaming = new StreamingDeltaCoalescer({
      windowMs: dependencies.streamingCoalesceMs ?? DEFAULT_STREAMING_COALESCE_MS,
      maxBytes: dependencies.streamingCoalesceMaxBytes ?? DEFAULT_STREAMING_COALESCE_MAX_BYTES,
      deliver: (event) => {
        this.deliverStreamingRun(event);
      },
    });
  }

  load(appSessionIdOrProviderSessionId: string, cursor?: string, limit?: number): void {
    const summary =
      this.dependencies.registry.getCanonicalSummary(appSessionIdOrProviderSessionId) ??
      this.dependencies.registry.resolveSummary(appSessionIdOrProviderSessionId);
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
        message,
        recoverable: true,
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
      const message = errMsg(error);
      this.dependencies.emit({
        type: 'session.history.error',
        appSessionId,
        childSessionId,
        message,
      });
      this.dependencies.emitError({
        appSessionId,
        message,
        recoverable: true,
      });
    }
  }

  append(event: TranscriptEvent): void {
    // Non-streaming appends (status lines, compaction dividers, replay) must
    // never overtake their own source's buffered delta run.
    this.streaming.flushSource(event.appSessionId, streamingEventOwner(event));
    this.recordAndEmit(event);
  }

  appendStreaming(event: TranscriptEvent): void {
    this.streaming.accept(event);
  }

  // Emits every buffered delta run immediately. Shutdown only: turn settlement
  // and mid-turn side effects flush the one source that owns the run.
  flushStreaming(_deadline?: ShutdownDeadline): void {
    this.streaming.flushAll();
  }

  flushStreamingFor(appSessionId: string, sourceSessionId: string): void {
    this.streaming.flushSource(appSessionId, sourceSessionId);
  }

  settleStreaming(appSessionId: string, sourceSessionId: string): void {
    let flushError: Error | undefined;
    try {
      this.streaming.endTurn(appSessionId, sourceSessionId);
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

  private deliverStreamingRun(event: TranscriptEvent): void {
    try {
      this.recordAndEmit(event);
    } catch (error) {
      throw this.rememberStreamingFailure(event, error);
    }
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
    const store = this.dependencies.transcriptStore;
    if (store) {
      const identity = this.dependencies.canonicalIdentity;
      if (!identity) {
        throw new Error('canonicalIdentity is required when transcriptStore is set.');
      }
      const persisted = store.append(liftRendererTranscriptEvent(event, identity));
      const projected = projectTranscriptEvent(persisted);
      if (!projected) return;
      this.emitRecordedEvent(projected);
      return;
    }
    this.dependencies.history.recordEvent(event);
    this.emitRecordedEvent(event);
  }

  private emitRecordedEvent(event: TranscriptEvent): void {
    // Emit timing covers handoff into the ordered bridge queue. Priority or
    // size-boundary events can synchronously trigger a flush inside that call;
    // transportMs isolates the serialization + fan-out slice. Persistence is
    // measured independently by the worker-backed persistence queue.
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
