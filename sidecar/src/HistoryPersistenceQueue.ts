import type { PersistedChildSession } from './history.js';
import {
  HistoryWorkerClient,
  type HistoryPersistenceCall,
  type HistoryPersistenceClient,
} from './HistoryWorkerClient.js';
import {
  emptyPersistenceBatch,
  eventMetadata,
  persistenceRowCount,
  type HistoryPersistenceBatch,
  type HistoryPersistenceQueueSnapshot,
  type HistoryPersistenceResult,
  type PersistedEventMetadata,
} from './historyPersistenceProtocol.js';
import type { SessionSearchResult, SessionSummary, TranscriptEvent } from './protocol.js';
import type { SessionSearchCandidate } from './sessionSearch.js';
const DEFAULT_FLUSH_DELAY_MS = 25;
const DEFAULT_RETRY_DELAY_MS = 250;
const DEFAULT_SYNC_TIMEOUT_MS = 10_000;
const MAX_BATCH_ROWS = 512;
const MAX_BATCH_BYTES = 512 * 1024;
const HARD_QUEUE_ROWS = 50_000;
const HARD_QUEUE_BYTES = 64 * 1024 * 1024;
interface PendingValue<T> {
  value: T;
  estimatedBytes: number;
}
interface InFlightBatch {
  batch: HistoryPersistenceBatch;
  call: HistoryPersistenceCall<HistoryPersistenceResult>;
  settled: Promise<void>;
}
export interface HistoryPersistenceQueueOptions {
  dbPath: string;
  client?: HistoryPersistenceClient;
  flushDelayMs?: number;
  retryDelayMs?: number;
  syncTimeoutMs?: number;
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  cancel?: (timer: ReturnType<typeof setTimeout>) => void;
  onCommitted?: (batch: HistoryPersistenceBatch, result: HistoryPersistenceResult) => void;
  onFailure?: (error: Error) => void;
}
export class HistoryPersistenceBackpressureError extends Error {
  constructor(entries: number, bytes: number) {
    super(
      `History persistence queue exceeded its bounded capacity (${String(entries)} entries, ${String(bytes)} bytes).`,
    );
    this.name = 'HistoryPersistenceBackpressureError';
  }
}
export class HistoryPersistenceQueue {
  private readonly client: HistoryPersistenceClient;
  private readonly flushDelayMs: number;
  private readonly retryDelayMs: number;
  private readonly syncTimeoutMs: number;
  private readonly schedule: NonNullable<HistoryPersistenceQueueOptions['schedule']>;
  private readonly cancel: NonNullable<HistoryPersistenceQueueOptions['cancel']>;
  private readonly onCommitted: NonNullable<HistoryPersistenceQueueOptions['onCommitted']>;
  private readonly onFailure: NonNullable<HistoryPersistenceQueueOptions['onFailure']>;
  private events: PendingValue<PersistedEventMetadata>[] = [];
  private eventHead = 0;
  private readonly summaries = new Map<string, PendingValue<SessionSummary>>();
  private readonly children = new Map<string, PendingValue<PersistedChildSession>>();
  private estimatedBytes = 0;
  private inFlight: InFlightBatch | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private terminalError: Error | null = null;
  private closed = false;
  private peakEntries = 0;
  private peakEstimatedBytes = 0;
  private batchesCommitted = 0;
  private rowsCommitted = 0;
  private failures = 0;
  private retries = 0;
  constructor(options: HistoryPersistenceQueueOptions) {
    this.client =
      options.client ?? new HistoryWorkerClient({ workerData: { dbPath: options.dbPath } });
    this.flushDelayMs = options.flushDelayMs ?? DEFAULT_FLUSH_DELAY_MS;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.syncTimeoutMs = options.syncTimeoutMs ?? DEFAULT_SYNC_TIMEOUT_MS;
    this.schedule =
      options.schedule ??
      ((callback, delayMs) => {
        const timer = setTimeout(callback, delayMs);
        timer.unref();
        return timer;
      });
    this.cancel = options.cancel ?? clearTimeout;
    this.onCommitted = options.onCommitted ?? (() => undefined);
    this.onFailure = options.onFailure ?? (() => undefined);
  }

  enqueueEvent(event: TranscriptEvent): void {
    this.assertOpen();
    const value = eventMetadata(event);
    const estimatedBytes = estimateValueBytes(value);
    this.assertCapacity(1, estimatedBytes);
    this.events.push({ value, estimatedBytes });
    this.estimatedBytes += estimatedBytes;
    this.afterEnqueue();
  }

