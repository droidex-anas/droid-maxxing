import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AUTOMATION_LINK_ORIGIN,
  automationDraftFromLink,
  formatSchedule,
  nextAutomationRun,
  parseLocalDateTime,
  toLocalDateTimeInput,
} from './schedule';

test('automation setup links resolve the current workspace', () => {
  const url = new URL('/automation/new', AUTOMATION_LINK_ORIGIN);
  url.searchParams.set('title', 'Daily review');
  url.searchParams.set('prompt', 'Review open pull requests.');
  url.searchParams.set('frequency', 'daily');
  url.searchParams.set('time', '09:00');
  url.searchParams.set('workspace', 'current');
  url.searchParams.set('isolated', '1');

  assert.deepEqual(automationDraftFromLink(url.toString(), '/repo'), {
    title: 'Daily review',
    prompt: 'Review open pull requests.',
    workspaceCwd: '/repo',
    executionMode: 'worktree',
    enabled: true,
    schedule: { kind: 'daily', time: '09:00' },
  });
});

test('automation setup links reject unrelated origins', () => {
  assert.equal(
    automationDraftFromLink(
      'https://example.com/automation/new?title=x&prompt=y&frequency=hourly&minute=0',
      '/repo',
    ),
    null,
  );
});

test('weekly links accept weekday names', () => {
  const url = new URL('/automation/new', AUTOMATION_LINK_ORIGIN);
  url.searchParams.set('title', 'Weekly review');
  url.searchParams.set('prompt', 'Summarize this week.');
  url.searchParams.set('frequency', 'weekly');
  url.searchParams.set('weekday', 'Friday');
  url.searchParams.set('time', '16:00');
  url.searchParams.set('workspace', 'none');

  assert.equal(automationDraftFromLink(url.toString(), '/repo')?.schedule.kind, 'weekly');
  assert.equal(formatSchedule({ kind: 'weekly', weekday: 5, time: '16:00' }).startsWith('Friday'), true);
});

test('local datetime inputs round-trip to the same minute', () => {
  const original = new Date(2026, 7, 20, 9, 25, 0, 0).getTime();
  assert.equal(parseLocalDateTime(toLocalDateTimeInput(original)), original);
});


test('next run previews daily and weekday schedules without polling', () => {
  const thursdayMorning = new Date(2026, 7, 20, 8, 30, 0, 0).getTime();
  assert.equal(
    nextAutomationRun({ kind: 'daily', time: '09:00' }, thursdayMorning),
    new Date(2026, 7, 20, 9, 0, 0, 0).getTime(),
  );

  const fridayEvening = new Date(2026, 7, 21, 18, 0, 0, 0).getTime();
  assert.equal(
    nextAutomationRun({ kind: 'weekdays', time: '09:00' }, fridayEvening),
    new Date(2026, 7, 24, 9, 0, 0, 0).getTime(),
  );
});
