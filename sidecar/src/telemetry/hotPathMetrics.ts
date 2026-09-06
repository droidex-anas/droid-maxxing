import { monitorEventLoopDelay } from 'node:perf_hooks';

import { ReservoirHistogram, type HistogramStats } from './histogram.js';

export interface HotPathResourceCounts {
  livePrimarySessions: number;
  childAgentsTotal: number;
  childAgentsActive: number;
  childAgentsLive: number;
  childAgentsQueued: number;
  contextPollers: number;
  contextPollersActive: number;
  autoCompactionWatchdogs: number;
  sessionFileWatchers: number;
}

export type HotPathGaugeProvider = () => HotPathResourceCounts;

export interface TransportQueueSample {
  pendingEvents: number;
  pendingEstimatedBytes: number;
  oldestPendingAgeMs: number;
}

export interface TransportBatchSample {
  logicalEvents: number;
  deliveredEvents: number;
  bytes: number;
  queueDelayMs: number;
  immediate: boolean;
}

export interface HotPathMetricsSnapshot {
  pid: number;
  startedAt: number;
  uptimeMs: number;
  counters: {
    normalized: number;
    persisted: number;
    persistenceFailures: number;
    persistenceRecoveries: number;
    emitted: number;
    transportSends: number;
    coalesceFlushes: number;
    transportBatches: number;
    transportLogicalEvents: number;
    transportDeliveredEvents: number;
    transportImmediateBatches: number;
    transportReplayedBatches: number;
    transportReplayedEvents: number;
    transportBackpressureDisconnects: number;
  };
  histograms: {
    normalizeMs: HistogramStats;
    persistenceStartupMs: HistogramStats;
    persistMs: HistogramStats;
    persistenceBoundaryMs: HistogramStats;
    emitMs: HistogramStats;
    transportMs: HistogramStats;
    coalesceMerged: HistogramStats;
    transportBatchEvents: HistogramStats;
    transportBatchBytes: HistogramStats;
    transportQueueDelayMs: HistogramStats;
  };
  transport: {
    bytesTotal: number;
    bytesPerSecondAvg: number;
    bytesPerSecondRecent: number;
    eventReductionRatio: number;
    clientBufferedBytesMax: number;
    replayBytesTotal: number;
    queue: {
      pendingEvents: number;
      pendingEstimatedBytes: number;
      oldestPendingAgeMs: number;
      pendingEventsMax: number;
      pendingEstimatedBytesMax: number;
      oldestPendingAgeMsMax: number;
    };
    replayBuffer: {
      batches: number;
      bytes: number;
      batchesMax: number;
      bytesMax: number;
    };
  };
  eventLoop: {
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
    meanMs: number;
    maxMs: number;
  } | null;
  resources: HotPathResourceCounts | null;
  process: {
    rssBytes: number;
    heapUsedBytes: number;
    heapTotalBytes: number;
    cpuUserMs: number;
    cpuSystemMs: number;
  };
}

const RECENT_WINDOW_MS = 5_000;
const MAX_BYTE_SAMPLES = 10_000;

function emptyCounters(): HotPathMetricsSnapshot['counters'] {
  return {
    normalized: 0,
    persisted: 0,
    persistenceFailures: 0,
    persistenceRecoveries: 0,
    emitted: 0,
    transportSends: 0,
    coalesceFlushes: 0,
    transportBatches: 0,
    transportLogicalEvents: 0,
    transportDeliveredEvents: 0,
    transportImmediateBatches: 0,
    transportReplayedBatches: 0,
    transportReplayedEvents: 0,
    transportBackpressureDisconnects: 0,
  };
}

function emptyQueue(): HotPathMetricsSnapshot['transport']['queue'] {
  return {
    pendingEvents: 0,
    pendingEstimatedBytes: 0,
    oldestPendingAgeMs: 0,
    pendingEventsMax: 0,
    pendingEstimatedBytesMax: 0,
    oldestPendingAgeMsMax: 0,
  };
}

function emptyReplayBuffer(): HotPathMetricsSnapshot['transport']['replayBuffer'] {
  return { batches: 0, bytes: 0, batchesMax: 0, bytesMax: 0 };
}

