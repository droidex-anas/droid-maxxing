import type { Automation, AutomationDraft, AutomationSchedule } from './types';

export const AUTOMATION_LINK_ORIGIN = 'https://droidex.local';
export const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

export const AUTOMATION_SETUP_PROMPT = `Let's set up a DROIDEX automation together. First, briefly explain that DROIDEX automations are designed to run locally on this device and open their result as a background chat. Then interview me to determine what should run, which workspace it should use, whether code-changing work needs an isolated worktree, and exactly when it should run.

Once I confirm the details, give me a compact schedule specification with the title, instructions, workspace, isolation choice, frequency, date or time, and whether it should start active. Tell me to review and save it in the Automations tab. Do not say the automation is active until I save it there.`;

export function defaultAutomationDraft(workspaceCwd: string | null): AutomationDraft {
  return {
    title: '',
    prompt: '',
    workspaceCwd,
    executionMode: workspaceCwd ? 'worktree' : 'local',
    enabled: true,
    schedule: { kind: 'daily', time: defaultTime() },
  };
}

export function automationToDraft(automation: Automation): AutomationDraft {
  return {
    title: automation.title,
    prompt: automation.prompt,
    workspaceCwd: automation.workspaceCwd,
    executionMode: automation.executionMode,
    enabled: automation.enabled,
    schedule: automation.schedule,
  };
}

export function nextAutomationRun(
  schedule: AutomationSchedule,
  fromMs = Date.now(),
): number | null {
  switch (schedule.kind) {
    case 'once':
      return schedule.runAt > fromMs ? schedule.runAt : null;
    case 'hourly': {
      const candidate = new Date(fromMs);
      candidate.setSeconds(0, 0);
      candidate.setMinutes(schedule.minute);
      if (candidate.getTime() <= fromMs) candidate.setHours(candidate.getHours() + 1);
      return candidate.getTime();
    }
    case 'daily':
      return nextTimedRun(schedule.time, fromMs, () => true);
    case 'weekdays':
      return nextTimedRun(
        schedule.time,
        fromMs,
        (date) => date.getDay() !== 0 && date.getDay() !== 6,
      );
    case 'weekly': {
      const [hour, minute] = schedule.time.split(':').map(Number);
      const candidate = new Date(fromMs);
      candidate.setHours(hour, minute, 0, 0);
      const daysAhead = (schedule.weekday - candidate.getDay() + 7) % 7;
      candidate.setDate(candidate.getDate() + daysAhead);
      if (candidate.getTime() <= fromMs) candidate.setDate(candidate.getDate() + 7);
      return candidate.getTime();
    }
    case 'cron':
      // The preview UI validates and stores cron faithfully. The desktop runner
      // owns exact cron expansion once execution wiring lands.
      return null;
  }
}

function nextTimedRun(
  time: string,
  fromMs: number,
  accepts: (candidate: Date) => boolean,
): number {
  const [hour, minute] = time.split(':').map(Number);
  const candidate = new Date(fromMs);
  candidate.setHours(hour, minute, 0, 0);
  if (candidate.getTime() <= fromMs) candidate.setDate(candidate.getDate() + 1);
  while (!accepts(candidate)) candidate.setDate(candidate.getDate() + 1);
  return candidate.getTime();
}

export function formatSchedule(schedule: AutomationSchedule): string {
  switch (schedule.kind) {
    case 'once':
      return `Once · ${formatDateTime(schedule.runAt)}`;
    case 'hourly':
      return schedule.minute === 0
        ? 'Hourly'
        : `Hourly · at :${String(schedule.minute).padStart(2, '0')}`;
    case 'daily':
      return `Daily at ${formatTime(schedule.time)}`;
    case 'weekdays':
      return `Weekdays at ${formatTime(schedule.time)}`;
    case 'weekly':
      return `${WEEKDAYS[schedule.weekday] ?? 'Weekly'} at ${formatTime(schedule.time)}`;
    case 'cron':
      return `Cron · ${schedule.expression}`;
  }
}

export function formatNextRun(value: number | null, completedAt: number | null): string {
  if (value !== null) return `Next ${formatDateTime(value)}`;
  if (completedAt !== null) return `Completed ${formatDateTime(completedAt)}`;
  return 'No upcoming run';
}

export function formatDateTime(value: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(value);
}

