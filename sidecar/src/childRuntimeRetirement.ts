// A live child runtime is a provider OS process holding a few hundred MiB. The
// admission budget in childRuntimeBudget only reclaims one under pressure, so a
// child the user has finished with stays resident for the rest of the app
// session. These rules decide when one may be released instead; reopening it
// reloads the provider session from persisted state.
import type {
  ChildRuntimeTarget,
  ChildSessionState,
  ParentChildSessions,
} from './ChildSessionState.js';

// Long enough that switching between subagent views keeps them warm, short
// enough that a user who walks away is not holding several provider processes.
// Reopening costs one loadSession (~3 s) and paints persisted history first.
export const CHILD_RUNTIME_IDLE_RETIREMENT_MS = 5 * 60_000;

export const CHILD_RUNTIME_RETIRED_STATUS =
  'Task runtime released after 5 minutes idle to free memory. Opening this Task again restores it.';

// Every path that could still produce output, deliver it, or persist it must
// have settled. `status` is the parent's view of the child: a child the parent
// still reports as running may be streaming into this runtime's subscription
// even though we are not driving a turn on it.
function isSettled(child: ChildSessionState): boolean {
  return (
    child.status === 'paused' &&
    child.turn.phase === 'idle' &&
    !child.turn.autoCompacting &&
    child.turn.pendingSends.length === 0 &&
    !child.turn.interrupting &&
    !child.turn.interruptingForSteer &&
    !child.closeWhenIdle &&
    child.queued !== true &&
    child.mutationTail === undefined
  );
}

function retirableRuntimes(
  parents: Iterable<ParentChildSessions>,
  hasUndeliveredResult: (child: ChildSessionState) => boolean,
): { target: ChildRuntimeTarget; dueAt: number }[] {
  const candidates: { target: ChildRuntimeTarget; dueAt: number }[] = [];
  for (const parent of parents) {
    if (parent.closing) continue;
    for (const child of parent.children.values()) {
      const runtime = child.runtime;
      if (!runtime) continue;
      if (parent.openAttempts.has(child.identity.childSessionId)) continue;
      if (!isSettled(child) || hasUndeliveredResult(child)) continue;
      candidates.push({ target: { parent, child, runtime }, dueAt: runtime.lastUsedAt });
    }
  }
  return candidates;
}

export function retirableChildRuntimes(
  parents: Iterable<ParentChildSessions>,
  now: number,
  idleMs: number,
  hasUndeliveredResult: (child: ChildSessionState) => boolean,
): ChildRuntimeTarget[] {
  return retirableRuntimes(parents, hasUndeliveredResult)
    .filter(({ dueAt }) => now - dueAt >= idleMs)
    .map(({ target }) => target);
}

export function nextChildRuntimeRetirementAt(
  parents: Iterable<ParentChildSessions>,
  idleMs: number,
  hasUndeliveredResult: (child: ChildSessionState) => boolean,
): number | undefined {
  let earliest: number | undefined;
  for (const { dueAt } of retirableRuntimes(parents, hasUndeliveredResult)) {
    const due = dueAt + idleMs;
    if (earliest === undefined || due < earliest) earliest = due;
  }
  return earliest;
}