  enqueueSummaries(summaries: readonly SessionSummary[]): SessionSummary[] {
    this.assertOpen();
    const staged = new Map<string, PendingValue<SessionSummary>>();
    for (const summary of summaries) {
      const value = copySummary(summary);
      staged.set(value.appSessionId, {
        value,
        estimatedBytes: estimateValueBytes(value),
      });
    }
    let additionalRows = 0;
    let additionalBytes = 0;
    for (const [appSessionId, pending] of staged) {
      const previous = this.summaries.get(appSessionId);
      if (!previous) additionalRows += 1;
      additionalBytes += pending.estimatedBytes - (previous?.estimatedBytes ?? 0);
    }
    this.assertCapacity(additionalRows, additionalBytes);
    for (const [appSessionId, pending] of staged) {
      const previous = this.summaries.get(appSessionId);
      this.summaries.set(appSessionId, pending);
      this.estimatedBytes += pending.estimatedBytes - (previous?.estimatedBytes ?? 0);
    }
    if (staged.size > 0) this.afterEnqueue();
    return [...staged.values()].map((pending) => pending.value);
  }

  enqueueChild(child: PersistedChildSession): PersistedChildSession {
    this.assertOpen();
    const value = copyChild(child);
    const key = childKey(value.parentAppSessionId, value.childSessionId);
    const estimatedBytes = estimateValueBytes(value);
    const previous = this.children.get(key);
    this.assertCapacity(previous ? 0 : 1, estimatedBytes - (previous?.estimatedBytes ?? 0));
    this.children.set(key, { value, estimatedBytes });
    this.estimatedBytes += estimatedBytes - (previous?.estimatedBytes ?? 0);
    this.afterEnqueue();
    return value;
  }

  async search(
    query: string,
    candidates: SessionSearchCandidate[] = [],
  ): Promise<SessionSearchResult[]> {
    this.assertOpen();
    await this.flush();
    return await this.client.search(query, candidates);
  }

  invalidateSearch(): void {
    if (!this.closed) this.client.invalidateSearch();
  }

  async flush(): Promise<void> {
    this.assertOpen();
    this.clearTimers();
    while (!this.isDrained()) {
      if (!this.inFlight) this.startNext();
      const current = this.inFlight;
      if (!current) return;
      await current.settled;
    }
  }

  flushSync(): void {
    this.assertOpen();
    this.clearTimers();
    while (!this.isDrained()) {
      if (!this.inFlight) this.startNext();
      const current = this.inFlight;
      if (!current) return;
      try {
        const result = current.call.waitSync(this.syncTimeoutMs);
        this.finishSuccess(current, result);
      } catch (error) {
        const resolved = asError(error);
        this.finishFailure(current, resolved);
        throw resolved;
      }
    }
  }

  close(): void {
    if (this.closed) return;
    this.clearTimers();
    let firstError: Error | undefined;
    try {
      this.flushSync();
    } catch (error) {
      firstError = asError(error);
    }
    try {
      this.client.closeSync();
    } catch (error) {
      firstError ??= asError(error);
    }
    this.closed = true;
    if (firstError) throw firstError;
  }

  snapshot(): HistoryPersistenceQueueSnapshot {
    const inFlightEntries = this.inFlight ? persistenceRowCount(this.inFlight.batch) : 0;
    const inFlightEstimatedBytes = this.inFlight?.batch.estimatedBytes ?? 0;
    return {
      pendingEntries: this.pendingRows(),
      pendingEstimatedBytes: this.estimatedBytes,
      inFlightEntries,
      inFlightEstimatedBytes,
      peakEntries: this.peakEntries,
      peakEstimatedBytes: this.peakEstimatedBytes,
      batchesCommitted: this.batchesCommitted,
      rowsCommitted: this.rowsCommitted,
      failures: this.failures,
      retries: this.retries,
    };
  }

  private afterEnqueue(): void {
    this.notePeak();
    if (this.pendingRows() >= MAX_BATCH_ROWS || this.estimatedBytes >= MAX_BATCH_BYTES) {
      this.clearFlushTimer();
      this.startNext();
      return;
    }
    this.scheduleFlush();
  }

