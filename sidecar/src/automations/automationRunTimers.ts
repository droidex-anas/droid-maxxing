// How long DROIDEX waits for the chat it asked SessionManager to create.
const SESSION_CREATE_TIMEOUT_MS = 90_000;
// The safety limit for a single run, so a stuck chat cannot hold the queue.
const RUN_LIMIT_MS = 24 * 60 * 60 * 1_000;
// A turn reports streaming false between tool calls, so settling waits briefly
// to see whether the run picks the turn back up.
const TURN_SETTLE_GRACE_MS = 120;

export interface RunTimerHandlers {
  /** No chat arrived for a run that was launched. */
  sessionCreateTimedOut: (runId: string) => void;
  /** A run outlived the safety limit. */
  runLimitReached: (runId: string) => void;
  /** A run's turn stayed finished for the whole grace period. */
  turnSettled: (runId: string) => void;
}

/**
 * The timers that watch one run: the wait for its chat, the safety limit, and
 * the grace period that decides a turn really ended.
 *
 * Every timer is unref'd, so a pending run never keeps the sidecar alive, and
 * each fire drops its own entry before calling back. Owning the three maps
 * together is what makes `clearRun` and `clearAll` complete by construction.
 */
export class RunTimers {
  private readonly sessionCreate = new Map<string, NodeJS.Timeout>();
  private readonly runLimit = new Map<string, NodeJS.Timeout>();
  private readonly turnSettle = new Map<string, NodeJS.Timeout>();

  constructor(private readonly handlers: RunTimerHandlers) {}

  armSessionCreate(runId: string): void {
    this.arm(this.sessionCreate, runId, SESSION_CREATE_TIMEOUT_MS, () => {
      this.handlers.sessionCreateTimedOut(runId);
    });
  }

  clearSessionCreate(runId: string): void {
    this.clear(this.sessionCreate, runId);
  }

  armRunLimit(runId: string): void {
    this.arm(this.runLimit, runId, RUN_LIMIT_MS, () => {
      this.handlers.runLimitReached(runId);
    });
  }

  /** Keeps the first grace period, so a burst of turn ends settles the run once. */
  armTurnSettle(runId: string): void {
    if (this.turnSettle.has(runId)) return;
    this.arm(this.turnSettle, runId, TURN_SETTLE_GRACE_MS, () => {
      this.handlers.turnSettled(runId);
    });
  }

  /** The turn picked back up, so the grace period no longer applies. */
  clearTurnSettle(runId: string): void {
    this.clear(this.turnSettle, runId);
  }

  /** Drops every timer watching a run that has settled. */
  clearRun(runId: string): void {
    this.clear(this.sessionCreate, runId);
    this.clear(this.runLimit, runId);
    this.clear(this.turnSettle, runId);
  }

  clearAll(): void {
    for (const timers of [this.sessionCreate, this.runLimit, this.turnSettle]) {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    }
  }

  private arm(
    timers: Map<string, NodeJS.Timeout>,
    runId: string,
    delayMs: number,
    fire: () => void,
  ): void {
    this.clear(timers, runId);
    const timer = setTimeout(() => {
      timers.delete(runId);
      fire();
    }, delayMs);
    timer.unref();
    timers.set(runId, timer);
  }

  private clear(timers: Map<string, NodeJS.Timeout>, runId: string): void {
    const timer = timers.get(runId);
    if (timer) clearTimeout(timer);
    timers.delete(runId);
  }
}
