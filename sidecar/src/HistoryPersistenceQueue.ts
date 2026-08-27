import type { PersistedChildSession } from './history.js';
import { HistoryPersistencePending } from './HistoryPersistencePending.js';
import {
  HistoryWorkerClient,
  type HistoryPersistenceCall,
  type HistoryPersistenceClient,
} from './HistoryWorkerClient.js';
import {
  eventMetadata,
  persistenceRowCount,
  type HistoryPersistenceQueueSnapshot,
  type HistoryPersistenceResult,
} from './historyPersistenceProtocol.js';
import {
  HistoryPersistenceBackpressureError,
  type HistoryPersistenceQueueOptions,
  type InFlightPersistenceBatch,
  MAX_PERSISTENCE_BATCH_BYTES,
  MAX_PERSISTENCE_BATCH_ROWS,
  MAX_PERSISTENCE_QUEUE_BYTES,
  MAX_PERSISTENCE_QUEUE_ROWS,
} from './historyPersistenceQueueValues.js';
import type { SessionSummary, TranscriptEvent } from './protocol.js';

export {
  HistoryPersistenceBackpressureError,
  type HistoryPersistenceQueueOptions,
} from './historyPersistenceQueueValues.js';

const DEFAULT_FLUSH_DELAY_MS = 25;
const DEFAULT_RETRY_DELAY_MS = 250;
const MAX_RETRY_DELAY_MS = 5_000;
const DEFAULT_SYNC_TIMEOUT_MS = 10_000;
export class HistoryPersistenceQueue {
  private client: HistoryPersistenceClient | null;
  private readonly createDefaultClient: () => HistoryPersistenceClient;
  private readonly flushDelayMs: number;
  private readonly retryDelayMs: number;
  private readonly syncTimeoutMs: number;
  private readonly schedule: NonNullable<HistoryPersistenceQueueOptions['schedule']>;
  private readonly cancel: NonNullable<HistoryPersistenceQueueOptions['cancel']>;
  private readonly onCommitted: NonNullable<HistoryPersistenceQueueOptions['onCommitted']>;
  private readonly onFailure: NonNullable<HistoryPersistenceQueueOptions['onFailure']>;
  private readonly onRecovered: NonNullable<HistoryPersistenceQueueOptions['onRecovered']>;
  private readonly dirtyMarker: HistoryPersistenceQueueOptions['dirtyMarker'];
  private readonly pending: HistoryPersistencePending;
  private inFlight: InFlightPersistenceBatch | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private lastFailure: Error | null = null;
  private degraded = false;
  private durabilityBarrierPending = false;
  private durabilityBarrierInFlight: HistoryPersistenceCall<{ durable: true }> | null = null;
  private closed = false;
  private peakEntries = 0;
  private peakEstimatedBytes = 0;
  private batchesCommitted = 0;
  private rowsCommitted = 0;
  private failures = 0;
  private retries = 0;
  private consecutiveFailures = 0;
  constructor(options: HistoryPersistenceQueueOptions) {
    this.client = options.client ?? null;
    this.createDefaultClient = () =>
      new HistoryWorkerClient({
        workerData: { dbPath: options.dbPath, lane: 'persistence' },
      });
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
    this.onRecovered = options.onRecovered ?? (() => undefined);
    this.dirtyMarker = options.dirtyMarker;
    this.pending = new HistoryPersistencePending((additionalRows, additionalBytes) => {
      this.assertCapacity(additionalRows, additionalBytes);
    });
  }

  enqueueEvent(event: TranscriptEvent): void {
    this.assertOpen();
    this.pending.enqueueEvent(eventMetadata(event));
    this.afterEnqueue();
  }

  enqueueSummaries(summaries: readonly SessionSummary[]): SessionSummary[] {
    this.assertOpen();
    const copies = this.pending.enqueueSummaries(summaries);
    if (copies.length > 0) this.afterEnqueue();
    return copies;
  }

  enqueueChild(child: PersistedChildSession): PersistedChildSession {
    this.assertOpen();
    const value = this.pending.enqueueChild(child);
    this.afterEnqueue();
    return value;
  }

  flushSync(): void {
    this.settleActiveDurabilityBarrierSync();
    this.durabilityBarrierPending = true;
    this.drainSync();
    this.runDurabilityBarrier();
  }

  async drain(): Promise<void> {
    this.assertOpen();
    this.clearFlushTimer();
    if (this.pending.rowCount > 0 || this.inFlight) this.clearRetryTimer();
    const targetSequence = this.pending.latestSequence;
    while (
      (this.inFlight?.minimumSequence ?? Number.POSITIVE_INFINITY) <= targetSequence ||
      this.pending.hasOutstandingThrough(targetSequence)
    ) {
      if (!this.inFlight) this.startNext();
      const current = this.inFlight;
      if (!current) throw this.lastFailure ?? new Error('History persistence did not start.');
      try {
        await current.settled;
      } catch {
        throw this.lastFailure ?? new Error('History persistence failed.');
      }
    }
  }

