import { randomUUID } from 'node:crypto';

import type { SequencedServerEvent, ServerEvent, ServerEventBatch } from './protocol.js';

const DEFAULT_BATCH_WINDOW_MS = 16;
const DEFAULT_PRESSURED_BATCH_WINDOW_MS = 32;
const DEFAULT_MAX_PENDING_EVENTS = 512;
const DEFAULT_MAX_PENDING_ESTIMATED_BYTES = 512 * 1024;
const IMMEDIATE_EVENT_TYPES = new Set<ServerEvent['type']>([
  'connection',
  'runtime.updated',
  'session.created',
  'session.closed',
  'sessions.cwdReanchored',
  'session.markdownExported',
  'child.updated',
  'approval.requested',
  'question.requested',
  'child.error',
  'error',
  'session.history',
  'session.history.error',
  'sessions.list',
  'sessions.searchResults',
  'history.persistenceRecovered',
  'browser.native.request',
  'browser.closed',
  'browser.error',
  'mcp.authRequested',
  'mcp.error',
  'cli.install.done',
]);

interface PendingEvent extends SequencedServerEvent {
  estimatedBytes: number;
}

export interface BridgeEventBatchMetadata {
  logicalEvents: number;
  deliveredEvents: number;
  estimatedBytes: number;
  queueDelayMs: number;
  immediate: boolean;
}

export interface BridgeEventQueueSnapshot {
  generation: string;
  lastSeq: number;
  pendingLogicalEvents: number;
  pendingDeliveredEvents: number;
  pendingEstimatedBytes: number;
  oldestPendingAgeMs: number;
}

export interface BridgeEventBatcherOptions<Timer = ReturnType<typeof setTimeout>> {
  sendBatch: (batch: ServerEventBatch, metadata: BridgeEventBatchMetadata) => void;
  generation?: string;
  batchWindowMs?: number;
  pressuredBatchWindowMs?: number;
  maxPendingEvents?: number;
  maxPendingEstimatedBytes?: number;
  isUnderPressure?: () => boolean;
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => Timer;
  cancel?: (timer: Timer) => void;
  onQueueChanged?: (snapshot: BridgeEventQueueSnapshot) => void;
}

// Sequence numbers are assigned before coalescing. Gaps inside a batch are
// intentional: replaceable telemetry was collapsed onto a later seq.
export class BridgeEventBatcher<Timer = ReturnType<typeof setTimeout>> {
  readonly generation: string;

  private readonly sendBatch: BridgeEventBatcherOptions<Timer>['sendBatch'];
  private readonly batchWindowMs: number;
  private readonly pressuredBatchWindowMs: number;
  private readonly maxPendingEvents: number;
  private readonly maxPendingEstimatedBytes: number;
  private readonly isUnderPressure: () => boolean;
  private readonly now: () => number;
  private readonly schedule: (callback: () => void, delayMs: number) => Timer;
  private readonly cancel: (timer: Timer) => void;
  private readonly onQueueChanged: ((snapshot: BridgeEventQueueSnapshot) => void) | undefined;

  private nextSeq = 0;
  private pending: (PendingEvent | null)[] = [];
  private pendingLogicalEvents = 0;
  private pendingDeliveredEvents = 0;
  private pendingEstimatedBytes = 0;
  private firstPendingSeq = 0;
  private lastPendingSeq = 0;
  private firstQueuedAt = 0;
  private timer: Timer | null = null;
  private readonly replacementIndexes = new Map<string, number>();
  private isClosed = false;

  constructor(options: BridgeEventBatcherOptions<Timer>) {
    this.sendBatch = options.sendBatch;
    this.generation = options.generation ?? randomUUID();
    this.batchWindowMs = options.batchWindowMs ?? DEFAULT_BATCH_WINDOW_MS;
    this.pressuredBatchWindowMs =
      options.pressuredBatchWindowMs ?? DEFAULT_PRESSURED_BATCH_WINDOW_MS;
    this.maxPendingEvents = options.maxPendingEvents ?? DEFAULT_MAX_PENDING_EVENTS;
    this.maxPendingEstimatedBytes =
      options.maxPendingEstimatedBytes ?? DEFAULT_MAX_PENDING_ESTIMATED_BYTES;
    this.isUnderPressure = options.isUnderPressure ?? (() => false);
    this.now = options.now ?? performance.now.bind(performance);
    this.schedule =
      options.schedule ??
      ((callback, delayMs) => {
        const timer = setTimeout(callback, delayMs);
        timer.unref();
        return timer as Timer;
      });
    this.cancel =
      options.cancel ??
      ((timer) => {
        clearTimeout(timer as ReturnType<typeof setTimeout>);
      });
    this.onQueueChanged = options.onQueueChanged;
  }

