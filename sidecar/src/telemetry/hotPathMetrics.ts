// Sidecar hot-path measurement for perf phase 0 (#116): answers where the
// event pipeline spends time between a provider event and the wire.
//
// Stage ownership (all cheap enough to stay always-on):
//   normalize  SessionEventFlow around normalizeStreamEvent/normalizeNotification
//   persist    HistoryIndex.recordEvent around the SQLite insert
//   emit       SessionTimeline.recordAndEmit around the emit dispatch alone
//   transport  bridgeServer broadcast (serialize + fan-out)
//   coalesce   SessionTimeline streaming flush (deltas merged per flush)
// Plus process health: event-loop delay, CPU, memory, live session and child
// agent counts (sourced from the composition root), and transport byte rates.

import { monitorEventLoopDelay } from 'node:perf_hooks';
import { ReservoirHistogram, type HistogramStats } from './histogram.js';

export interface HotPathResourceCounts {
  livePrimarySessions: number;
  childAgentsTotal: number;
  childAgentsActive: number;
}

export type HotPathGaugeProvider = () => HotPathResourceCounts;

export interface HotPathMetricsSnapshot {
  pid: number;
  startedAt: number;
  uptimeMs: number;
  counters: {
    normalized: number;
    persisted: number;
    emitted: number;
    transportSends: number;
    coalesceFlushes: number;
  };
  histograms: {
    normalizeMs: HistogramStats;
    persistMs: HistogramStats;
    emitMs: HistogramStats;
    transportMs: HistogramStats;
    coalesceMerged: HistogramStats;
  };
  transport: {
    bytesTotal: number;
    bytesPerSecondAvg: number;
    bytesPerSecondRecent: number;
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

export class HotPathMetrics {
  private readonly normalize = new ReservoirHistogram();
  private readonly persist = new ReservoirHistogram();
  private readonly emit = new ReservoirHistogram();
  private readonly transport = new ReservoirHistogram();
  private readonly coalesce = new ReservoirHistogram();
  private readonly byteSampleAt = new Float64Array(MAX_BYTE_SAMPLES);
  private readonly byteSampleBytes = new Float64Array(MAX_BYTE_SAMPLES);
  private byteSampleCursor = 0;
  private byteSampleCount = 0;
  private readonly eventLoop = monitorEventLoopDelay({ resolution: 10 });
  private startedAt = 0;
  private cpuBaseline = { user: 0, system: 0 };
  private counters = {
    normalized: 0,
    persisted: 0,
    emitted: 0,
    transportSends: 0,
    coalesceFlushes: 0,
  };
  private bytesTotal = 0;
  private gaugeProvider: HotPathGaugeProvider | null = null;

  enable(): void {
    if (this.startedAt !== 0) return;
    this.startedAt = Date.now();
    this.cpuBaseline = process.cpuUsage();
    this.eventLoop.reset();
    this.eventLoop.enable();
  }

  disable(): void {
    this.eventLoop.disable();
  }

  reset(): void {
    this.disable();
    this.normalize.reset();
    this.persist.reset();
    this.emit.reset();
    this.transport.reset();
    this.coalesce.reset();
    this.byteSampleCursor = 0;
    this.byteSampleCount = 0;
    this.counters = {
      normalized: 0,
      persisted: 0,
      emitted: 0,
      transportSends: 0,
      coalesceFlushes: 0,
    };
    this.bytesTotal = 0;
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

  recordPersist(durationMs: number): void {
    this.counters.persisted += 1;
    this.persist.add(durationMs);
  }

  recordEmit(durationMs: number): void {
    this.counters.emitted += 1;
    this.emit.add(durationMs);
  }

  recordTransport(durationMs: number, bytes: number, clients: number): void {
    this.counters.transportSends += 1;
    this.transport.add(durationMs);
    if (clients > 0 && bytes > 0) {
      // Ring buffer, not a shifted array: this fires on every broadcast, so
      // recording must stay O(1) instead of adding its own transport jitter.
      const sent = bytes * clients;
      this.bytesTotal += sent;
      this.byteSampleAt[this.byteSampleCursor] = performance.now();
      this.byteSampleBytes[this.byteSampleCursor] = sent;
      this.byteSampleCursor = (this.byteSampleCursor + 1) % MAX_BYTE_SAMPLES;
      this.byteSampleCount = Math.min(this.byteSampleCount + 1, MAX_BYTE_SAMPLES);
    }
  }

  recordCoalesce(mergedCount: number): void {
    this.counters.coalesceFlushes += 1;
    this.coalesce.add(mergedCount);
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
        persistMs: this.persist.stats(),
        emitMs: this.emit.stats(),
        transportMs: this.transport.stats(),
        coalesceMerged: this.coalesce.stats(),
      },
      transport: {
        bytesTotal: this.bytesTotal,
        bytesPerSecondAvg: round(this.bytesTotal / (Math.max(1, uptimeMs) / 1_000)),
        bytesPerSecondRecent: round(this.recentBytesPerSecond(now)),
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
      const at = this.byteSampleAt[index];
      if (at < cutoff) continue;
      bytes += this.byteSampleBytes[index];
      oldest = Math.min(oldest, at);
    }
    const windowMs = Math.max(1, now - oldest);
    return bytes / (windowMs / 1_000);
  }

  private eventLoopStats(): HotPathMetricsSnapshot['eventLoop'] {
    if (this.startedAt === 0) return null;
    return {
      p50Ms: round(this.eventLoop.percentile(50) / 1e6),
      p95Ms: round(this.eventLoop.percentile(95) / 1e6),
      p99Ms: round(this.eventLoop.percentile(99) / 1e6),
      meanMs: round(this.eventLoop.mean / 1e6),
      maxMs: round(this.eventLoop.max / 1e6),
    };
  }

  private safeResourceCounts(): HotPathResourceCounts | null {
    if (!this.gaugeProvider) return null;
    try {
      return this.gaugeProvider();
    } catch {
      // Gauges are diagnostic; a failing provider must never break the
      // pipeline it measures. The composition root owns the real counts.
      return null;
    }
  }
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

export const hotPathMetrics = new HotPathMetrics();
