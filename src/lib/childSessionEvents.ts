import type { TranscriptEvent } from '../types/bridge';

/** Factory Task/subagent metadata identifies a child-session spawn. */
export function isChildSessionTool(name?: string, args?: unknown): boolean {
  if (/\b(task|subagent|delegate)\b/i.test(name ?? '')) return true;
  const record = isRecord(args) ? args : {};
  return (
    typeof Reflect.get(record, 'subagent_type') === 'string' ||
    typeof Reflect.get(record, 'subagentType') === 'string'
  );
}

export function childSessionInfo(args: unknown): { label?: string; description?: string } {
  const record = isRecord(args) ? args : {};
  const text = (key: string) => {
    const value = record[key];
    return typeof value === 'string' ? value.trim() || undefined : undefined;
  };
  const label = text('subagent_type') ?? text('subagentType');
  const description = text('description');
  return {
    ...(label !== undefined ? { label } : {}),
    ...(description !== undefined ? { description } : {}),
  };
}

export function mergeChildSessionSpawn(
  existing: TranscriptEvent,
  next: TranscriptEvent,
): TranscriptEvent {
  const existingInfo = childSessionInfo(existing.toolArgs);
  const nextInfo = childSessionInfo(next.toolArgs);
  const label = nextInfo.label ?? existingInfo.label;
  const description = nextInfo.description ?? existingInfo.description;
  const origin = { id: existing.id, ts: existing.ts };
  if (label === nextInfo.label && description === nextInfo.description) {
    return { ...next, ...origin };
  }
  const args = isRecord(next.toolArgs) ? next.toolArgs : {};
  return {
    ...next,
    ...origin,
    toolArgs: {
      ...args,
      ...(label ? { subagent_type: label } : {}),
      ...(description ? { description } : {}),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