  drainSync(): void {
    this.assertOpen();
    this.clearTimers();
    while (!this.isDrained()) {
      if (!this.inFlight) this.startNext();
      const current = this.inFlight;
      if (!current) throw this.lastFailure ?? new Error('History persistence did not start.');
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

  warm(): void {
    const warm = this.ensureClient().warm?.();
    if (!warm) return;
    void warm.promise.catch((error: unknown) => {
      console.error(
        `History persistence warm failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  close(): void {
    if (this.closed) return;
    this.clearTimers();
    let firstError: Error | undefined;
    try {
      this.flushSync();
      this.dirtyMarker?.markClean();
    } catch (error) {
      firstError = asError(error);
    }
    try {
      this.client?.closeSync();
    } catch (error) {
      firstError ??= asError(error);
    }
    this.closed = true;
    this.clearTimers();
    if (firstError) throw firstError;
  }

  snapshot(): HistoryPersistenceQueueSnapshot {
    const inFlightEntries = this.inFlight ? persistenceRowCount(this.inFlight.batch) : 0;
    const inFlightEstimatedBytes = this.inFlight?.batch.estimatedBytes ?? 0;
    return {
      pendingEntries: this.pending.rowCount,
      pendingEstimatedBytes: this.pending.estimatedByteCount,
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
    this.dirtyMarker?.markDirty();
    this.notePeak();
    const thresholdReached =
      this.pending.rowCount >= MAX_PERSISTENCE_BATCH_ROWS ||
      this.pending.estimatedByteCount >= MAX_PERSISTENCE_BATCH_BYTES;
    if (thresholdReached && !this.retryTimer) {
      this.clearFlushTimer();
      this.startNext();
      return;
    }
    this.scheduleFlush();
  }

  private startNext(): void {
    if (this.inFlight || this.pending.rowCount === 0 || this.closed) return;
    const { batch, minimumSequence } = this.pending.takeBatch();
    let call: HistoryPersistenceCall<HistoryPersistenceResult>;
    try {
      call = this.ensureClient().startPersist(batch);
    } catch (error) {
      const resolved = asError(error);
      this.failures += 1;
      this.consecutiveFailures += 1;
      this.lastFailure = resolved;
      this.pending.restoreBatch(batch, minimumSequence);
      this.reportFailure(resolved);
      this.scheduleRetry();
      return;
    }
    const current: InFlightPersistenceBatch = {
      batch,
      call,
      settled: Promise.resolve(),
      minimumSequence,
    };
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

  private finishSuccess(current: InFlightPersistenceBatch, result: HistoryPersistenceResult): void {
    if (this.inFlight !== current) return;
    this.inFlight = null;
    this.lastFailure = null;
    this.consecutiveFailures = 0;
    if (!this.durabilityBarrierPending) this.reportRecovery();
    this.batchesCommitted += 1;
    this.rowsCommitted += persistenceRowCount(current.batch);
    try {
      this.onCommitted(current.batch, result);
    } catch (error) {
      // SQLite committed already, so retrying bookkeeping would duplicate work.
      console.error('History persistence commit bookkeeping failed:', error);
    }
    if (this.pending.rowCount > 0) this.startNext();
    else if (this.durabilityBarrierPending) this.startDurabilityBarrier();
    else this.dirtyMarker?.markClean();
  }

  private finishFailure(current: InFlightPersistenceBatch, error: Error): void {
    if (this.inFlight !== current) return;
    this.inFlight = null;
    this.failures += 1;
    this.consecutiveFailures += 1;
    this.lastFailure = error;
    this.pending.restoreBatch(current.batch, current.minimumSequence);
    this.reportFailure(error);
    this.scheduleRetry();
  }

  private assertCapacity(additionalRows: number, additionalBytes: number): void {
    const inFlightRows = this.inFlight ? persistenceRowCount(this.inFlight.batch) : 0;
    const rows = this.pending.rowCount + inFlightRows + additionalRows;
    const bytes =
      this.pending.estimatedByteCount +
      (this.inFlight?.batch.estimatedBytes ?? 0) +
      additionalBytes;
    if (rows > MAX_PERSISTENCE_QUEUE_ROWS || bytes > MAX_PERSISTENCE_QUEUE_BYTES) {
      throw new HistoryPersistenceBackpressureError(rows, bytes);
    }
  }

  private notePeak(): void {
    const inFlightRows = this.inFlight ? persistenceRowCount(this.inFlight.batch) : 0;
    this.peakEntries = Math.max(this.peakEntries, this.pending.rowCount + inFlightRows);
    this.peakEstimatedBytes = Math.max(
      this.peakEstimatedBytes,
      this.pending.estimatedByteCount + (this.inFlight?.batch.estimatedBytes ?? 0),
    );
  }

  private isDrained(): boolean {
    return this.pending.rowCount === 0 && this.inFlight === null;
  }

  private scheduleFlush(): void {
    if (this.flushTimer || this.retryTimer || this.inFlight || this.closed) return;
    this.flushTimer = this.schedule(() => {
      this.flushTimer = null;
      this.startNext();
    }, this.flushDelayMs);
  }

  private scheduleRetry(): void {
    if (this.retryTimer || this.closed) return;
    this.retryTimer = this.schedule(() => {
      this.retryTimer = null;
      this.retries += 1;
      if (this.pending.rowCount > 0 || this.inFlight) this.startNext();
      else if (this.durabilityBarrierPending) this.startDurabilityBarrier();
    }, this.nextRetryDelayMs());
  }

  private clearTimers(): void {
    this.clearFlushTimer();
    this.clearRetryTimer();
  }

  private clearFlushTimer(): void {
    if (!this.flushTimer) return;
    this.cancel(this.flushTimer);
    this.flushTimer = null;
  }

  private clearRetryTimer(): void {
    if (!this.retryTimer) return;
    this.cancel(this.retryTimer);
    this.retryTimer = null;
  }

  private runDurabilityBarrier(): void {
    const barrier = this.startDurabilityBarrier();
    if (!barrier) throw this.lastFailure ?? new Error('History durability barrier did not start.');
    try {
      barrier.waitSync(this.syncTimeoutMs);
      this.finishDurabilityBarrierSuccess(barrier);
    } catch (error) {
      const resolved = asError(error);
      this.finishDurabilityBarrierFailure(barrier, resolved);
      throw resolved;
    }
  }

  private startDurabilityBarrier(): HistoryPersistenceCall<{ durable: true }> | null {
    if (this.closed || !this.durabilityBarrierPending) return null;
    if (this.durabilityBarrierInFlight) return this.durabilityBarrierInFlight;
    let barrier: HistoryPersistenceCall<{ durable: true }>;
    try {
      barrier = this.ensureClient().startDurabilityBarrier();
    } catch (error) {
      this.recordDurabilityBarrierFailure(asError(error));
      return null;
    }
    this.durabilityBarrierInFlight = barrier;
    void barrier.promise.then(
      () => {
        this.finishDurabilityBarrierSuccess(barrier);
      },
      (error: unknown) => {
        this.finishDurabilityBarrierFailure(barrier, asError(error));
      },
    );
    return barrier;
  }

  private settleActiveDurabilityBarrierSync(): void {
    const barrier = this.durabilityBarrierInFlight;
    if (!barrier) return;
    try {
      barrier.waitSync(this.syncTimeoutMs);
      this.finishDurabilityBarrierSuccess(barrier);
    } catch (error) {
      this.finishDurabilityBarrierFailure(barrier, asError(error));
    }
  }

  private finishDurabilityBarrierSuccess(barrier: HistoryPersistenceCall<{ durable: true }>): void {
    if (this.durabilityBarrierInFlight !== barrier) return;
    this.durabilityBarrierInFlight = null;
    this.clearRetryTimer();
    this.lastFailure = null;
    this.consecutiveFailures = 0;
    this.durabilityBarrierPending = false;
    this.reportRecovery();
    if (this.isDrained()) this.dirtyMarker?.markClean();
  }

  private finishDurabilityBarrierFailure(
    barrier: HistoryPersistenceCall<{ durable: true }>,
    error: Error,
  ): void {
    if (this.durabilityBarrierInFlight !== barrier) return;
    this.durabilityBarrierInFlight = null;
    this.recordDurabilityBarrierFailure(error);
  }

  private recordDurabilityBarrierFailure(error: Error): void {
    this.failures += 1;
    this.consecutiveFailures += 1;
    this.lastFailure = error;
    this.durabilityBarrierPending = true;
    this.reportFailure(error);
    this.scheduleRetry();
  }

  private nextRetryDelayMs(): number {
    const exponent = Math.max(0, Math.min(this.consecutiveFailures - 1, 5));
    return Math.min(this.retryDelayMs * 2 ** exponent, MAX_RETRY_DELAY_MS);
  }

  private reportFailure(error: Error): void {
    if (this.degraded) return;
    this.degraded = true;
    try {
      this.onFailure(error);
    } catch (reportError) {
      console.error('History persistence failure reporting failed:', reportError);
    }
  }

  private reportRecovery(): void {
    if (!this.degraded) return;
    this.degraded = false;
    try {
      this.onRecovered();
    } catch (reportError) {
      console.error('History persistence recovery reporting failed:', reportError);
    }
  }

  private ensureClient(): HistoryPersistenceClient {
    if (!this.client) this.client = this.createDefaultClient();
    return this.client;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('History persistence queue is closed.');
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
