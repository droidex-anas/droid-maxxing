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
}

interface SessionHistoryPage {
  appSessionId: string;
  progress: ProgressEntry[];
  transcripts: TranscriptEvent[];
  childSessions?: ChildSessionSummary[];
  mode: 'replace' | 'prepend';
  olderCursor?: string;
}

// Preserve the existing enumerable `cursor: undefined` loader boundary while
// keeping the extracted module clean under exactOptionalPropertyTypes.
function legacyCursorOptions(cursor: string | undefined): { cursor?: string } {
  const options: { cursor?: string } = {};
  Object.defineProperty(options, 'cursor', { enumerable: true, value: cursor });
  return options;
}

const DEFAULT_STREAMING_COALESCE_MS = 40;

export class SessionTimeline {
  private statusSeq = 0;
  private readonly loaders: SessionTimelineLoaders;
  private readonly streamingCoalesceMs: number;
  // At most one buffered run: the most recent streaming delta and everything
  // merged into it. A single slot mirrors the renderer reducer, which only
  // merges into the *last* transcript event, so interleaved sources flush each
  // other and ordering is preserved exactly.
  private streamingBuffer: { event: TranscriptEvent; timer: ReturnType<typeof setTimeout> } | null =
    null;

  constructor(private readonly dependencies: SessionTimelineDependencies) {
    this.loaders = dependencies.loaders ?? {
      list: loadSessionHistory,
      page: loadSessionPage,
      hydrateMission: hydrateHistoricalSession,
      resolveChain: resolveSessionChain,
      transcriptWindow: loadSessionTranscriptWindow,
    };
    this.streamingCoalesceMs = dependencies.streamingCoalesceMs ?? DEFAULT_STREAMING_COALESCE_MS;
  }

  list(): void {
    try {
      this.dependencies.emit({ type: 'history.list', sessions: this.loaders.list() });
    } catch (error) {
      this.dependencies.emitError({ message: errMsg(error) });
    }
  }

  load(appSessionIdOrProviderSessionId: string, cursor?: string): void {
    const summary = this.dependencies.registry.resolveSummary(appSessionIdOrProviderSessionId);
    const appSessionId = summary?.appSessionId ?? appSessionIdOrProviderSessionId;
    const providerSessionId = summary?.providerSessionId ?? appSessionIdOrProviderSessionId;
    try {
      const history =
        summary?.sessionPurpose === 'mission-control'
          ? this.loaders.hydrateMission(appSessionId, legacyCursorOptions(cursor))
          : this.loadStandard(appSessionId, providerSessionId, cursor);
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

  replayChild(appSessionId: string, childSessionId: string, childProviderSessionId: string): void {
    try {
      const page = this.loaders.page(childProviderSessionId, appSessionId, undefined, 200);
      for (const event of page.events)
        this.append({
          ...event,
          appSessionId,
          sourceSessionId: childSessionId,
        });
    } catch {
      // Some live child sessions have not flushed history yet.
    }
  }

  append(event: TranscriptEvent): void {
    // Non-streaming appends (status lines, compaction dividers, replay) must
    // never overtake a buffered delta run, so the buffer flushes first.
    this.flushStreaming();
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
        buffer.event = merged;
        return;
      }
    }
    this.flushStreaming();
    if (isCoalescableDelta(event)) {
      const timer = setTimeout(() => {
        this.flushStreaming();
      }, this.streamingCoalesceMs);
      timer.unref();
      this.streamingBuffer = { event, timer };
      return;
    }
    this.recordAndEmit(event);
  }

  // Emits any buffered delta run immediately. Called at turn settlement so the
  // final text lands before the turn reads as settled, and by every
  // non-streaming append to preserve transcript ordering.
  flushStreaming(): void {
    const buffer = this.streamingBuffer;
    if (!buffer) return;
    this.streamingBuffer = null;
    clearTimeout(buffer.timer);
    this.recordAndEmit(buffer.event);
  }

  private recordAndEmit(event: TranscriptEvent): void {
    this.dependencies.history.recordEvent(event);
    this.dependencies.emit({ type: 'event.appended', event });
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
  ): ReturnType<typeof hydrateHistoricalSession> {
    const chain = this.loaders.resolveChain(appSessionId, providerSessionId);
    if (chain.length === 0) throw new Error(`Session history not found for ${providerSessionId}`);
    const window = this.loaders.transcriptWindow(appSessionId, chain, legacyCursorOptions(cursor));
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
