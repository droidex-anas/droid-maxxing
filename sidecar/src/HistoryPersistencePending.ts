import type { PersistedChildSession } from './history.js';
import {
  emptyPersistenceBatch,
  type HistoryPersistenceBatch,
  type PersistedEventMetadata,
} from './historyPersistenceProtocol.js';
import {
  copyPersistenceChild,
  copyPersistenceSummary,
  estimatePersistenceValueBytes,
  MAX_PERSISTENCE_BATCH_BYTES,
  MAX_PERSISTENCE_BATCH_ROWS,
  persistenceChildKey,
} from './historyPersistenceQueueValues.js';
import type { SessionSummary } from './protocol.js';

interface PendingValue<T> {
  value: T;
  estimatedBytes: number;
  sequence: number;
}

export interface TakenPersistenceBatch {
  batch: HistoryPersistenceBatch;
  minimumSequence: number;
}

export class HistoryPersistencePending {
  private events: PendingValue<PersistedEventMetadata>[] = [];
  private eventHead = 0;
  private readonly summaries = new Map<string, PendingValue<SessionSummary>>();
  private readonly children = new Map<string, PendingValue<PersistedChildSession>>();
  private estimatedBytes = 0;
  private nextSequence = 1;

  constructor(private readonly assertCapacity: (additionalRows: number, bytes: number) => void) {}

  get rowCount(): number {
    return this.events.length - this.eventHead + this.summaries.size + this.children.size;
  }

  get estimatedByteCount(): number {
    return this.estimatedBytes;
  }

  get latestSequence(): number {
    return this.nextSequence - 1;
  }

  enqueueEvent(value: PersistedEventMetadata): void {
    const estimatedBytes = estimateValueBytes(value);
    this.assertCapacity(1, estimatedBytes);
    this.events.push({ value, estimatedBytes, sequence: this.nextSequence++ });
    this.estimatedBytes += estimatedBytes;
  }