  private startNext(): void {
    if (this.inFlight || this.pendingRows() === 0 || this.closed) return;
    const batch = this.takeBatch();
    let call: HistoryPersistenceCall<HistoryPersistenceResult>;
    try {
      call = this.client.startPersist(batch);
    } catch (error) {
      const resolved = asError(error);
      this.failures += 1;
      this.terminalError = resolved;
      this.restoreBatch(batch);
      try {
        this.onFailure(resolved);
      } catch (reportError) {
        console.error('History persistence failure reporting failed:', reportError);
      }
      throw resolved;
    }
    const current: InFlightBatch = { batch, call, settled: Promise.resolve() };
    current.settled = call.promise.then(
      (result) => {
        this.finishSuccess(current, result);
      },
      (error: unknown) => {
        const resolved = asError(error);
        this.finishFailure(current, resolved);
        throw resolved;
      },
    );
    void current.settled.catch(() => undefined);
    this.inFlight = current;
  }

  private finishSuccess(current: InFlightBatch, result: HistoryPersistenceResult): void {
    if (this.inFlight !== current) return;
    this.inFlight = null;
    this.batchesCommitted += 1;
    this.rowsCommitted += persistenceRowCount(current.batch);
    try {
      this.onCommitted(current.batch, result);
    } catch (error) {
      // SQLite committed already, so retrying bookkeeping would duplicate work.
      console.error('History persistence commit bookkeeping failed:', error);
    }
    if (this.pendingRows() > 0) this.startNext();
  }

  private finishFailure(current: InFlightBatch, error: Error): void {
    if (this.inFlight !== current) return;
    this.inFlight = null;
    this.failures += 1;
    this.restoreBatch(current.batch);
    try {
      this.onFailure(error);
    } catch (reportError) {
      console.error('History persistence failure reporting failed:', reportError);
    }
    this.scheduleRetry();
  }

  private takeBatch(): HistoryPersistenceBatch {
    const batch = emptyPersistenceBatch();
    let rows = 0;
    let bytes = 0;
    const latestRows = this.summaries.size + this.children.size;
    const firstEventLimit = Math.max(1, MAX_BATCH_ROWS - Math.min(128, latestRows));

    ({ rows, bytes } = this.takeEvents(batch, rows, bytes, firstEventLimit));
    ({ rows, bytes } = this.takeLatest(this.summaries, batch.summaries, rows, bytes));
    ({ rows, bytes } = this.takeLatest(this.children, batch.children, rows, bytes));
    ({ rows, bytes } = this.takeEvents(batch, rows, bytes, MAX_BATCH_ROWS));
    batch.estimatedBytes = bytes;
    if (rows === 0) throw new Error('Cannot create an empty history persistence batch.');
    return batch;
  }

  private takeEvents(
    batch: HistoryPersistenceBatch,
    initialRows: number,
    initialBytes: number,
    rowLimit: number,
  ): { rows: number; bytes: number } {
    let rows = initialRows;
    let bytes = initialBytes;
    while (this.eventHead < this.events.length && rows < rowLimit && rows < MAX_BATCH_ROWS) {
      const pending = this.events.at(this.eventHead);
      if (!pending) break;
      if (rows > 0 && bytes + pending.estimatedBytes > MAX_BATCH_BYTES) break;
      batch.events.push(pending.value);
      this.eventHead += 1;
      rows += 1;
      bytes += pending.estimatedBytes;
      this.estimatedBytes -= pending.estimatedBytes;
    }
    this.compactEventQueue();
    return { rows, bytes };
  }

  private takeLatest<T>(
    source: Map<string, PendingValue<T>>,
    target: T[],
    initialRows: number,
    initialBytes: number,
  ): { rows: number; bytes: number } {
    let rows = initialRows;
    let bytes = initialBytes;
    for (const [key, pending] of source) {
      if (rows >= MAX_BATCH_ROWS) break;
      if (rows > 0 && bytes + pending.estimatedBytes > MAX_BATCH_BYTES) break;
      source.delete(key);
      target.push(pending.value);
      rows += 1;
      bytes += pending.estimatedBytes;
      this.estimatedBytes -= pending.estimatedBytes;
    }
    return { rows, bytes };
  }

