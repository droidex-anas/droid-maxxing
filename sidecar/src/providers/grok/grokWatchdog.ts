import { GROK_ACTIVE_TOOL_INACTIVITY_MS, GROK_TURN_INACTIVITY_MS } from './grokHandshake.js';

export { GROK_ACTIVE_TOOL_INACTIVITY_MS, GROK_TURN_INACTIVITY_MS };

export interface GrokTimer {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): { clear(): void };
}

export function createRealGrokTimer(): GrokTimer {
  return {
    now: () => performance.now(),
    setTimeout: (callback, delayMs) => {
      const handle = setTimeout(callback, delayMs);
      return { clear: () => clearTimeout(handle) };
    },
  };
}

export class ManualGrokTimer implements GrokTimer {
  #now = 0;
  #nextId = 1;
  readonly #timers = new Map<number, { fireAt: number; callback: () => void }>();

  now(): number {
    return this.#now;
  }

  setTimeout(callback: () => void, delayMs: number): { clear(): void } {
    const id = this.#nextId;
    this.#nextId += 1;
    this.#timers.set(id, { fireAt: this.#now + Math.max(0, delayMs), callback });
    return {
      clear: () => {
        this.#timers.delete(id);
      },
    };
  }

  advance(ms: number): void {
    this.#now += Math.max(0, ms);
    this.#fireDue();
  }

  #fireDue(): void {
    while (true) {
      let dueId: number | undefined;
      let dueAt = Number.POSITIVE_INFINITY;
      for (const [id, timer] of this.#timers) {
        if (timer.fireAt <= this.#now && timer.fireAt < dueAt) {
          dueId = id;
          dueAt = timer.fireAt;
        }
      }
      if (dueId === undefined) {
        return;
      }
      const timer = this.#timers.get(dueId);
      this.#timers.delete(dueId);
      timer?.callback();
    }
  }
}

export interface GrokTurnWatchdogOptions {
  timer: GrokTimer;
  inactivityMs?: number;
  activeToolInactivityMs?: number;
  remainingMs?: () => number;
  onStall: (turnId: string) => void;
}

export class GrokTurnWatchdog {
  readonly #timer: GrokTimer;
  readonly #inactivityMs: number;
  readonly #activeToolInactivityMs: number;
  readonly #remainingMs: (() => number) | undefined;
  readonly #onStall: (turnId: string) => void;
  readonly #activeToolCallIds = new Set<string>();
  #handle: { clear(): void } | undefined;
  #turnId: string | undefined;
  #lastActivityAt: number | undefined;
  #paused = false;

  constructor(options: GrokTurnWatchdogOptions) {
    this.#timer = options.timer;
    this.#inactivityMs = options.inactivityMs ?? GROK_TURN_INACTIVITY_MS;
    this.#activeToolInactivityMs = options.activeToolInactivityMs ?? GROK_ACTIVE_TOOL_INACTIVITY_MS;
    this.#remainingMs = options.remainingMs;
    this.#onStall = options.onStall;
  }

  start(turnId: string): void {
    this.stop();
    this.#turnId = turnId;
    this.#lastActivityAt = undefined;
    this.#paused = false;
  }

  recordActivity(): void {
    if (this.#turnId === undefined) {
      return;
    }
    this.#lastActivityAt = this.#timer.now();
    this.#schedule();
  }

  setToolActive(toolCallId: string, active: boolean): void {
    if (active) {
      this.#activeToolCallIds.add(toolCallId);
    } else {
      this.#activeToolCallIds.delete(toolCallId);
    }
    this.#schedule();
  }

  pause(): void {
    this.#paused = true;
    this.#handle?.clear();
    this.#handle = undefined;
  }

  resume(): void {
    this.#paused = false;
    if (this.#turnId !== undefined) {
      this.#lastActivityAt = this.#timer.now();
      this.#schedule();
    }
  }

  stop(): void {
    this.#handle?.clear();
    this.#handle = undefined;
    this.#turnId = undefined;
    this.#lastActivityAt = undefined;
    this.#activeToolCallIds.clear();
    this.#paused = false;
  }

  #schedule(): void {
    this.#handle?.clear();
    this.#handle = undefined;
    if (this.#turnId === undefined || this.#lastActivityAt === undefined || this.#paused) {
      return;
    }
    const timeout =
      this.#activeToolCallIds.size > 0 ? this.#activeToolInactivityMs : this.#inactivityMs;
    let remaining = Math.max(0, timeout - (this.#timer.now() - this.#lastActivityAt));
    if (this.#remainingMs) {
      remaining = Math.min(remaining, this.#remainingMs());
    }
    const turnId = this.#turnId;
    this.#handle = this.#timer.setTimeout(() => {
      if (this.#turnId !== turnId || this.#paused || this.#lastActivityAt === undefined) {
        return;
      }
      this.#onStall(turnId);
    }, remaining);
  }
}
