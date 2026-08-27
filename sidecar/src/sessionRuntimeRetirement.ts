// A parent session's provider process is an OS process holding ~355 MiB and 17
// threads. Nothing releases one today: the renderer never sends session.close,
// so every session opened during an app run stays resident until quit. These
// rules release the ones the user has demonstrably walked away from. The
// transcript is served from history either way; only the next prompt pays for
// the reload.
import type { LiveSession } from './SessionLifecycle.js';
import type { SessionPhase } from './protocol.js';
import { RuntimeRetirementTimer } from './runtimeRetirementTimer.js';

// Six times the child budget, though a session reloads faster than a child
// (measured 0.7s against 2.4-3.1s, with the transcript painting in under 10ms
// either way). The budget is long because of where the cost lands, not how
// large it is: a child pays behind its own loading state, a session pays after
// the user has typed a prompt and pressed enter.
export const SESSION_RUNTIME_IDLE_RETIREMENT_MS = 30 * 60_000;

export const SESSION_RUNTIME_RETIRED_STATUS =
  'Session runtime released after 30 minutes idle to free memory. Sending a message restores it.';

// `streaming` is the authority on whether a turn is in flight: nothing moves a
// settled session out of 'running' or 'planning'. These phases mean the session
// is holding an unanswered provider request instead.
const UNANSWERED_PHASES = new Set<SessionPhase>([
  'intake',
  'awaiting_plan_approval',
  'awaiting_run_start',
  'initializing',
]);

export interface SessionRetirementFacts {
  appSessionId: string;
  idleSince: number;
  phase: SessionPhase;
  streaming: boolean;
  compacting: boolean;
  queuedSends: number;
  interrupting: boolean;
  closing: boolean;
  focused: boolean;
  hasUnsettledChildren: boolean;
  hasOpenBrowser: boolean;
  hasPendingSettings: boolean;
}

// Every path that could still produce output, own unsaved user intent, or lose
// a resource the user would notice must have settled. Retiring runs the same
// close as an explicit session close, which takes the child subtree and the
// embedded browser with it.
function isRetirableSession(facts: SessionRetirementFacts): boolean {
  return (
    !facts.focused &&
    !UNANSWERED_PHASES.has(facts.phase) &&
    !facts.streaming &&
    !facts.compacting &&
    !facts.interrupting &&
    !facts.closing &&
    facts.queuedSends === 0 &&
    !facts.hasUnsettledChildren &&
    !facts.hasOpenBrowser &&
    !facts.hasPendingSettings
  );
}

export function isDueForRetirement(
  facts: SessionRetirementFacts,
  now: number,
  idleMs: number,
): boolean {
  return isRetirableSession(facts) && now - facts.idleSince >= idleMs;
}

export function retirableSessions(
  facts: Iterable<SessionRetirementFacts>,
  now: number,
  idleMs: number,
): string[] {
  const due: string[] = [];
  for (const session of facts) {
    if (isDueForRetirement(session, now, idleMs)) due.push(session.appSessionId);
  }
  return due;
}

export function nextSessionRetirementAt(
  facts: Iterable<SessionRetirementFacts>,
  idleMs: number,
): number | undefined {
  let earliest: number | undefined;
  for (const session of facts) {
    if (!isRetirableSession(session)) continue;
    const dueAt = session.idleSince + idleMs;
    if (earliest === undefined || dueAt < earliest) earliest = dueAt;
  }
  return earliest;
}

export interface SessionRuntimeRetirementDependencies {
  liveSessions: () => readonly LiveSession[];
  focusedAppSessionId: () => string | null;
  hasUnsettledChildren: (appSessionId: string) => boolean;
  hasOpenBrowser: (appSessionId: string) => boolean;
  hasPendingSettings: (appSessionId: string) => boolean;
  retire: (appSessionId: string) => Promise<void>;
  emitStatus: (appSessionId: string, text: string) => void;
  emitError: (appSessionId: string, message: string) => void;
  idleMs: number;
  now: () => number;
}