  enqueueSummaries(summaries: readonly SessionSummary[]): SessionSummary[] {
    const staged = new Map<string, PendingValue<SessionSummary>>();
    for (const summary of summaries) {
      const value = copyPersistenceSummary(summary);
      const previous = staged.get(value.appSessionId) ?? this.summaries.get(value.appSessionId);
      staged.set(value.appSessionId, {
        value,
        estimatedBytes: estimateValueBytes(value),
        sequence: previous?.sequence ?? this.nextSequence++,
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
    return [...staged.values()].map((pending) => pending.value);
  }

  enqueueChild(child: PersistedChildSession): PersistedChildSession {
    const value = copyPersistenceChild(child);
    const key = persistenceChildKey(value.parentAppSessionId, value.childSessionId);
    const estimatedBytes = estimateValueBytes(value);
    const previous = this.children.get(key);
    this.assertCapacity(previous ? 0 : 1, estimatedBytes - (previous?.estimatedBytes ?? 0));
    this.children.set(key, {
      value,
      estimatedBytes,
      sequence: previous?.sequence ?? this.nextSequence++,
    });
    this.estimatedBytes += estimatedBytes - (previous?.estimatedBytes ?? 0);
    return value;
  }

  takeBatch(): TakenPersistenceBatch {
    const batch = emptyPersistenceBatch();
    let rows = 0;
    let bytes = 0;
    let minimumSequence = Number.POSITIVE_INFINITY;
    const latestRows = this.summaries.size + this.children.size;
    const firstEventLimit = Math.max(1, MAX_PERSISTENCE_BATCH_ROWS - Math.min(128, latestRows));

    ({ rows, bytes, minimumSequence } = this.takeEvents(
      batch,
      rows,
      bytes,
      minimumSequence,
      firstEventLimit,
    ));
    ({ rows, bytes, minimumSequence } = this.takeLatest(
      this.summaries,
      batch.summaries,
      rows,
      bytes,
      minimumSequence,
    ));
    ({ rows, bytes, minimumSequence } = this.takeLatest(
      this.children,
      batch.children,
      rows,
      bytes,
      minimumSequence,
    ));
    ({ rows, bytes, minimumSequence } = this.takeEvents(
      batch,
      rows,
      bytes,
      minimumSequence,
      MAX_PERSISTENCE_BATCH_ROWS,
    ));
    batch.estimatedBytes = bytes;
    if (rows === 0) throw new Error('Cannot create an empty history persistence batch.');
    return { batch, minimumSequence };
  }

  restoreBatch(batch: HistoryPersistenceBatch, minimumSequence: number): void {
    if (batch.events.length > 0) {
      const restored = batch.events.map((value) => ({
        value,
        estimatedBytes: estimateValueBytes(value),
        sequence: minimumSequence,
      }));
      this.events = restored.concat(this.events.slice(this.eventHead));
      this.eventHead = 0;
      for (const event of restored) this.estimatedBytes += event.estimatedBytes;
    }
    for (const value of batch.summaries) {
      const existing = this.summaries.get(value.appSessionId);
      if (existing) {
        existing.sequence = Math.min(existing.sequence, minimumSequence);
        continue;
      }
      const estimatedBytes = estimateValueBytes(value);
      this.summaries.set(value.appSessionId, { value, estimatedBytes, sequence: minimumSequence });
      this.estimatedBytes += estimatedBytes;
    }
    for (const value of batch.children) {
      const key = persistenceChildKey(value.parentAppSessionId, value.childSessionId);
      const existing = this.children.get(key);
      if (existing) {
        existing.sequence = Math.min(existing.sequence, minimumSequence);
        continue;
      }
      const estimatedBytes = estimateValueBytes(value);
      this.children.set(key, { value, estimatedBytes, sequence: minimumSequence });
      this.estimatedBytes += estimatedBytes;
    }
  }

  hasOutstandingThrough(targetSequence: number): boolean {
    for (let index = this.eventHead; index < this.events.length; index += 1) {
      const pending = this.events.at(index);
      if (pending && pending.sequence <= targetSequence) return true;
    }
    for (const pending of this.summaries.values()) {
      if (pending.sequence <= targetSequence) return true;
    }
    for (const pending of this.children.values()) {
      if (pending.sequence <= targetSequence) return true;
    }
    return false;
  }

  private takeEvents(
    batch: HistoryPersistenceBatch,
    initialRows: number,
    initialBytes: number,
    initialMinimumSequence: number,
    rowLimit: number,
  ): { rows: number; bytes: number; minimumSequence: number } {
    let rows = initialRows;
    let bytes = initialBytes;
    let minimumSequence = initialMinimumSequence;
    while (
      this.eventHead < this.events.length &&
      rows < rowLimit &&
      rows < MAX_PERSISTENCE_BATCH_ROWS
    ) {
      const pending = this.events.at(this.eventHead);
      if (!pending) break;
      if (rows > 0 && bytes + pending.estimatedBytes > MAX_PERSISTENCE_BATCH_BYTES) break;
      batch.events.push(pending.value);
      this.eventHead += 1;
      rows += 1;
      bytes += pending.estimatedBytes;
      minimumSequence = Math.min(minimumSequence, pending.sequence);
      this.estimatedBytes -= pending.estimatedBytes;
    }
    this.compactEvents();
    return { rows, bytes, minimumSequence };
  }

  private takeLatest<T>(
    source: Map<string, PendingValue<T>>,
    target: T[],
    initialRows: number,
    initialBytes: number,
    initialMinimumSequence: number,
  ): { rows: number; bytes: number; minimumSequence: number } {
    let rows = initialRows;
    let bytes = initialBytes;
    let minimumSequence = initialMinimumSequence;
    for (const [key, pending] of source) {
      if (rows >= MAX_PERSISTENCE_BATCH_ROWS) break;
      if (rows > 0 && bytes + pending.estimatedBytes > MAX_PERSISTENCE_BATCH_BYTES) break;
      source.delete(key);
      target.push(pending.value);
      rows += 1;
      bytes += pending.estimatedBytes;
      minimumSequence = Math.min(minimumSequence, pending.sequence);
      this.estimatedBytes -= pending.estimatedBytes;
    }
    return { rows, bytes, minimumSequence };
  }

  private compactEvents(): void {
    if (this.eventHead === this.events.length) {
      this.events = [];
      this.eventHead = 0;
    } else if (this.eventHead > 1_024 && this.eventHead * 2 > this.events.length) {
      this.events = this.events.slice(this.eventHead);
      this.eventHead = 0;
    }
  }
}

function estimateValueBytes(value: unknown): number {
  return estimatePersistenceValueBytes(value, MAX_PERSISTENCE_BATCH_BYTES + 1);
}
