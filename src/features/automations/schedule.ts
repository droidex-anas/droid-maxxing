import type { ModelInfo, ReasoningEffort } from '../../types/bridge';
import { reasoningForModel, validateAutomationModelSelection } from './modelSelection';
import type { Automation, AutomationDraft, AutomationRun, AutomationSchedule } from './types';

export const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

export const AUTOMATION_SETUP_PROMPT = `Let's set up a DROIDEX automation together. Ask me what task should run, which workspace it should use, whether code-changing work needs an isolated worktree, the timezone, and exactly when it should run. The current chat's model and reasoning should be inherited unless I explicitly choose different ones.

After I confirm the important details, call automation_propose. DROIDEX will render a native review card inside this chat with the complete schedule and Edit details / Confirm automation actions. Do not use browser tools, app control, shell cron, or launchd. Do not claim the automation is active until I confirm the card. Use automation_create only when I explicitly ask to skip review and this chat is already in High autonomy; otherwise use automation_propose. Use automation_list, automation_update, automation_set_enabled, automation_run_now, or automation_delete for later changes. Each real run opens as a DROIDEX chat and is tracked as queued, starting, running, completed, or failed.`;

export function defaultAutomationDraft(
  workspaceCwd: string | null,
  modelId: string | null = null,
  reasoningEffort: ReasoningEffort | null = null,
): AutomationDraft {
  return {
    title: '',
    prompt: '',
    workspaceCwd,
    executionMode: workspaceCwd ? 'worktree' : 'local',
    enabled: true,
    schedule: { kind: 'daily', time: nextHourTime() },
    timezone: deviceTimeZone(),
    modelId,
    reasoningEffort,
  };
}

export function resolveAutomationModelDefaults(
  models: ModelInfo[],
  preferredModelId: string | null | undefined,
  preferredReasoning: ReasoningEffort | null | undefined,
): { modelId: string | null; reasoningEffort: ReasoningEffort | null } {
  const model =
    models.find((candidate) => candidate.id === preferredModelId) ??
    models.find((candidate) => candidate.isDefault) ??
    models.at(0);
  if (!model) return { modelId: null, reasoningEffort: preferredReasoning ?? null };
  return {
    modelId: model.id,
    reasoningEffort: reasoningForModel(model, preferredReasoning),
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
    timezone: automation.timezone,
    modelId: automation.modelId,
    reasoningEffort: automation.reasoningEffort,
  };
}

export function validateAutomationDraft(
  draft: AutomationDraft,
  models: readonly ModelInfo[],
): string | null {
  if (!draft.title.trim()) return 'Add a title.';
  if (!draft.prompt.trim()) return 'Describe what DROIDEX should do.';
  const modelIssue = validateAutomationModelSelection(models, draft.modelId, draft.reasoningEffort);
  if (modelIssue) return modelIssue;
  if (!isTimeZone(draft.timezone)) return 'Choose a valid timezone.';
  switch (draft.schedule.kind) {
    case 'once':
      if (!Number.isFinite(draft.schedule.runAt) || draft.schedule.runAt <= Date.now()) {
        return 'Choose a future date and time.';
      }
      break;
    case 'hourly':
      if (draft.schedule.minute < 0 || draft.schedule.minute > 59) return 'Choose a valid minute.';
      break;
    case 'daily':
    case 'weekdays':
      if (!validTime(draft.schedule.time)) return 'Choose a valid time.';
      break;
    case 'weekly':
      if (
        !validTime(draft.schedule.time) ||
        draft.schedule.weekday < 0 ||
        draft.schedule.weekday > 6
      ) {
        return 'Choose a weekday and time.';
      }
      break;
    case 'cron': {
      const cronIssue = cronExpressionIssue(draft.schedule.expression);
      if (cronIssue) return cronIssue;
      break;
    }
  }
  return null;
}

const CRON_FIELDS = [
  { name: 'minute', minimum: 0, maximum: 59 },
  { name: 'hour', minimum: 0, maximum: 23 },
  { name: 'day of month', minimum: 1, maximum: 31 },
  { name: 'month', minimum: 1, maximum: 12 },
  { name: 'weekday', minimum: 0, maximum: 7 },
] as const;

/**
 * Mirrors the scheduler's cron grammar (sidecar/src/automations/schedule.ts):
 * lists, ranges, and steps over five bounded fields. Without the same rules the
 * editor would accept an expression the sidecar then refuses to schedule.
 */
