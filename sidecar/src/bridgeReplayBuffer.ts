import type { ServerEventBatch } from './protocol.js';

const DEFAULT_MAX_REPLAY_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_REPLAY_BATCHES = 4_096;
const COMPACT_AFTER_DROPPED_BATCHES = 1_024;

export interface SerializedEventBatch {
  firstSeq: number;
  lastSeq: number;
  eventCount: number;
  data: string;
  bytes: number;
}

/** Bounded same-process replay history for renderer reconnects. */
export class BridgeReplayBuffer {
  private entries: (SerializedEventBatch | undefined)[] = [];
  private head = 0;
  private totalBytes = 0;
  private lastSeenSeq = 0;

  constructor(
    private readonly maxBytes = DEFAULT_MAX_REPLAY_BYTES,
    private readonly maxBatches = DEFAULT_MAX_REPLAY_BATCHES,
  ) {
    if (maxBytes <= 0 || maxBatches <= 0) {
      throw new Error('Bridge replay limits must be positive.');
    }
  }

  push(batch: ServerEventBatch, data: string): SerializedEventBatch {
    if (batch.firstSeq !== this.lastSeenSeq + 1 || batch.lastSeq < batch.firstSeq) {
      throw new Error('Bridge replay batches must be appended in contiguous sequence order.');
    }
    const entry: SerializedEventBatch = {
      firstSeq: batch.firstSeq,
      lastSeq: batch.lastSeq,
      eventCount: batch.events.length,
      data,
      bytes: Buffer.byteLength(data),
    };
    this.entries.push(entry);
    this.totalBytes += entry.bytes;
    this.lastSeenSeq = entry.lastSeq;
    this.trim();
    return entry;
  }

  replayAfter(lastSeq: number): readonly SerializedEventBatch[] | null {
    if (lastSeq >= this.lastSeenSeq) return [];
    const oldest = this.entries[this.head];
    if (!oldest || lastSeq < oldest.firstSeq - 1) return null;

    const replay: SerializedEventBatch[] = [];
    for (let index = this.head; index < this.entries.length; index += 1) {
      const entry = this.entries[index];
      if (entry && entry.lastSeq > lastSeq) replay.push(entry);
    }
    return replay;
  }

  markHistoryUnavailable(): void {
    this.entries = [];
    this.head = 0;
    this.totalBytes = 0;
  }

  snapshot(): { batches: number; bytes: number; firstSeq: number; lastSeq: number } {
    return {
      batches: this.entries.length - this.head,
      bytes: this.totalBytes,
      firstSeq: this.entries[this.head]?.firstSeq ?? 0,
      lastSeq: this.lastSeenSeq,
    };
  }

  private trim(): void {
    while (this.entries.length - this.head > this.maxBatches || this.totalBytes > this.maxBytes) {
      const removed = this.entries[this.head];
      this.entries[this.head] = undefined;
      this.head += 1;
      if (removed) this.totalBytes -= removed.bytes;
    }
    if (this.head >= COMPACT_AFTER_DROPPED_BATCHES && this.head * 2 >= this.entries.length) {
      this.entries = this.entries.slice(this.head);
      this.head = 0;
    }
  }
}
