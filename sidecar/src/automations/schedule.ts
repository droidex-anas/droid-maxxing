import type { AutomationSchedule } from './types.js';

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

// End of the ECMAScript time range. A later instant cannot be formatted, so a
// `once` run at that time would only fail later, in the editor.
const MAX_EPOCH_MS = 8_640_000_000_000_000;

// February 29 can be up to eight years apart across a skipped century leap year
// (2096 to 2104), so the calendar-day horizon must clear that gap.
const MAX_CRON_SEARCH_DAYS = 366 * 9;

// Bounded so repeated lookups with attacker-supplied timezone strings cannot
// grow this cache without limit.
const MAX_CACHED_FORMATTERS = 12;

const formatterCache = new Map<string, Intl.DateTimeFormat>();

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
}

interface CronField {
  values: Set<number>;
  wildcard: boolean;
}

interface ParsedCron {
  minutes: number[];
  hours: number[];
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
}

export function nextAutomationRun(
  schedule: AutomationSchedule,
  timezone: string,
  fromMs = Date.now(),
): number | null {
  assertTimeZone(timezone);
  switch (schedule.kind) {
    case 'once':
      return schedule.runAt > fromMs ? schedule.runAt : null;
    case 'hourly':
      return nextMatchingMinute(fromMs, timezone, (parts) => parts.minute === schedule.minute, 180);
    case 'daily': {
      const { hour, minute } = parseTime(schedule.time);
      return nextLocalTime(fromMs, timezone, hour, minute, () => true);
    }
    case 'weekdays': {
      const { hour, minute } = parseTime(schedule.time);
      return nextLocalTime(
        fromMs,
        timezone,
        hour,
        minute,
        (weekday) => weekday !== 0 && weekday !== 6,
      );
    }
    case 'weekly': {
      const { hour, minute } = parseTime(schedule.time);
      return nextLocalTime(
        fromMs,
        timezone,
        hour,
        minute,
        (weekday) => weekday === schedule.weekday,
      );
    }
    case 'cron':
      return nextCronRun(parseCron(schedule.expression), timezone, fromMs);
  }
}

export function validateSchedule(schedule: AutomationSchedule): void {
  switch (schedule.kind) {
    case 'once':
      if (!isFormattableInstant(schedule.runAt)) {
        throw new Error('Once schedules need a valid date and time.');
      }
      return;
    case 'hourly':
      if (!Number.isInteger(schedule.minute) || schedule.minute < 0 || schedule.minute > 59) {
        throw new Error('Hourly minute must be between 0 and 59.');
      }
      return;
    case 'daily':
    case 'weekdays':
      parseTime(schedule.time);
      return;
    case 'weekly':
      parseTime(schedule.time);
      if (!Number.isInteger(schedule.weekday) || schedule.weekday < 0 || schedule.weekday > 6) {
        throw new Error('Weekly schedules need a valid weekday.');
      }
      return;
    case 'cron':
      parseCron(schedule.expression);
      return;
  }
}

function isFormattableInstant(runAt: number): boolean {
  return Number.isFinite(runAt) && runAt > 0 && runAt <= MAX_EPOCH_MS;
}

export function assertTimeZone(timezone: string): void {
  if (!timezone.trim()) throw new Error('Timezone is required.');
  try {
    zonedFormatter(timezone);
  } catch {
    throw new Error(`Unknown timezone: ${timezone}`);
  }
}

function nextCronRun(cron: ParsedCron, timezone: string, fromMs: number): number | null {
  const local = zonedParts(fromMs, timezone);
  const firstLocalDay = Date.UTC(local.year, local.month - 1, local.day);
  for (let offset = 0; offset < MAX_CRON_SEARCH_DAYS; offset += 1) {
    const calendar = new Date(firstLocalDay + offset * DAY_MS);
    const year = calendar.getUTCFullYear();
    const month = calendar.getUTCMonth() + 1;
    const day = calendar.getUTCDate();
    if (!cron.month.values.has(month)) continue;
    if (!cronDayMatches(cron, day, calendar.getUTCDay())) continue;
    for (const hour of cron.hours) {
      for (const minute of cron.minutes) {
        const candidate = epochForZonedLocal(
          { year, month, day, hour, minute, second: 0 },
          timezone,
        );
        if (candidate <= fromMs) continue;
        const resolved = zonedParts(candidate, timezone);
        if (
          resolved.year === year &&
          resolved.month === month &&
          resolved.day === day &&
          resolved.hour === hour &&
          resolved.minute === minute
        ) {
          return candidate;
        }
      }
    }
  }
  return null;
}

function nextMatchingMinute(
  fromMs: number,
  timezone: string,
  accepts: (parts: ZonedParts) => boolean,
  maxMinutes: number,
): number | null {
  const start = Math.floor(fromMs / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  for (let index = 0; index <= maxMinutes; index += 1) {
    const candidate = start + index * MINUTE_MS;
    if (accepts(zonedParts(candidate, timezone))) return candidate;
  }
  return null;
}

function nextLocalTime(
  fromMs: number,
  timezone: string,
  hour: number,
  minute: number,
  acceptsWeekday: (weekday: number) => boolean,
): number | null {
  const current = zonedParts(fromMs, timezone);
  const localDay = Date.UTC(current.year, current.month - 1, current.day);
  for (let offset = 0; offset <= 370; offset += 1) {
    const calendar = new Date(localDay + offset * DAY_MS);
    const target = {
      year: calendar.getUTCFullYear(),
      month: calendar.getUTCMonth() + 1,
      day: calendar.getUTCDate(),
      hour,
      minute,
      second: 0,
    };
    const candidate = epochForZonedLocal(target, timezone);
    const resolved = zonedParts(candidate, timezone);
    if (
      candidate > fromMs &&
      resolved.year === target.year &&
      resolved.month === target.month &&
      resolved.day === target.day &&
      resolved.hour === hour &&
      resolved.minute === minute &&
      acceptsWeekday(resolved.weekday)
    ) {
      return candidate;
    }
  }
  return null;
}

function epochForZonedLocal(target: Omit<ZonedParts, 'weekday'>, timezone: string): number {
  const targetUtc = Date.UTC(
    target.year,
    target.month - 1,
    target.day,
    target.hour,
    target.minute,
    target.second,
  );
  let candidate = targetUtc;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const actual = zonedParts(candidate, timezone);
    const actualUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
    );
    const adjustment = targetUtc - actualUtc;
    if (adjustment === 0) return candidate;
    candidate += adjustment;
  }
  return candidate;
}

