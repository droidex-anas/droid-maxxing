/**
 * Canonical absolute monotonic shutdown deadline for the provider layer.
 *
 * Create once at the first shutdown trigger and pass the same instance
 * through every step. Callers must not substitute a fresh relative timeout.
 * `nowMonotonicMs` uses `performance.now()` unless a test injects a clock.
 */
export const SIDECAR_SHUTDOWN_BUDGET_MS = 5_000;

export class ShutdownDeadline {
  private readonly clock: () => number;

  private constructor(
    private readonly expiresAtMonotonicMs: number,
    clock: () => number = () => performance.now(),
  ) {
    this.clock = clock;
  }

  static fromDurationMs(
    durationMs: number,
    nowMonotonicMs: number = performance.now(),
  ): ShutdownDeadline {
    const duration = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
    return new ShutdownDeadline(nowMonotonicMs + duration);
  }

  static withClock(durationMs: number, clock: () => number): ShutdownDeadline {
    const nowMonotonicMs = clock();
    const duration = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
    return new ShutdownDeadline(nowMonotonicMs + duration, clock);
  }

  remainingMs(nowMonotonicMs: number = this.clock()): number {
    return Math.max(0, this.expiresAtMonotonicMs - nowMonotonicMs);
  }

  isExpired(nowMonotonicMs: number = this.clock()): boolean {
    return this.remainingMs(nowMonotonicMs) <= 0;
  }

  /**
   * Wait for `work` only until this deadline. An already-expired deadline
   * returns immediately and does not wait. Late rejection is swallowed so a
   * abandoned waiter cannot become an unhandled rejection.
   */
  async awaitSettled(work: Promise<unknown>): Promise<void> {
    let capturedError: unknown;
    const captured = work.then(
      () => undefined,
      (error: unknown) => {
        capturedError = error;
      },
    );
    if (this.isExpired()) {
      void captured;
      if (capturedError !== undefined) throw capturedError;
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), this.remainingMs());
      timer.unref?.();
    });
    try {
      const result = await Promise.race([captured.then(() => 'done' as const), timeout]);
      if (result === 'timeout') {
        void captured;
        return;
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    if (capturedError !== undefined) throw capturedError;
  }
}

export function createSharedShutdown(
  run: (deadline: ShutdownDeadline) => Promise<void>,
  options: {
    durationMs?: number;
    nowMonotonicMs?: () => number;
  } = {},
): () => Promise<void> {
  let pending: Promise<void> | undefined;
  return () => {
    if (!pending) {
      const now = options.nowMonotonicMs?.() ?? performance.now();
      const deadline = ShutdownDeadline.fromDurationMs(
        options.durationMs ?? SIDECAR_SHUTDOWN_BUDGET_MS,
        now,
      );
      pending = run(deadline);
    }
    return pending;
  };
}