export function workspaceLabel(cwd: string | null): string {
  if (!cwd) return 'No workspace';
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

export function toLocalDateTimeInput(value: number): string {
  const date = new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  return `${String(year)}-${month}-${day}T${hour}:${minute}`;
}

export function parseLocalDateTime(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.getTime() : null;
}

export function validateAutomationDraft(draft: AutomationDraft): string | null {
  if (!draft.title.trim()) return 'Add a title.';
  if (!draft.prompt.trim()) return 'Describe what DROIDEX should do.';
  const schedule = draft.schedule;
  switch (schedule.kind) {
    case 'once':
      if (!Number.isFinite(schedule.runAt) || schedule.runAt <= Date.now()) {
        return 'Choose a future date and time.';
      }
      break;
    case 'hourly':
      if (!Number.isInteger(schedule.minute) || schedule.minute < 0 || schedule.minute > 59) {
        return 'Minute must be between 0 and 59.';
      }
      break;
    case 'daily':
    case 'weekdays':
      if (!validTime(schedule.time)) return 'Choose a valid time.';
      break;
    case 'weekly':
      if (!validTime(schedule.time) || schedule.weekday < 0 || schedule.weekday > 6) {
        return 'Choose a weekday and time.';
      }
      break;
    case 'cron':
      if (schedule.expression.trim().split(/\s+/).length !== 5) {
        return 'Use a five-field cron expression.';
      }
      break;
  }
  return null;
}

export function automationDraftFromLink(
  rawUrl: string,
  currentWorkspace: string | null,
): AutomationDraft | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.origin !== AUTOMATION_LINK_ORIGIN || url.pathname !== '/automation/new') return null;

  const title = clipped(url.searchParams.get('title'), 120);
  const prompt = clipped(url.searchParams.get('prompt'), 20_000);
  if (!title || !prompt) return null;

  const workspaceParam = url.searchParams.get('workspace')?.trim() ?? 'current';
  const workspaceCwd =
    workspaceParam === 'none'
      ? null
      : workspaceParam === 'current'
        ? currentWorkspace
        : clipped(workspaceParam, 4096);
  const executionMode =
    workspaceCwd && url.searchParams.get('isolated') !== '0' ? 'worktree' : 'local';
  const schedule = scheduleFromParams(url.searchParams);
  if (!schedule) return null;

  return { title, prompt, workspaceCwd, executionMode, enabled: true, schedule };
}

function scheduleFromParams(params: URLSearchParams): AutomationSchedule | null {
  switch (params.get('frequency')) {
    case 'once': {
      const runAt = parseLocalDateTime(params.get('date') ?? '');
      return runAt === null ? null : { kind: 'once', runAt };
    }
    case 'hourly': {
      const minute = Number(params.get('minute') ?? '0');
      return Number.isInteger(minute) && minute >= 0 && minute <= 59
        ? { kind: 'hourly', minute }
        : null;
    }
    case 'daily': {
      const time = params.get('time') ?? '';
      return validTime(time) ? { kind: 'daily', time } : null;
    }
    case 'weekdays': {
      const time = params.get('time') ?? '';
      return validTime(time) ? { kind: 'weekdays', time } : null;
    }
    case 'weekly': {
      const time = params.get('time') ?? '';
      const weekday = parseWeekday(params.get('weekday'));
      return validTime(time) && weekday !== null ? { kind: 'weekly', weekday, time } : null;
    }
    case 'cron': {
      const expression = clipped(params.get('expression'), 120);
      return expression && expression.split(/\s+/).length === 5
        ? { kind: 'cron', expression }
        : null;
    }
    default:
      return null;
  }
}

function parseWeekday(value: string | null): number | null {
  if (value === null) return null;
  if (/^[0-6]$/.test(value)) return Number(value);
  const index = WEEKDAYS.findIndex((weekday) => weekday.toLowerCase() === value.toLowerCase());
  return index >= 0 ? index : null;
}

function defaultTime(): string {
  const date = new Date(Date.now() + 60 * 60 * 1000);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function formatTime(value: string): string {
  const [hourText, minuteText] = value.split(':');
  const date = new Date();
  date.setHours(Number(hourText), Number(minuteText), 0, 0);
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date);
}

function validTime(value: string): boolean {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return false;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
}

function clipped(value: string | null, maxLength: number): string | null {
  if (value === null) return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) return null;
  return normalized;
}