export class HotPathMetrics {
  private readonly normalize = new ReservoirHistogram();
  private readonly persistenceStartup = new ReservoirHistogram();
  private readonly persist = new ReservoirHistogram();
  private readonly persistenceBoundary = new ReservoirHistogram();
  private readonly emit = new ReservoirHistogram();
  private readonly transport = new ReservoirHistogram();
  private readonly coalesce = new ReservoirHistogram();
  private readonly transportBatchEvents = new ReservoirHistogram();
  private readonly transportBatchBytes = new ReservoirHistogram();
  private readonly transportQueueDelay = new ReservoirHistogram();
  private readonly byteSampleAt = new Float64Array(MAX_BYTE_SAMPLES);
  private readonly byteSampleBytes = new Float64Array(MAX_BYTE_SAMPLES);
  private byteSampleCursor = 0;
  private byteSampleCount = 0;
  private readonly eventLoop = monitorEventLoopDelay({ resolution: 10 });
  private eventLoopEnabled = false;
  private startedAt = 0;
  private cpuBaseline = { user: 0, system: 0 };
  private counters = emptyCounters();
  private bytesTotal = 0;
  private replayBytesTotal = 0;
  private clientBufferedBytesMax = 0;
  private queue = emptyQueue();
  private replayBuffer = emptyReplayBuffer();
  private gaugeProvider: HotPathGaugeProvider | null = null;

  enable(): void {
    if (this.startedAt !== 0) return;
    this.startedAt = Date.now();
    this.cpuBaseline = process.cpuUsage();
  }

  /** Arm the 10 ms event-loop histogram. Production `enable()` leaves it off. */
  enableEventLoop(): void {
    if (this.startedAt === 0) this.enable();
    if (this.eventLoopEnabled) return;
    this.eventLoop.reset();
    this.eventLoop.enable();
    this.eventLoopEnabled = true;
  }

  disable(): void {
    if (!this.eventLoopEnabled) return;
    this.eventLoop.disable();
    this.eventLoopEnabled = false;
  }

  reset(): void {
    this.disable();
    this.normalize.reset();
    this.persistenceStartup.reset();
    this.persist.reset();
    this.persistenceBoundary.reset();
    this.emit.reset();
    this.transport.reset();
    this.coalesce.reset();
    this.transportBatchEvents.reset();
    this.transportBatchBytes.reset();
    this.transportQueueDelay.reset();
    this.byteSampleCursor = 0;
    this.byteSampleCount = 0;
    this.counters = emptyCounters();
    this.bytesTotal = 0;
    this.replayBytesTotal = 0;
    this.clientBufferedBytesMax = 0;
    this.queue = emptyQueue();
    this.replayBuffer = emptyReplayBuffer();
    this.startedAt = 0;
  }

  setGaugeProvider(provider: HotPathGaugeProvider): void {
    this.gaugeProvider = provider;
  }

  clearGaugeProvider(): void {
    this.gaugeProvider = null;
  }

  recordNormalize(durationMs: number): void {
    this.counters.normalized += 1;
    this.normalize.add(durationMs);
  }

  recordPersist(durationMs: number, rows = 1): void {
    this.counters.persisted += rows;
    this.persist.add(durationMs);
  }

  recordPersistenceStartup(durationMs: number): void {
    this.persistenceStartup.add(durationMs);
  }

  recordPersistenceBoundary(durationMs: number): void {
    this.persistenceBoundary.add(durationMs);
  }

  recordPersistenceFailure(): void {
    this.counters.persistenceFailures += 1;
  }

  recordPersistenceRecovery(): void {
    this.counters.persistenceRecoveries += 1;
  }

  recordEmit(durationMs: number): void {
    this.counters.emitted += 1;
    this.emit.add(durationMs);
  }

  recordTransport(durationMs: number, bytesTotal: number, sendOperations: number): void {
    this.counters.transportSends += Math.max(0, sendOperations);
    this.transport.add(durationMs);
    if (bytesTotal > 0) {
      this.bytesTotal += bytesTotal;
      this.byteSampleAt[this.byteSampleCursor] = performance.now();
      this.byteSampleBytes[this.byteSampleCursor] = bytesTotal;
      this.byteSampleCursor = (this.byteSampleCursor + 1) % MAX_BYTE_SAMPLES;
      this.byteSampleCount = Math.min(this.byteSampleCount + 1, MAX_BYTE_SAMPLES);
    }
  }

  recordCoalesce(mergedCount: number): void {
    this.counters.coalesceFlushes += 1;
    this.coalesce.add(mergedCount);
  }

  recordTransportBatch(sample: TransportBatchSample): void {
    this.counters.transportBatches += 1;
    this.counters.transportLogicalEvents += sample.logicalEvents;
    this.counters.transportDeliveredEvents += sample.deliveredEvents;
    if (sample.immediate) this.counters.transportImmediateBatches += 1;
    this.transportBatchEvents.add(sample.deliveredEvents);
    this.transportBatchBytes.add(sample.bytes);
    this.transportQueueDelay.add(sample.queueDelayMs);
  }

  recordTransportQueue(sample: TransportQueueSample): void {
    this.queue.pendingEvents = sample.pendingEvents;
    this.queue.pendingEstimatedBytes = sample.pendingEstimatedBytes;
    this.queue.oldestPendingAgeMs = sample.oldestPendingAgeMs;
    this.queue.pendingEventsMax = Math.max(this.queue.pendingEventsMax, sample.pendingEvents);
    this.queue.pendingEstimatedBytesMax = Math.max(
      this.queue.pendingEstimatedBytesMax,
      sample.pendingEstimatedBytes,
    );
    this.queue.oldestPendingAgeMsMax = Math.max(
      this.queue.oldestPendingAgeMsMax,
      sample.oldestPendingAgeMs,
    );
  }