  enqueue(event: ServerEvent): number {
    if (this.isClosed) throw new Error('Bridge event batcher is closed.');

    const seq = ++this.nextSeq;
    if (isImmediateEvent(event)) {
      this.flush();
      this.sendBatch(
        {
          type: 'events.batch',
          generation: this.generation,
          firstSeq: seq,
          lastSeq: seq,
          events: [{ seq, event }],
        },
        {
          logicalEvents: 1,
          deliveredEvents: 1,
          estimatedBytes: estimateEventBytes(event),
          queueDelayMs: 0,
          immediate: true,
        },
      );
      this.publishQueueState();
      return seq;
    }

    if (this.pendingLogicalEvents === 0) {
      this.firstPendingSeq = seq;
      this.firstQueuedAt = this.now();
    }
    this.lastPendingSeq = seq;
    this.pendingLogicalEvents += 1;

    const queued: PendingEvent = {
      seq,
      event,
      estimatedBytes: estimateEventBytes(event),
    };
    const replacementKey = telemetryReplacementKey(event);
    if (replacementKey !== null) this.replaceTelemetry(replacementKey, queued);
    else {
      this.replacementIndexes.clear();
      this.pending.push(queued);
      this.pendingDeliveredEvents += 1;
      this.pendingEstimatedBytes += queued.estimatedBytes;
    }

    if (
      this.pendingLogicalEvents >= this.maxPendingEvents ||
      this.pendingEstimatedBytes >= this.maxPendingEstimatedBytes
    ) {
      this.flush();
      return seq;
    }

    this.ensureTimer();
    this.publishQueueState();
    return seq;
  }

  flush(): void {
    this.clearTimer();
    if (this.pendingLogicalEvents === 0) {
      this.publishQueueState();
      return;
    }

    const events: SequencedServerEvent[] = [];
    for (const queued of this.pending) {
      if (queued !== null) events.push({ seq: queued.seq, event: queued.event });
    }
    const queuedAt = this.firstQueuedAt;
    const logicalEvents = this.pendingLogicalEvents;
    const estimatedBytes = this.pendingEstimatedBytes;
    const batch: ServerEventBatch = {
      type: 'events.batch',
      generation: this.generation,
      firstSeq: this.firstPendingSeq,
      lastSeq: this.lastPendingSeq,
      events,
    };

    // Publish the final non-zero queue age before clearing the queue so the
    // high-water gauge reflects the full dwell time rather than only enqueue
    // instants. The transport batch histogram records the same duration.
    this.publishQueueState();
    this.resetPending();
    this.sendBatch(batch, {
      logicalEvents,
      deliveredEvents: events.length,
      estimatedBytes,
      queueDelayMs: Math.max(0, this.now() - queuedAt),
      immediate: false,
    });
    this.publishQueueState();
  }

  close(): void {
    if (this.isClosed) return;
    this.flush();
    this.isClosed = true;
  }

  snapshot(): BridgeEventQueueSnapshot {
    return {
      generation: this.generation,
      lastSeq: this.nextSeq,
      pendingLogicalEvents: this.pendingLogicalEvents,
      pendingDeliveredEvents: this.pendingDeliveredEvents,
      pendingEstimatedBytes: this.pendingEstimatedBytes,
      oldestPendingAgeMs:
        this.pendingLogicalEvents === 0 ? 0 : Math.max(0, this.now() - this.firstQueuedAt),
    };
  }

  private replaceTelemetry(key: string, queued: PendingEvent): void {
    const previousIndex = this.replacementIndexes.get(key);
    if (previousIndex !== undefined) {
      const previous = this.pending[previousIndex];
      if (previous) {
        this.pendingEstimatedBytes -= previous.estimatedBytes;
        this.pendingDeliveredEvents -= 1;
        this.pending[previousIndex] = null;
      }
    }
    this.replacementIndexes.set(key, this.pending.length);
    this.pending.push(queued);
    this.pendingDeliveredEvents += 1;
    this.pendingEstimatedBytes += queued.estimatedBytes;
  }

  private ensureTimer(): void {
    if (this.timer !== null) return;
    const delayMs = this.isUnderPressure() ? this.pressuredBatchWindowMs : this.batchWindowMs;
    this.timer = this.schedule(() => {
      this.timer = null;
      this.flush();
    }, delayMs);
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    this.cancel(this.timer);
    this.timer = null;
  }

  private resetPending(): void {
    this.pending = [];
    this.pendingLogicalEvents = 0;
    this.pendingDeliveredEvents = 0;
    this.pendingEstimatedBytes = 0;
    this.firstPendingSeq = 0;
    this.lastPendingSeq = 0;
    this.firstQueuedAt = 0;
    this.replacementIndexes.clear();
  }

  private publishQueueState(): void {
    this.onQueueChanged?.(this.snapshot());
  }
}

function telemetryReplacementKey(event: ServerEvent): string | null {
  if (event.type === 'session.updated') return `session:${event.session.appSessionId}`;
  if (event.type === 'context.updated') {
    return `context:${JSON.stringify([
      event.appSessionId,
      event.sourceSessionId,
      event.childSessionId ?? null,
    ])}`;
  }
  return null;
}

function isImmediateEvent(event: ServerEvent): boolean {
  if (IMMEDIATE_EVENT_TYPES.has(event.type)) return true;
  if (event.type !== 'session.updated') return false;
  return (
    event.session.streaming === false ||
    event.session.phase === 'paused' ||
    event.session.phase === 'completed' ||
    event.session.phase === 'failed'
  );
}

function estimateEventBytes(event: ServerEvent): number {
  // Include the complete event rather than sampling known text fields. The
  // small fixed allowance covers the sequenced entry wrapper and batch JSON.
  return Buffer.byteLength(JSON.stringify(event), 'utf8') + 48;
}
