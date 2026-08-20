import { nextAutomationRun } from './schedule';
import type { Automation, AutomationDraft, AutomationSchedule } from './types';

const STORAGE_KEY = 'droidex-automations-v1';

export function loadAutomations(): Automation[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.map(parseAutomation).filter((value): value is Automation => value !== null);
  } catch {
    return [];
  }
}

export function saveAutomation(
  automations: readonly Automation[],
  editor: { existingId?: string; draft: AutomationDraft },
): Automation[] {
  const now = Date.now();
  const existing = editor.existingId
    ? automations.find((automation) => automation.id === editor.existingId)
    : undefined;
  const nextRunAt = editor.draft.enabled ? nextAutomationRun(editor.draft.schedule, now) : null;
  const automation: Automation = {
    id: existing?.id ?? crypto.randomUUID(),
    ...editor.draft,
    title: editor.draft.title.trim(),
    prompt: editor.draft.prompt.trim(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Local time',
    nextRunAt,
    lastRunAt: existing?.lastRunAt ?? null,
    lastRunStatus: existing?.lastRunStatus ?? null,
    lastAppSessionId: existing?.lastAppSessionId ?? null,
    completedAt: existing?.completedAt ?? null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  const next = existing
    ? automations.map((candidate) => (candidate.id === automation.id ? automation : candidate))
    : [automation, ...automations];
  persistAutomations(next);
  return next;
}

export function setAutomationEnabled(
  automations: readonly Automation[],
  id: string,
  enabled: boolean,
): Automation[] {
  const now = Date.now();
  const next = automations.map((automation) =>
    automation.id === id
      ? {
          ...automation,
          enabled,
          nextRunAt: enabled ? nextAutomationRun(automation.schedule, now) : null,
          updatedAt: now,
        }
      : automation,
  );
  persistAutomations(next);
  return next;
}

export function removeAutomation(automations: readonly Automation[], id: string): Automation[] {
  const next = automations.filter((automation) => automation.id !== id);
  persistAutomations(next);
  return next;
}

function persistAutomations(automations: readonly Automation[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(automations));
  } catch {
    // The UI remains usable for this run even when the profile storage is unavailable.
  }
}

function parseAutomation(value: unknown): Automation | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Partial<Automation>;
  const schedule = parseSchedule(candidate.schedule);
  if (
    typeof candidate.id !== 'string' ||
    typeof candidate.title !== 'string' ||
    typeof candidate.prompt !== 'string' ||
    typeof candidate.enabled !== 'boolean' ||
    !schedule
  ) {
    return null;
  }
  const workspaceCwd = typeof candidate.workspaceCwd === 'string' ? candidate.workspaceCwd : null;
  return {
    id: candidate.id,
    title: candidate.title,
    prompt: candidate.prompt,
    workspaceCwd,
    executionMode:
      workspaceCwd && candidate.executionMode === 'worktree' ? 'worktree' : 'local',
    enabled: candidate.enabled,
    schedule,
    timezone: typeof candidate.timezone === 'string' ? candidate.timezone : 'Local time',
    nextRunAt: candidate.enabled ? nextAutomationRun(schedule) : null,
    lastRunAt: finiteOrNull(candidate.lastRunAt),
    lastRunStatus:
      candidate.lastRunStatus === 'queued' ||
      candidate.lastRunStatus === 'running' ||
      candidate.lastRunStatus === 'launched' ||
      candidate.lastRunStatus === 'failed'
        ? candidate.lastRunStatus
        : null,
    lastAppSessionId:
      typeof candidate.lastAppSessionId === 'string' ? candidate.lastAppSessionId : null,
    completedAt: finiteOrNull(candidate.completedAt),
    createdAt: Number.isFinite(candidate.createdAt) ? Number(candidate.createdAt) : Date.now(),
    updatedAt: Number.isFinite(candidate.updatedAt) ? Number(candidate.updatedAt) : Date.now(),
  };
}

function parseSchedule(value: unknown): AutomationSchedule | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const schedule = value as Record<string, unknown>;
  switch (schedule.kind) {
    case 'once':
      return Number.isFinite(schedule.runAt) && Number(schedule.runAt) > 0
        ? { kind: 'once', runAt: Number(schedule.runAt) }
        : null;
    case 'hourly': {
      const minute = Number(schedule.minute);
      return Number.isInteger(minute) && minute >= 0 && minute <= 59
        ? { kind: 'hourly', minute }
        : null;
    }
    case 'daily':
    case 'weekdays':
      return validStoredTime(schedule.time)
        ? { kind: schedule.kind, time: schedule.time }
        : null;
    case 'weekly': {
      const weekday = Number(schedule.weekday);
      return validStoredTime(schedule.time) && Number.isInteger(weekday) && weekday >= 0 && weekday <= 6
        ? { kind: 'weekly', weekday, time: schedule.time }
        : null;
    }
    case 'cron': {
      const expression = typeof schedule.expression === 'string' ? schedule.expression.trim() : '';
      return expression && expression.split(/\s+/).length === 5
        ? { kind: 'cron', expression }
        : null;
    }
    default:
      return null;
  }
}

function finiteOrNull(value: unknown): number | null {
  return Number.isFinite(value) ? Number(value) : null;
}

function validStoredTime(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return false;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
}
