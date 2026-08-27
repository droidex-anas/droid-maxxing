export const CONTEXT_POLL_ACTIVE_MS = 2_500;
export const CONTEXT_POLL_BACKGROUND_MS = 10_000;
export const CONTEXT_POLL_INACTIVE_MS = 60_000;

export type BackgroundWorkTier = 'interactive' | 'hidden' | 'low-power';

export interface ContextPollCadenceInput {
  tier: BackgroundWorkTier;
  isChild: boolean;
  focusedAppSessionId?: string | null;
  appSessionId: string;
}

export function contextPollIntervalMs(input: ContextPollCadenceInput): number {
  if (input.tier !== 'interactive') return 0;
  const focused =
    input.focusedAppSessionId == null || input.focusedAppSessionId === input.appSessionId;
  if (!focused) return CONTEXT_POLL_INACTIVE_MS;
  if (input.isChild) return CONTEXT_POLL_BACKGROUND_MS;
  return CONTEXT_POLL_ACTIVE_MS;
}

export interface ContextPollerCounts {
  total: number;
  active: number;
  paused: number;
  cadencesMs: number[];
}

export interface ContextPollHostOptions<T extends { session: object }> {
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
  cadenceFor: (target: T) => number;
  poll: (target: T) => void;
}

interface ContextPollerRecord<T extends { session: object }> {
  timer: ReturnType<typeof setInterval> | null;
  session: T['session'];
  target: T;
  intervalMs: number;
}

export class ContextPollHost<T extends { session: object }> {
  private readonly pollers = new Map<string, ContextPollerRecord<T>>();

  constructor(private readonly options: ContextPollHostOptions<T>) {}

  start(key: string, target: T): boolean {
    if (this.pollers.has(key)) return false;
    const intervalMs = this.options.cadenceFor(target);
    const record: ContextPollerRecord<T> = {
      timer: null,
      session: target.session,
      target,
      intervalMs,
    };
    this.pollers.set(key, record);
    this.arm(record);
    this.options.poll(target);
    return true;
  }

  stop(key: string, session?: T['session']): boolean {
    const poller = this.pollers.get(key);
    if (!poller) return false;
    if (session !== undefined && poller.session !== session) return false;
    this.disarm(poller);
    this.pollers.delete(key);
    return true;
  }

  reschedule(): void {
    for (const poller of this.pollers.values()) {
      const intervalMs = this.options.cadenceFor(poller.target);
      if (poller.intervalMs === intervalMs && (intervalMs === 0) === (poller.timer === null)) {
        continue;
      }
      this.disarm(poller);
      poller.intervalMs = intervalMs;
      this.arm(poller);
      if (intervalMs > 0) this.options.poll(poller.target);
    }
  }

  clearAll(): void {
    for (const poller of this.pollers.values()) this.disarm(poller);
    this.pollers.clear();
  }

  counts(): ContextPollerCounts {
    const cadencesMs: number[] = [];
    let active = 0;
    for (const poller of this.pollers.values()) {
      cadencesMs.push(poller.intervalMs);
      if (poller.timer) active += 1;
    }
    return {
      total: this.pollers.size,
      active,
      paused: this.pollers.size - active,
      cadencesMs,
    };
  }

  private arm(poller: ContextPollerRecord<T>): void {
    if (poller.intervalMs <= 0) return;
    const setIntervalFn = this.options.setIntervalFn ?? setInterval;
    poller.timer = setIntervalFn(() => {
      this.options.poll(poller.target);
    }, poller.intervalMs);
  }

  private disarm(poller: ContextPollerRecord<T>): void {
    if (!poller.timer) return;
    const clearIntervalFn = this.options.clearIntervalFn ?? clearInterval;
    clearIntervalFn(poller.timer);
    poller.timer = null;
  }
}