  recordClientBufferedAmount(bytes: number): void {
    this.clientBufferedBytesMax = Math.max(this.clientBufferedBytesMax, bytes);
  }

  recordBackpressureDisconnect(bufferedBytes: number): void {
    this.counters.transportBackpressureDisconnects += 1;
    this.recordClientBufferedAmount(bufferedBytes);
  }

  recordReplay(batchCount: number, eventCount: number, bytes: number): void {
    this.counters.transportReplayedBatches += batchCount;
    this.counters.transportReplayedEvents += eventCount;
    this.replayBytesTotal += bytes;
  }

  recordReplayBuffer(batches: number, bytes: number): void {
    this.replayBuffer.batches = batches;
    this.replayBuffer.bytes = bytes;
    this.replayBuffer.batchesMax = Math.max(this.replayBuffer.batchesMax, batches);
    this.replayBuffer.bytesMax = Math.max(this.replayBuffer.bytesMax, bytes);
  }

  snapshot(): HotPathMetricsSnapshot {
    const now = performance.now();
    const uptimeMs = this.startedAt === 0 ? 0 : Date.now() - this.startedAt;
    const memory = process.memoryUsage();
    const cpu = process.cpuUsage(this.cpuBaseline);
    return {
      pid: process.pid,
      startedAt: this.startedAt,
      uptimeMs,
      counters: { ...this.counters },
      histograms: {
        normalizeMs: this.normalize.stats(),
        persistenceStartupMs: this.persistenceStartup.stats(),
        persistMs: this.persist.stats(),
        persistenceBoundaryMs: this.persistenceBoundary.stats(),
        emitMs: this.emit.stats(),
        transportMs: this.transport.stats(),
        coalesceMerged: this.coalesce.stats(),
        transportBatchEvents: this.transportBatchEvents.stats(),
        transportBatchBytes: this.transportBatchBytes.stats(),
        transportQueueDelayMs: this.transportQueueDelay.stats(),
      },
      transport: {
        bytesTotal: this.bytesTotal,
        bytesPerSecondAvg: round(this.bytesTotal / (Math.max(1, uptimeMs) / 1_000)),
        bytesPerSecondRecent: round(this.recentBytesPerSecond(now)),
        eventReductionRatio: reductionRatio(
          this.counters.transportLogicalEvents,
          this.counters.transportDeliveredEvents,
        ),
        clientBufferedBytesMax: this.clientBufferedBytesMax,
        replayBytesTotal: this.replayBytesTotal,
        queue: { ...this.queue },
        replayBuffer: { ...this.replayBuffer },
      },
      eventLoop: this.eventLoopStats(),
      resources: this.safeResourceCounts(),
      process: {
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        heapTotalBytes: memory.heapTotal,
        cpuUserMs: round(cpu.user / 1_000),
        cpuSystemMs: round(cpu.system / 1_000),
      },
    };
  }

  private recentBytesPerSecond(now: number): number {
    const cutoff = now - RECENT_WINDOW_MS;
    let bytes = 0;
    let oldest = now;
    for (let index = 0; index < this.byteSampleCount; index += 1) {
      const at = this.byteSampleAt[index] ?? 0;
      if (at < cutoff) continue;
      bytes += this.byteSampleBytes[index] ?? 0;
      oldest = Math.min(oldest, at);
    }
    const windowMs = Math.max(1, now - oldest);
    return bytes / (windowMs / 1_000);
  }

  private eventLoopStats(): HotPathMetricsSnapshot['eventLoop'] {
    if (!this.eventLoopEnabled) return null;
    return {
      p50Ms: nanosToMs(this.eventLoop.percentile(50)),
      p95Ms: nanosToMs(this.eventLoop.percentile(95)),
      p99Ms: nanosToMs(this.eventLoop.percentile(99)),
      meanMs: nanosToMs(this.eventLoop.mean),
      maxMs: nanosToMs(this.eventLoop.max),
    };
  }

  private safeResourceCounts(): HotPathResourceCounts | null {
    if (!this.gaugeProvider) return null;
    try {
      return this.gaugeProvider();
    } catch {
      return null;
    }
  }
}

function reductionRatio(logicalEvents: number, deliveredEvents: number): number {
  if (logicalEvents <= 0) return 0;
  return round(Math.max(0, logicalEvents - deliveredEvents) / logicalEvents);
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function nanosToMs(value: number): number {
  return Number.isFinite(value) ? round(value / 1e6) : 0;
}

export const hotPathMetrics = new HotPathMetrics();
