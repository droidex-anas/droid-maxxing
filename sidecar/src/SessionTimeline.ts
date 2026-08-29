import type {
  ChildSessionSummary,
  ProgressEntry,
  ServerEvent,
  SessionRole,
  SessionSummary,
  TranscriptEvent,
} from './protocol.js';
import type { CompactType } from './compaction.js';
import type { SessionStore } from './persistence/SessionStore.js';
import type { TranscriptStore } from './persistence/TranscriptStore.js';
import { errMsg } from './sessionHelpers.js';
import type { ShutdownDeadline } from './providers/shutdownDeadline.js';
import {
  liftRendererTranscriptEvent,
  projectTranscriptEvent,
  type CanonicalIdentity,
} from './sessionEvents.js';
import {
  childHistoryPageFromStore,
  historyPageFromStore,
  requireStoredSession,
} from './sessionCanonicalServing.js';
import { StreamingDeltaCoalescer, streamingEventOwner } from './streamingDeltaCoalescer.js';
import { hotPathMetrics } from './telemetry/hotPathMetrics.js';

type TimelineError = Omit<Extract<ServerEvent, { type: 'error' }>, 'type'>;

export interface SessionTimelineRegistry {
  resolveSummary(id: string): SessionSummary | undefined;
  getCanonicalSummary(id: string): SessionSummary | undefined;
  getLive(id: string): unknown;
}

export interface SessionTimelineDependencies {
  registry: SessionTimelineRegistry;
  getChildSessions: (appSessionId: string) => ChildSessionSummary[];
  emit: (event: ServerEvent) => void;
  emitError: (error: TimelineError) => void;
  now?: () => number;
  transcriptStore?: Pick<TranscriptStore, 'append'> & Partial<Pick<TranscriptStore, 'page'>>;
  sessionStore?: Pick<SessionStore, 'get'>;
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
const DEFAULT_STREAMING_COALESCE_MS = 40;
const DEFAULT_STREAMING_COALESCE_MAX_BYTES = 64 * 1024;

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
  private readonly streaming: StreamingDeltaCoalescer;
  private readonly streamingFlushFailures = new Map<string, StreamingTranscriptPersistenceError>();

  constructor(private readonly dependencies: SessionTimelineDependencies) {
    this.streaming = new StreamingDeltaCoalescer({
      windowMs: dependencies.streamingCoalesceMs ?? DEFAULT_STREAMING_COALESCE_MS,
      maxBytes: dependencies.streamingCoalesceMaxBytes ?? DEFAULT_STREAMING_COALESCE_MAX_BYTES,
      deliver: (event) => {
        this.deliverStreamingRun(event);
      },
    });
  }

  load(appSessionIdOrProviderSessionId: string, cursor?: string, limit?: number): void {
    const store = this.dependencies.sessionStore;
    const transcriptStore = this.dependencies.transcriptStore;
    const pageFn = transcriptStore?.page;
    if (!store || !transcriptStore || !pageFn) {
      this.emitHistoryError(appSessionIdOrProviderSessionId, 'Canonical transcript store is required.');
      return;
    }
    try {
      const stored = requireStoredSession(store, appSessionIdOrProviderSessionId);
      const page = historyPageFromStore(
        { page: pageFn.bind(transcriptStore) },
        stored.summary.appSessionId,
        cursor,
        limit,
      );
      this.emitHistory({
        appSessionId: stored.summary.appSessionId,
        progress: [],
        transcripts: page.transcripts,
        ...(cursor
          ? { mode: 'prepend' as const }
          : {
              mode: 'replace' as const,
              childSessions: this.dependencies.getChildSessions(stored.summary.appSessionId),
            }),
        ...(page.olderCursor !== undefined ? { olderCursor: page.olderCursor } : {}),
      });
    } catch (error) {
      this.emitHistoryError(appSessionIdOrProviderSessionId, errMsg(error));
    }
  }

  loadChildHistory({
    appSessionId,
    childSessionId,
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
    const transcriptStore = this.dependencies.transcriptStore;
    const pageFn = transcriptStore?.page;
    if (!transcriptStore || !pageFn) {
      this.emitHistoryError(appSessionId, 'Canonical transcript store is required.', childSessionId);
      return;
    }
    try {
      const page = childHistoryPageFromStore(
        { page: pageFn.bind(transcriptStore) },
        appSessionId,
        childSessionId,
        cursor,
        limit,
      );
      const events = page.transcripts.map((event) => ({ ...event, role }));
      this.emitHistory({
        appSessionId,
        childSessionId,
        progress: [],
        transcripts: events,
        mode: cursor ? 'prepend' : 'replace',
        ...(page.olderCursor ? { olderCursor: page.olderCursor } : {}),
      });
    } catch (error) {
      this.emitHistoryError(appSessionId, errMsg(error), childSessionId);
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
    if (!store) {
      this.emitRecordedEvent(event);
      return;
    }
    const persistStartedAt = performance.now();
    let persisted;
    try {
      persisted = store.append(
        liftRendererTranscriptEvent(event, this.canonicalIdentityFor(event)),
      );
    } catch (error) {
      hotPathMetrics.recordPersistenceFailure();
      throw error;
    }
    hotPathMetrics.recordPersist(performance.now() - persistStartedAt);
    const projected = projectTranscriptEvent(persisted);
    if (!projected) return;
    this.emitRecordedEvent(projected);
  }

  private emitRecordedEvent(event: TranscriptEvent): void {
    // Emit timing covers handoff into the ordered bridge queue. Priority or
    // size-boundary events can synchronously trigger a flush inside that call;
    // transportMs isolates the serialization + fan-out slice. Persist timing is
    // recorded around the in-process TranscriptStore append.

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

  private canonicalIdentityFor(event: TranscriptEvent): CanonicalIdentity {
    if (this.dependencies.canonicalIdentity) return this.dependencies.canonicalIdentity;
    const stored = this.dependencies.sessionStore?.get(event.appSessionId);
    if (!stored) {
      throw new Error('canonicalIdentity is required when transcriptStore is set.');
    }
    return {
      providerDriverKind: stored.binding.providerDriverKind,
      providerInstanceId: stored.binding.providerInstanceId,
      runtimeGeneration: stored.binding.runtimeGeneration,
    };
  }

  private emitHistoryError(appSessionId: string, message: string, childSessionId?: string): void {
    this.dependencies.emit({
      type: 'session.history.error',
      appSessionId,
      ...(childSessionId ? { childSessionId } : {}),
      message,
    });
    this.dependencies.emitError({
      appSessionId,
      message,
      recoverable: true,
    });
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
}
