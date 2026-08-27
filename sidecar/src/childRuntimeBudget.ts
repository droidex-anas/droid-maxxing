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

export function childRuntimeAdmission(
  budget: ChildRuntimeBudget,
  occupancy: ChildRuntimeOccupancy,
): ChildRuntimeAdmission {
  if (occupancy.live + occupancy.reserved < budget.maxLive) return 'admit';
  if (occupancy.idleLive > 0) return 'admit';
  if (occupancy.queued < budget.maxQueued) return 'queue';
  return 'reject';
}
