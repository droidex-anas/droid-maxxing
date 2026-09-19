import type { ProjectThread, ProjectView } from './types';

export function isProjectView(value: unknown): value is ProjectView {
  if (!record(value) || !isProjectMetadata(value) || !isThreadList(value.threads)) return false;
  if (!Array.isArray(value.uncertainTargets) || value.uncertainTargets.length > 8) return false;
  const owners = new Map(
    value.threads.map((thread) => [thread.appSessionId, thread.ownerAppSessionId]),
  );
  if (owners.size !== value.threads.length || !validOwnership(owners)) return false;
  return value.uncertainTargets.every((id: unknown) => typeof id === 'string' && owners.has(id));
}

function isProjectMetadata(value: Record<string, unknown>): boolean {
  return (
    text(value.id, 200) &&
    text(value.title, 120) &&
    typeof value.paused === 'boolean' &&
    count(value.wakesLeft, 20) &&
    count(value.launching, 8) &&
    count(value.queued, 64) &&
    count(value.uncertain, 64) &&
    (value.error === undefined || text(value.error, 2_000))
  );
}

function isThreadList(value: unknown): value is ProjectThread[] {
  return (
    Array.isArray(value) &&
    value.length <= 8 &&
    value.every(
      (thread: unknown) =>
        record(thread) &&
        text(thread.appSessionId, 200) &&
        text(thread.title, 120) &&
        typeof thread.waiting === 'boolean' &&
        (thread.ownerAppSessionId === undefined || text(thread.ownerAppSessionId, 200)),
    )
  );
}

function validOwnership(owners: Map<string, string | undefined>): boolean {
  if (owners.size && [...owners.values()].filter((owner) => owner === undefined).length !== 1)
    return false;
  for (const [id, parent] of owners) {
    const seen = new Set([id]);
    let owner = parent;
    while (owner !== undefined) {
      if (seen.has(owner) || !owners.has(owner)) return false;
      seen.add(owner);
      owner = owners.get(owner);
    }
  }
  return true;
}

export function isProjectResult(value: Record<string, unknown>): boolean {
  if (!text(value.requestId, 200)) return false;
  if (value.ok === false) return text(value.error, 8_192);
  return (
    value.ok === true &&
    (value.projectId === undefined || text(value.projectId, 200)) &&
    (value.appSessionId === undefined || text(value.appSessionId, 200))
  );
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}
function count(value: unknown, max: number): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max;
}