  private restoreBatch(batch: HistoryPersistenceBatch): void {
    if (batch.events.length > 0) {
      const restored = batch.events.map((value) => ({
        value,
        estimatedBytes: estimateValueBytes(value),
      }));
      this.events = restored.concat(this.events.slice(this.eventHead));
      this.eventHead = 0;
      for (const event of restored) this.estimatedBytes += event.estimatedBytes;
    }
    for (const value of batch.summaries) {
      if (this.summaries.has(value.appSessionId)) continue;
      const estimatedBytes = estimateValueBytes(value);
      this.summaries.set(value.appSessionId, { value, estimatedBytes });
      this.estimatedBytes += estimatedBytes;
    }
    for (const value of batch.children) {
      const key = childKey(value.parentAppSessionId, value.childSessionId);
      if (this.children.has(key)) continue;
      const estimatedBytes = estimateValueBytes(value);
      this.children.set(key, { value, estimatedBytes });
      this.estimatedBytes += estimatedBytes;
    }
    this.notePeak();
  }

  private assertCapacity(additionalRows: number, additionalBytes: number): void {
    const inFlightRows = this.inFlight ? persistenceRowCount(this.inFlight.batch) : 0;
    const rows = this.pendingRows() + inFlightRows + additionalRows;
    const bytes =
      this.estimatedBytes + (this.inFlight?.batch.estimatedBytes ?? 0) + additionalBytes;
    if (rows > HARD_QUEUE_ROWS || bytes > HARD_QUEUE_BYTES) {
      throw new HistoryPersistenceBackpressureError(rows, bytes);
    }
  }

  private notePeak(): void {
    const inFlightRows = this.inFlight ? persistenceRowCount(this.inFlight.batch) : 0;
    this.peakEntries = Math.max(this.peakEntries, this.pendingRows() + inFlightRows);
    this.peakEstimatedBytes = Math.max(
      this.peakEstimatedBytes,
      this.estimatedBytes + (this.inFlight?.batch.estimatedBytes ?? 0),
    );
  }

  private pendingRows(): number {
    return this.events.length - this.eventHead + this.summaries.size + this.children.size;
  }

  private isDrained(): boolean {
    return this.pendingRows() === 0 && this.inFlight === null;
  }

  private compactEventQueue(): void {
    if (this.eventHead === this.events.length) {
      this.events = [];
      this.eventHead = 0;
    } else if (this.eventHead > 1_024 && this.eventHead * 2 > this.events.length) {
      this.events = this.events.slice(this.eventHead);
      this.eventHead = 0;
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer || this.retryTimer || this.inFlight || this.closed) return;
    this.flushTimer = this.schedule(() => {
      this.flushTimer = null;
      try {
        this.startNext();
      } catch {
        // startNext restored the batch and latched the terminal failure.
      }
    }, this.flushDelayMs);
  }

  private scheduleRetry(): void {
    if (this.retryTimer || this.closed) return;
    this.retryTimer = this.schedule(() => {
      this.retryTimer = null;
      this.retries += 1;
      try {
        this.startNext();
      } catch {
        // startNext restored the batch and latched the terminal failure.
      }
    }, this.retryDelayMs);
  }

  private clearTimers(): void {
    this.clearFlushTimer();
    if (this.retryTimer) {
      this.cancel(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private clearFlushTimer(): void {
    if (!this.flushTimer) return;
    this.cancel(this.flushTimer);
    this.flushTimer = null;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('History persistence queue is closed.');
    if (this.terminalError) throw this.terminalError;
  }
}

function childKey(parentAppSessionId: string, childSessionId: string): string {
  return JSON.stringify([parentAppSessionId, childSessionId]);
}

function estimateValueBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8') + 64;
  } catch {
    return MAX_BATCH_BYTES + 1;
  }
}

function copySummary(summary: SessionSummary): SessionSummary {
  return {
    ...summary,
    ...(summary.compactedFromProviderSessionIds
      ? { compactedFromProviderSessionIds: [...summary.compactedFromProviderSessionIds] }
      : {}),
    features: summary.features.map((feature) => ({
      ...feature,
      preconditions: [...feature.preconditions],
      expectedBehavior: [...feature.expectedBehavior],
      verificationSteps: [...feature.verificationSteps],
      ...(feature.fulfills ? { fulfills: [...feature.fulfills] } : {}),
    })),
  };
}

function copyChild(child: PersistedChildSession): PersistedChildSession {
  return {
    ...child,
    ...(child.previousProviderSessionIds
      ? { previousProviderSessionIds: [...child.previousProviderSessionIds] }
      : {}),
    ...(child.spawnLink ? { spawnLink: { ...child.spawnLink } } : {}),
  };
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
