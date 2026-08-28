// Exact-percentile latency histogram over a bounded reservoir of recent
// samples. Hot-path stages record microsecond-scale durations at high
// frequency, so the reservoir keeps memory flat for long-running sessions
// while `stats()` stays cheap enough to serve from an HTTP endpoint.

export interface HistogramStats {
  count: number;
  meanMs?: number;
  p50Ms?: number;
  p95Ms?: number;
  p99Ms?: number;
  maxMs?: number;
}

const CAPACITY = 8_192;

export class ReservoirHistogram {
  private samples = new Float64Array(CAPACITY);
  private next = 0;
  private filled = false;

  add(durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    this.samples[this.next] = durationMs;
    this.next += 1;
    if (this.next === CAPACITY) {
      this.next = 0;
      this.filled = true;
    }
  }

  stats(): HistogramStats {
    const count = this.filled ? CAPACITY : this.next;
    if (count === 0) return { count: 0 };
    const window = this.filled ? this.samples : this.samples.subarray(0, count);
    const sorted = Float64Array.from(window).sort();
    let total = 0;
    for (const value of sorted) total += value;
    return {
      count,
      meanMs: roundMicros(total / count),
      p50Ms: roundMicros(percentile(sorted, 0.5)),
      p95Ms: roundMicros(percentile(sorted, 0.95)),
      p99Ms: roundMicros(percentile(sorted, 0.99)),
      maxMs: roundMicros(percentile(sorted, 1)),
    };
  }

  reset(): void {
    this.next = 0;
    this.filled = false;
  }
}

function percentile(sorted: Float64Array, quantile: number): number {
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(quantile * sorted.length) - 1));
  // stats() never asks for a percentile of an empty snapshot; the fallback
  // keeps the return honest without an assertion.
  return sorted.at(index) ?? 0;
}

function roundMicros(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}
