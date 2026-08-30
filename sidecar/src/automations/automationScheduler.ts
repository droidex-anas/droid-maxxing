import {
  hasModelSelection,
  MODEL_SELECTION_REQUIRED,
  type NormalizedAutomationInput,
} from './automationInput.js';
import { nextAutomationRun } from './schedule.js';
import type { Automation, AutomationStore } from './types.js';

// How long the scheduler may sleep in one step. A timer measures elapsed time,
// not calendar time, so a suspended machine, an NTP correction, or a clock change
// moves a run's due time relative to a pending timer. Re-reading the clock this
// often keeps a run at most a minute late without polling anything: a wake that
// finds nothing due neither writes nor publishes.
const SCHEDULER_RECHECK_MS = 60_000;

/** The part of the run queue the scheduler needs when an occurrence fires. */
interface ScheduledRunQueue {
  /** Queues this occurrence unless the same occurrence is already queued. */
  queueScheduled: (automation: Automation, scheduledAt: number) => void;
  /** Starts the queue if nothing is running. */
  startQueued: () => void;
}

export interface AutomationSchedulerOptions {
  store: () => AutomationStore;
  now: () => number;
  isClosed: () => boolean;
  runs: ScheduledRunQueue;
  /** Writes the store and publishes the snapshot after a due run is queued. */
  persist: () => Promise<void>;
  /** How often the scheduler re-reads the clock while waiting. Tests shorten it. */
  recheckMs?: number;
}

/**
 * When each automation runs next.
 *
 * This owns `enabled`, `nextRunAt`, and `completedAt`: it advances an automation
 * to its next occurrence when one fires, retires a one-shot schedule, and holds
 * the single timer that wakes DROIDEX for the earliest upcoming run. Queueing
 * and running are the run queue's job, reached through `ScheduledRunQueue`.
 */
export class AutomationScheduler {
  private readonly recheckMs: number;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly options: AutomationSchedulerOptions) {
    this.recheckMs = Math.max(1, options.recheckMs ?? SCHEDULER_RECHECK_MS);
  }

  /**
   * Queues the runs whose time has come. Returns whether the store changed, so a
   * wake that found nothing due stays free of a write.
   *
   * An enabled automation that is due always changes: it either advances to its
   * next occurrence or stops being enabled. That is what keeps a wake from
   * re-arming on a due time it did not clear.
   */
  processDue(): boolean {
    const now = this.options.now();
    let changed = false;
    for (const automation of this.options.store().automations) {
      if (!automation.enabled) continue;
      if (!hasModelSelection(automation)) {
        disableForMissingSelection(automation, now);
        changed = true;
        continue;
      }
      if (automation.nextRunAt === null || automation.nextRunAt > now) continue;
      const scheduledAt = automation.nextRunAt;
      this.options.runs.queueScheduled(automation, scheduledAt);
      this.advance(automation, scheduledAt, now);
      changed = true;
    }
    return changed;
  }

  /**
   * Wakes for the earliest upcoming run, and never sleeps past `recheckMs` so a
   * run whose time passed while the machine was suspended starts within one
   * interval of waking instead of a suspend's worth of time later. With nothing
   * scheduled there is no timer at all.
   */
  arm(): void {
    this.stop();
    if (this.options.isClosed()) return;
    const nextRunAt = this.nextWakeAt();
    if (nextRunAt === null) return;
    const delay = Math.max(0, Math.min(this.recheckMs, nextRunAt - this.options.now()));
    this.timer = setTimeout(() => {
      this.timer = null;
      this.wake();
    }, delay);
    this.timer.unref();
  }

  nextWakeAt(): number | null {
    let earliest: number | null = null;
    for (const automation of this.options.store().automations) {
      if (!automation.enabled || automation.nextRunAt === null) continue;
      if (earliest === null || automation.nextRunAt < earliest) earliest = automation.nextRunAt;
    }
    return earliest;
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private wake(): void {
    // A wake that only re-reads the clock costs one comparison per automation:
    // no store write, no snapshot, and no queue to drain, because nothing can
    // have become due without `processDue` recording it.
    if (!this.processDue()) {
      this.arm();
      return;
    }
    // The timer is the only thing that wakes the scheduler, so it is re-armed
    // even when the write fails; otherwise one failed write would stall every
    // later run until an unrelated command happened to arrive.
    void this.options
      .persist()
      .catch((error: unknown) => {
        console.error('Automation scheduler failed', error);
      })
      .finally(() => {
        this.arm();
        this.options.runs.startQueued();
      });
  }

  private advance(automation: Automation, scheduledAt: number, now: number): void {
    if (automation.schedule.kind === 'once') {
      automation.enabled = false;
      automation.nextRunAt = null;
      automation.completedAt = now;
    } else {
      automation.nextRunAt = nextAutomationRun(
        automation.schedule,
        automation.timezone,
        Math.max(now, scheduledAt),
      );
    }
    automation.updatedAt = now;
  }
}

/**
 * An automation cannot run without a model, and DROIDEX will not pick one for
 * the user, so it stops being scheduled and says why.
 */
export function disableForMissingSelection(automation: Automation, now: number): void {
  automation.enabled = false;
  automation.nextRunAt = null;
  automation.lastRunError = MODEL_SELECTION_REQUIRED;
  automation.updatedAt = now;
}

/** A disabled automation has no next run; a rescheduled one recomputes it. */
export function nextRunAfterUpdate(
  current: Automation,
  normalized: NormalizedAutomationInput,
  rescheduled: boolean,
  now: number,
): number | null {
  if (!normalized.enabled) return null;
  if (!rescheduled && current.nextRunAt !== null) return current.nextRunAt;
  return nextAutomationRun(normalized.schedule, normalized.timezone, now);
}