export function cronExpressionIssue(expression: string): string | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== CRON_FIELDS.length || fields.some((field) => !field)) {
    return 'Use a five-field cron expression.';
  }
  for (const [index, field] of CRON_FIELDS.entries()) {
    const source = fields[index] ?? '';
    if (!isValidCronField(source, field.minimum, field.maximum)) {
      return `“${source}” is not a valid cron ${field.name} field.`;
    }
  }
  return null;
}

function isValidCronField(source: string, minimum: number, maximum: number): boolean {
  return source.split(',').every((segment) => {
    const slash = segment.indexOf('/');
    const rangeSource = slash >= 0 ? segment.slice(0, slash) : segment;
    const step = slash >= 0 ? cronNumber(segment.slice(slash + 1)) : 1;
    if (step === null || step <= 0) return false;
    if (rangeSource === '*') return true;
    const dash = rangeSource.indexOf('-');
    const start = cronNumber(dash >= 0 ? rangeSource.slice(0, dash) : rangeSource);
    const end = dash >= 0 ? cronNumber(rangeSource.slice(dash + 1)) : start;
    if (start === null || end === null) return false;
    return start >= minimum && end <= maximum && start <= end;
  });
}

function cronNumber(source: string): number | null {
  if (!/^\d+$/.test(source)) return null;
  const value = Number(source);
  return Number.isSafeInteger(value) ? value : null;
}

export function formatSchedule(schedule: AutomationSchedule, timezone?: string): string {
  switch (schedule.kind) {
    case 'once':
      return `Once · ${formatDateTime(schedule.runAt, timezone)}`;
    case 'hourly':
      return schedule.minute === 0
        ? 'Every hour'
        : `Every hour at :${String(schedule.minute).padStart(2, '0')}`;
    case 'daily':
      return `Daily at ${formatTime(schedule.time)}`;
    case 'weekdays':
      return `Weekdays at ${formatTime(schedule.time)}`;
    case 'weekly':
      return `${WEEKDAYS[schedule.weekday]} at ${formatTime(schedule.time)}`;
    case 'cron':
      return `Custom schedule · ${schedule.expression}`;
  }
}

export function formatNextRun(
  nextRunAt: number | null,
  completedAt: number | null,
  timezone?: string,
): string {
  if (nextRunAt !== null) return `Next ${formatDateTime(nextRunAt, timezone)}`;
  if (completedAt !== null) return `Finished ${formatDateTime(completedAt, timezone)}`;
  return 'No upcoming run';
}

export function latestRunsByAutomation(runs: AutomationRun[]): Map<string, AutomationRun> {
  const byAutomation = new Map<string, AutomationRun>();
  for (const run of [...runs].sort((left, right) => right.requestedAt - left.requestedAt)) {
    if (!byAutomation.has(run.automationId)) byAutomation.set(run.automationId, run);
  }
  return byAutomation;
}

export function isAutomationRunActive(run: AutomationRun | undefined): boolean {
  return run?.status === 'queued' || run?.status === 'starting' || run?.status === 'running';
}

export function formatAutomationRunStatus(
  run: AutomationRun | undefined,
  now = Date.now(),
): string {
  if (!run) return 'Never run';
  switch (run.status) {
    case 'queued':
      return run.trigger === 'manual' ? 'Queued to run now' : 'Queued';
    case 'starting':
      return `Starting${run.startedAt ? ` · ${formatDuration(now - run.startedAt)}` : ''}`;
    case 'running':
      return `Running · ${formatDuration(now - (run.startedAt ?? now))}`;
    case 'completed': {
      const finished = run.finishedAt ?? run.requestedAt;
      const duration =
        run.startedAt === null ? '' : ` · ${formatDuration(finished - run.startedAt)}`;
      return `Completed ${formatRelativeTime(finished, now)}${duration}`;
    }
    case 'failed':
      return `Failed ${formatRelativeTime(run.finishedAt ?? run.requestedAt, now)}`;
  }
}

export function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  if (minutes < 60)
    return remaining ? `${String(minutes)}m ${String(remaining)}s` : `${String(minutes)}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${String(hours)}h ${String(remainingMinutes)}m` : `${String(hours)}h`;
}

export function workspaceLabel(cwd: string | null): string {
  if (!cwd) return 'No workspace';
  return cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? cwd;
}

export function deviceTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

export function supportedTimeZones(): string[] {
  const zones = Intl.supportedValuesOf('timeZone');
  const current = deviceTimeZone();
  return zones.includes(current) ? zones : [current, ...zones];
}