export class SessionRuntimeRetirement {
  private readonly timer = new RuntimeRetirementTimer(() => {
    void this.sweep();
  });
  // When each session stopped being the one the user was looking at. A session
  // read for twenty minutes without a reply must not count as idle for those
  // twenty minutes.
  private readonly unfocusedAt = new Map<string, number>();
  private focusReported = false;
  private stopped = false;

  constructor(private readonly dependencies: SessionRuntimeRetirementDependencies) {}

  // `previouslyFocused` is the focus this owner is replacing; the dependency
  // already reports the new one.
  noteFocus(previouslyFocused: string | null): void {
    this.focusReported = true;
    const focused = this.dependencies.focusedAppSessionId();
    if (previouslyFocused !== null && previouslyFocused !== focused)
      this.unfocusedAt.set(previouslyFocused, this.dependencies.now());
    if (focused !== null) this.unfocusedAt.delete(focused);
    this.arm();
  }

  arm(): void {
    if (this.stopped) {
      this.timer.cancel();
      return;
    }
    this.timer.armFor(
      nextSessionRetirementAt(this.facts(), this.dependencies.idleMs),
      this.dependencies.now(),
    );
  }

  stop(): void {
    this.stopped = true;
    this.timer.cancel();
    this.unfocusedAt.clear();
  }

  armedFor(): number | undefined {
    return this.timer.armedFor();
  }

  // Release the provider process behind every session settled and untouched
  // past the idle budget. The transcript, history, and sidebar entry survive;
  // the next prompt reloads the provider session.
  async sweep(): Promise<void> {
    const d = this.dependencies;
    for (const appSessionId of retirableSessions(this.facts(), d.now(), d.idleMs)) {
      if (this.stopped) break;
      // Each release awaits, and a prompt can reach a session still waiting in
      // this queue during that window, so the decision is taken again here.
      const current = this.factsFor(appSessionId);
      if (!current || !isDueForRetirement(current, d.now(), d.idleMs)) continue;
      d.emitStatus(appSessionId, SESSION_RUNTIME_RETIRED_STATUS);
      try {
        await d.retire(appSessionId);
      } catch (error) {
        d.emitError(
          appSessionId,
          `Could not release this session's idle runtime: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    this.arm();
  }

  // Nothing is retirable until the renderer has told us what the user is
  // looking at: without that signal we cannot tell a background session from
  // the one on screen.
  private facts(): SessionRetirementFacts[] {
    const live = this.dependencies.liveSessions();
    this.forgetClosedSessions(live);
    if (!this.focusReported) return [];
    return live.map((session) => this.describe(session));
  }

  private factsFor(appSessionId: string): SessionRetirementFacts | undefined {
    if (!this.focusReported) return undefined;
    const live = this.dependencies
      .liveSessions()
      .find((session) => session.summary.appSessionId === appSessionId);
    return live ? this.describe(live) : undefined;
  }

  private describe(live: LiveSession): SessionRetirementFacts {
    const d = this.dependencies;
    const appSessionId = live.summary.appSessionId;
    return {
      appSessionId,
      idleSince: Math.max(live.summary.updatedAt, this.unfocusedAt.get(appSessionId) ?? 0),
      phase: live.summary.phase,
      streaming: live.streaming || live.summary.streaming === true,
      compacting: live.compacting === true || live.autoCompacting,
      queuedSends: live.pendingSends.length,
      interrupting: live.interrupting === true || live.interruptingForSteer === true,
      closing: live.closeMode !== undefined,
      focused: appSessionId === d.focusedAppSessionId(),
      hasUnsettledChildren: d.hasUnsettledChildren(appSessionId),
      hasOpenBrowser: d.hasOpenBrowser(appSessionId),
      hasPendingSettings: d.hasPendingSettings(appSessionId),
    };
  }

  private forgetClosedSessions(live: readonly LiveSession[]): void {
    if (this.unfocusedAt.size === 0) return;
    const open = new Set(live.map((session) => session.summary.appSessionId));
    for (const appSessionId of this.unfocusedAt.keys()) {
      if (!open.has(appSessionId)) this.unfocusedAt.delete(appSessionId);
    }
  }
}
