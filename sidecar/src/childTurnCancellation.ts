import type {
  ChildRuntimeState,
  ChildSessionState,
  ParentChildSessions,
} from './ChildSessionState.js';

export type PreparedChildInterrupt =
  | { kind: 'missing' }
  | { kind: 'queued'; parent: ParentChildSessions; child: ChildSessionState }
  | {
      kind: 'live';
      parent: ParentChildSessions;
      child: ChildSessionState;
      runtime: ChildRuntimeState;
    };

export function discardCancelledPendingSends(child: ChildSessionState): void {
  child.turn.pendingSends = [];
  child.turn.pendingDrainEpoch += 1;
}

export function dequeueQueuedChild(parent: ParentChildSessions, child: ChildSessionState): void {
  parent.runtimeQueue = parent.runtimeQueue.filter((id) => id !== child.identity.childSessionId);
  if (!child.queued) return;
  child.queued = false;
  child.queuedRequestId = undefined;
}

export function cancelInFlightOpen(parent: ParentChildSessions, child: ChildSessionState): boolean {
  if (child.runtime) return false;
  const attempt = parent.openAttempts.get(child.identity.childSessionId);
  if (!attempt) return false;
  attempt.isCancelled = true;
  attempt.cancel();
  return true;
}

export function takeAdmittedSend(child: ChildSessionState): string | undefined {
  const drainEpoch = child.turn.pendingDrainEpoch;
  const send = child.turn.pendingSends.shift();
  if (send === undefined || child.turn.pendingDrainEpoch !== drainEpoch) return undefined;
  return send;
}

export function markQueuedInterruptSettled(child: ChildSessionState): void {
  child.turn.interrupting = false;
  child.turn.interruptingForSteer = false;
  child.turn.phase = 'idle';
  if (child.status === 'running') child.status = 'paused';
}

export function prepareChildInterrupt(
  parent: ParentChildSessions | undefined,
  child: ChildSessionState | undefined,
): PreparedChildInterrupt {
  if (!parent || !child) return { kind: 'missing' };
  discardCancelledPendingSends(child);
  dequeueQueuedChild(parent, child);
  if (!child.runtime) cancelInFlightOpen(parent, child);
  const runtime = child.runtime;
  if (!runtime) {
    markQueuedInterruptSettled(child);
    return { kind: 'queued', parent, child };
  }
  return { kind: 'live', parent, child, runtime };
}
