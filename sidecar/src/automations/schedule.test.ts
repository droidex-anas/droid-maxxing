import assert from 'node:assert/strict';
import test from 'node:test';
import { nextAutomationRun } from './schedule.js';

test('daily schedules use their selected timezone', () => {
  const from = Date.UTC(2026, 7, 20, 2, 0, 0);
  const next = nextAutomationRun({ kind: 'daily', time: '09:00' }, 'Asia/Kolkata', from);
  assert.equal(next, Date.UTC(2026, 7, 20, 3, 30, 0));
});

test('weekdays skip weekends in the selected timezone', () => {
  const fridayEvening = Date.UTC(2026, 7, 21, 13, 0, 0);
  const next = nextAutomationRun(
    { kind: 'weekdays', time: '09:00' },
    'Asia/Kolkata',
    fridayEvening,
  );
  assert.equal(next, Date.UTC(2026, 7, 24, 3, 30, 0));
});

test('a daily time keeps its wall clock across a daylight saving change', () => {
  const beforeSpringForward = Date.UTC(2026, 2, 7, 20, 0, 0);
  const schedule = { kind: 'daily', time: '09:00' } as const;
  // 09:00 in New York is 14:00 UTC on standard time and 13:00 UTC on summer
  // time, so the same wall clock has to move by an hour, not stay put.
  const firstRun = nextAutomationRun(schedule, 'America/New_York', beforeSpringForward);
  assert.equal(firstRun, Date.UTC(2026, 2, 8, 13, 0, 0));
  assert.equal(
    nextAutomationRun(schedule, 'America/New_York', Date.UTC(2026, 2, 7, 10, 0, 0)),
    Date.UTC(2026, 2, 7, 14, 0, 0),
  );
  assert.equal(
    nextAutomationRun(schedule, 'America/New_York', firstRun as number),
    Date.UTC(2026, 2, 9, 13, 0, 0),
  );
});

test('a daily time repeated by daylight saving runs once', () => {
  // Clocks go back at 02:00, so 01:30 in New York happens twice on November 1.
  const firstOccurrence = Date.UTC(2026, 10, 1, 5, 30, 0);
  const schedule = { kind: 'daily', time: '01:30' } as const;
  assert.equal(
    nextAutomationRun(schedule, 'America/New_York', Date.UTC(2026, 9, 31, 16, 0, 0)),
    firstOccurrence,
  );
  // The repeat an hour later is the same wall clock, so the run moves to the
  // next day instead of firing twice.
  assert.equal(
    nextAutomationRun(schedule, 'America/New_York', firstOccurrence),
    Date.UTC(2026, 10, 2, 6, 30, 0),
  );
});

test('a daily time that daylight saving removes waits for the next day', () => {
  // 02:30 does not exist on March 8 in New York, so that day has no run.
  const next = nextAutomationRun(
    { kind: 'daily', time: '02:30' },
    'America/New_York',
    Date.UTC(2026, 2, 7, 20, 0, 0),
  );
  assert.equal(next, Date.UTC(2026, 2, 9, 6, 30, 0));
});

test('hourly schedules match the minute in their own timezone', () => {
  // Kolkata runs 5:30 ahead, so local :15 is :45 in UTC.
  const next = nextAutomationRun(
    { kind: 'hourly', minute: 15 },
    'Asia/Kolkata',
    Date.UTC(2026, 0, 1, 10, 0, 0),
  );
  assert.equal(next, Date.UTC(2026, 0, 1, 10, 45, 0));
});

test('cron supports ranges and steps', () => {
  const from = Date.UTC(2026, 7, 20, 3, 0, 0);
  const next = nextAutomationRun(
    { kind: 'cron', expression: '*/15 9 * * 1-5' },
    'Asia/Kolkata',
    from,
  );
  assert.equal(next, Date.UTC(2026, 7, 20, 3, 30, 0));
});

test('cron finds the next February 29 after a leap day has passed', () => {
  const afterLeapDay = Date.UTC(2024, 2, 1, 12, 0, 0);
  const next = nextAutomationRun(
    { kind: 'cron', expression: '0 0 29 2 *' },
    'Asia/Kolkata',
    afterLeapDay,
  );
  assert.equal(next, Date.UTC(2028, 1, 28, 18, 30, 0));
});

test('cron crosses a skipped century leap year', () => {
  const from = Date.UTC(2096, 2, 1, 12, 0, 0);
  const next = nextAutomationRun({ kind: 'cron', expression: '0 0 29 2 *' }, 'Asia/Kolkata', from);
  assert.equal(next, Date.UTC(2104, 1, 28, 18, 30, 0));
});

test('cron returns null for a calendar date that never occurs', () => {
  const from = Date.UTC(2024, 2, 1, 12, 0, 0);
  const next = nextAutomationRun({ kind: 'cron', expression: '0 0 30 2 *' }, 'Asia/Kolkata', from);
  assert.equal(next, null);
});

test('cron skips a local time that daylight saving removes', () => {
  const beforeSpringForward = Date.UTC(2026, 2, 8, 6, 0, 0);
  const next = nextAutomationRun(
    { kind: 'cron', expression: '30 2 * * *' },
    'America/New_York',
    beforeSpringForward,
  );
  assert.equal(next, Date.UTC(2026, 2, 9, 6, 30, 0));
});

test('cron rejects empty segments and steps', () => {
  for (const expression of ['0 0 * * ,1', '0 0 * * 1,', '*/ 0 * * *', '0 0 , * *', '0 0 1- * *']) {
    assert.throws(
      () => nextAutomationRun({ kind: 'cron', expression }, 'UTC', Date.UTC(2026, 0, 1)),
      /Invalid cron field/,
      `expected ${expression} to be rejected`,
    );
  }
});

test('sparse and impossible cron expressions resolve without scanning minutes', () => {
  const from = Date.UTC(2024, 2, 1, 12, 0, 0);
  const startedAt = performance.now();
  nextAutomationRun({ kind: 'cron', expression: '0 0 29 2 *' }, 'Asia/Kolkata', from);
  nextAutomationRun({ kind: 'cron', expression: '0 0 30 2 *' }, 'Asia/Kolkata', from);
  const elapsedMs = performance.now() - startedAt;
  assert.ok(elapsedMs < 250, `next-run search took ${elapsedMs.toFixed(1)}ms`);
});
