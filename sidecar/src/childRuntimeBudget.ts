import type {
  ChildRuntimeState,
  ChildSessionState,
  ParentChildSessions,
} from './ChildSessionState.js';

export type ChildRuntimeAdmission = 'admit' | 'queue' | 'reject';

export interface ChildRuntimeBudget {
  maxLive: number;
  maxQueued: number;
}

export interface ChildRuntimeOccupancy {
  live: number;
  reserved: number;
  queued: number;
  idleLive: number;
}

export type ChildCapacityDecision =
  | { action: 'reserve' }
  | { action: 'evict'; victim: ChildSessionState & { runtime: ChildRuntimeState } }
  | { action: 'queue' }
  | { action: 'reject' };

export function childRuntimeLimits(d: {
  maxLiveRuntimes: number;
  maxOpenSessions: number;
  maxQueuedRuntimes: number;
}): ChildRuntimeBudget {
  return {
    maxLive: Math.min(d.maxLiveRuntimes, d.maxOpenSessions),
    maxQueued: d.maxQueuedRuntimes,
  };
}

export function childRuntimeAdmission(
  budget: ChildRuntimeBudget,
  occupancy: ChildRuntimeOccupancy,
): ChildRuntimeAdmission {
  if (occupancy.live + occupancy.reserved < budget.maxLive) return 'admit';
  if (occupancy.idleLive > 0) return 'admit';
  if (occupancy.queued < budget.maxQueued) return 'queue';
  return 'reject';
}

export function idleLiveRuntimes(
  parent: ParentChildSessions,
  requested: ChildSessionState,
): (ChildSessionState & { runtime: ChildRuntimeState })[] {
  return [...parent.children.values()]
    .filter(
      (child): child is ChildSessionState & { runtime: ChildRuntimeState } =>
        child !== requested &&
        child.runtime !== undefined &&
        child.turn.phase === 'idle' &&
        !child.turn.autoCompacting &&
        child.turn.pendingSends.length === 0,
    )
    .sort((left, right) => left.runtime.lastUsedAt - right.runtime.lastUsedAt);
}

export function parentRuntimeOccupancy(
  parent: ParentChildSessions,
  idleLive: number,
): ChildRuntimeOccupancy {
  return {
    live: [...parent.children.values()].filter((child) => child.runtime).length,
    reserved: parent.reservedOpenSlots.size,
    queued: parent.runtimeQueue.length,
    idleLive,
  };
}

export function decideChildRuntimeCapacity(
  parent: ParentChildSessions,
  requested: ChildSessionState,
  limits: ChildRuntimeBudget,
): ChildCapacityDecision {
  const idle = idleLiveRuntimes(parent, requested);
  const occupancy = parentRuntimeOccupancy(parent, idle.length);
  const admission = childRuntimeAdmission(limits, occupancy);
  if (admission === 'admit') {
    if (occupancy.live + occupancy.reserved >= limits.maxLive) {
      const victim = idle.at(0);
      if (!victim) return { action: 'queue' };
      return { action: 'evict', victim };
    }
    return { action: 'reserve' };
  }
  if (admission === 'queue') return { action: 'queue' };
  return { action: 'reject' };
}

export function enqueueChildRuntime(
  parent: ParentChildSessions,
  child: ChildSessionState,
  requestId: string | null,
): void {
  const id = child.identity.childSessionId;
  if (!parent.runtimeQueue.includes(id)) parent.runtimeQueue.push(id);
  child.queued = true;
  child.queuedRequestId = requestId;
}

export function takeNextQueuedChild(
  parent: ParentChildSessions,
  maxLive: number,
): { child: ChildSessionState; requestId: string | null } | undefined {
  while (parent.runtimeQueue.length > 0) {
    const live =
      [...parent.children.values()].filter((child) => child.runtime).length +
      parent.reservedOpenSlots.size;
    if (live >= maxLive) return undefined;
    const childSessionId = parent.runtimeQueue.shift();
    if (!childSessionId) return undefined;
    const child = parent.children.get(childSessionId);
    if (!child || child.runtime) continue;
    const requestId = child.queuedRequestId ?? null;
    child.queued = false;
    child.queuedRequestId = undefined;
    return { child, requestId };
  }
  return undefined;
}
