/**
 * Canonical absolute monotonic shutdown deadline for the provider layer.
 *
 * Create once at the first shutdown trigger and pass the same instance
 * through every step. Callers must not substitute a fresh relative timeout.
 * `nowMonotonicMs` uses `performance.now()` unless a test injects a clock.
 */
export class ShutdownDeadline {
  private constructor(private readonly expiresAtMonotonicMs: number) {}

  static fromDurationMs(
    durationMs: number,
    nowMonotonicMs: number = performance.now(),
  ): ShutdownDeadline {
    const duration = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
    return new ShutdownDeadline(nowMonotonicMs + duration);
  }

  remainingMs(nowMonotonicMs: number = performance.now()): number {
    return Math.max(0, this.expiresAtMonotonicMs - nowMonotonicMs);
  }

  isExpired(nowMonotonicMs: number = performance.now()): boolean {
    return this.remainingMs(nowMonotonicMs) <= 0;
  }
}