function zonedFormatter(timezone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timezone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  });
  if (formatterCache.size >= MAX_CACHED_FORMATTERS) {
    const oldest = formatterCache.keys().next();
    if (!oldest.done) formatterCache.delete(oldest.value);
  }
  formatterCache.set(timezone, formatter);
  return formatter;
}

function zonedParts(epochMs: number, timezone: string): ZonedParts {
  let year = Number.NaN;
  let month = Number.NaN;
  let day = Number.NaN;
  let hour = Number.NaN;
  let minute = Number.NaN;
  let second = Number.NaN;
  let weekday = '';
  for (const part of zonedFormatter(timezone).formatToParts(epochMs)) {
    switch (part.type) {
      case 'year':
        year = Number(part.value);
        break;
      case 'month':
        month = Number(part.value);
        break;
      case 'day':
        day = Number(part.value);
        break;
      case 'hour':
        hour = Number(part.value);
        break;
      case 'minute':
        minute = Number(part.value);
        break;
      case 'second':
        second = Number(part.value);
        break;
      case 'weekday':
        weekday = part.value;
        break;
      default:
        break;
    }
  }
  return { year, month, day, hour, minute, second, weekday: weekdayNumber(weekday) };
}

function weekdayNumber(value: string): number {
  switch (value.slice(0, 3).toLowerCase()) {
    case 'sun':
      return 0;
    case 'mon':
      return 1;
    case 'tue':
      return 2;
    case 'wed':
      return 3;
    case 'thu':
      return 4;
    case 'fri':
      return 5;
    case 'sat':
      return 6;
    default:
      throw new Error(`Could not resolve weekday ${value}.`);
  }
}

function parseTime(value: string): { hour: number; minute: number } {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  const hour = match ? Number(match[1]) : Number.NaN;
  const minute = match ? Number(match[2]) : Number.NaN;
  if (
    !Number.isInteger(hour) ||
    hour < 0 ||
    hour > 23 ||
    !Number.isInteger(minute) ||
    minute < 0 ||
    minute > 59
  ) {
    throw new Error(`Invalid time: ${value}`);
  }
  return { hour, minute };
}

function parseCron(expression: string): ParsedCron {
  const fields = expression.trim().split(/\s+/);
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  if (fields.length !== 5) {
    throw new Error('Cron expressions must contain five fields.');
  }
  return {
    minutes: ascendingValues(parseCronField(minute, 0, 59)),
    hours: ascendingValues(parseCronField(hour, 0, 23)),
    dayOfMonth: parseCronField(dayOfMonth, 1, 31),
    month: parseCronField(month, 1, 12),
    dayOfWeek: parseCronField(dayOfWeek, 0, 7, true),
  };
}

function parseCronField(
  source: string,
  minimum: number,
  maximum: number,
  normalizeSunday = false,
): CronField {
  const wildcard = source === '*';
  const values = new Set<number>();
  for (const segment of source.split(',')) {
    const slash = segment.indexOf('/');
    const rangeSource = slash >= 0 ? segment.slice(0, slash) : segment;
    const stepSource = slash >= 0 ? segment.slice(slash + 1) : undefined;
    const step = stepSource === undefined ? 1 : cronNumber(stepSource, segment);
    if (step <= 0) throw new Error(`Invalid cron step: ${segment}`);

    let start: number;
    let end: number;
    if (rangeSource === '*') {
      start = minimum;
      end = maximum;
    } else {
      const dash = rangeSource.indexOf('-');
      if (dash >= 0) {
        start = cronNumber(rangeSource.slice(0, dash), segment);
        end = cronNumber(rangeSource.slice(dash + 1), segment);
      } else {
        start = cronNumber(rangeSource, segment);
        end = start;
      }
    }

    if (start < minimum || end > maximum || start > end) {
      throw new Error(`Invalid cron field: ${segment}`);
    }
    for (let value = start; value <= end; value += step) {
      values.add(normalizeSunday && value === 7 ? 0 : value);
    }
  }
  return { values, wildcard };
}

function cronNumber(source: string, segment: string): number {
  if (!/^\d+$/.test(source)) throw new Error(`Invalid cron field: ${segment}`);
  const value = Number(source);
  if (!Number.isSafeInteger(value)) throw new Error(`Invalid cron field: ${segment}`);
  return value;
}

function ascendingValues(field: CronField): number[] {
  return [...field.values].sort((left, right) => left - right);
}

function cronDayMatches(cron: ParsedCron, dayOfMonth: number, weekday: number): boolean {
  const dayOfMonthMatches = cron.dayOfMonth.values.has(dayOfMonth);
  const dayOfWeekMatches = cron.dayOfWeek.values.has(weekday);
  if (cron.dayOfMonth.wildcard) return dayOfWeekMatches;
  if (cron.dayOfWeek.wildcard) return dayOfMonthMatches;
  return dayOfMonthMatches || dayOfWeekMatches;
}