export function zonedInputParts(epochMs: number, timezone: string) {
  const parts = new Map(
    zonedPartsFormatter(timezone)
      .formatToParts(epochMs)
      .map((part) => [part.type, part.value]),
  );
  return {
    year: Number(parts.get('year')),
    month: Number(parts.get('month')),
    day: Number(parts.get('day')),
    hour: Number(parts.get('hour')),
    minute: Number(parts.get('minute')),
  };
}

export interface ZonedInput {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * Instant for a wall-clock time in `timezone`, verified by formatting the result
 * back. Around a DST change two offsets are in play, so both are tried: an
 * ambiguous time (fall back) resolves to its first occurrence, and a time inside
 * a spring-forward gap — which never happens on that clock — resolves to the
 * first instant after the gap instead of silently landing an hour early.
 */
export function epochFromZonedInput(input: ZonedInput, timezone: string): number {
  const wallUtc = utcFromZonedInput(input);
  const earlier = wallUtc - zoneOffsetMs(wallUtc - DAY_MS, timezone);
  const later = wallUtc - zoneOffsetMs(wallUtc + DAY_MS, timezone);
  if (utcFromZonedInput(zonedInputParts(earlier, timezone)) === wallUtc) return earlier;
  if (utcFromZonedInput(zonedInputParts(later, timezone)) === wallUtc) return later;
  return Math.max(earlier, later);
}

function utcFromZonedInput(input: ZonedInput): number {
  return Date.UTC(input.year, input.month - 1, input.day, input.hour, input.minute);
}

// A zone changes offset at most once within a day, so sampling ±24h from the
// requested wall time brackets any transition next to it.
function zoneOffsetMs(epochMs: number, timezone: string): number {
  return utcFromZonedInput(zonedInputParts(epochMs, timezone)) - epochMs;
}

export function convertOnceRunAt(runAt: number, fromTimezone: string, toTimezone: string): number {
  return epochFromZonedInput(zonedInputParts(runAt, fromTimezone), toTimezone);
}

// Recurring times are already wall clock in the automation's own timezone, so
// they are formatted as a fixed UTC instant: routing them through the device
// zone (or today's date) would shift the displayed hour across a DST boundary.
function formatTime(value: string): string {
  const [hourText = '0', minuteText = '0'] = value.split(':');
  return timeFormatter().format(Date.UTC(1970, 0, 1, Number(hourText), Number(minuteText)));
}

function formatDateTime(value: number, timezone?: string): string {
  return dateTimeFormatter(timezone).format(value);
}

// Automation lists re-render on a timer and the schedule math formats several
// instants per call, while building an Intl formatter is the expensive part of
// formatting. Each cache keeps one formatter per timezone, bounded because a
// user-supplied timezone list must not be able to grow it without limit.
const MAX_CACHED_FORMATTERS = 8;

const timeFormatters = boundedFormatterCache(() => ({
  hour: 'numeric',
  minute: '2-digit',
  // Wall-clock strings must not be shifted, so they are formatted in UTC.
  timeZone: 'UTC',
}));

const dateTimeFormatters = boundedFormatterCache((timezone) => ({
  ...(timezone ? { timeZone: timezone } : {}),
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
}));

const zonedPartsFormatters = boundedFormatterCache((timezone) => ({
  timeZone: timezone,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
}));

function timeFormatter(): Intl.DateTimeFormat {
  return timeFormatters('');
}

function dateTimeFormatter(timezone?: string): Intl.DateTimeFormat {
  return dateTimeFormatters(timezone ?? '');
}

function zonedPartsFormatter(timezone: string): Intl.DateTimeFormat {
  return zonedPartsFormatters(timezone, 'en-US-u-ca-gregory-nu-latn');
}

function boundedFormatterCache(
  options: (timezone: string) => Intl.DateTimeFormatOptions,
): (timezone: string, locale?: string) => Intl.DateTimeFormat {
  const cache = new Map<string, Intl.DateTimeFormat>();
  return (timezone, locale) => {
    const cached = cache.get(timezone);
    if (cached) return cached;
    const formatter = new Intl.DateTimeFormat(locale, options(timezone));
    if (cache.size >= MAX_CACHED_FORMATTERS) {
      const oldest = cache.keys().next();
      if (!oldest.done) cache.delete(oldest.value);
    }
    cache.set(timezone, formatter);
    return formatter;
  };
}

function formatRelativeTime(value: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - value) / 1_000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${String(seconds)}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${String(hours)}h ago`;
  const days = Math.round(hours / 24);
  return `${String(days)}d ago`;
}

function nextHourTime(): string {
  const date = new Date(Date.now() + 60 * 60 * 1_000);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function validTime(value: string): boolean {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  return !!match && Number(match[1]) <= 23 && Number(match[2]) <= 59;
}

export function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}
