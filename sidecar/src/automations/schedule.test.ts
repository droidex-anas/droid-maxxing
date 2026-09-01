import assert from 'node:assert/strict';
import test from 'node:test';
import { nextAutomationRun } from './schedule.js';

test('daily schedules use their selected timezone across a daylight saving change', () => {
  const from = Date.UTC(2026, 7, 20, 2, 0, 0);
  assert.equal(
    nextAutomationRun({ kind: 'daily', time: '09:00' }, 'Asia/Kolkata', from),
    Date.UTC(2026, 7, 20, 3, 30, 0),
  );
  // 02:30 does not exist on March 8 in New York, so that day has no run.
  assert.equal(
    nextAutomationRun(
      { kind: 'daily', time: '02:30' },
      'America/New_York',
      Date.UTC(2026, 2, 7, 20, 0, 0),
    ),
    Date.UTC(2026, 2, 9, 6, 30, 0),
  );
});

test('cron returns null for a calendar date that never occurs', () => {
  const next = nextAutomationRun(
    { kind: 'cron', expression: '0 0 30 2 *' },
    'Asia/Kolkata',
    Date.UTC(2024, 2, 1, 12, 0, 0),
  );
  assert.equal(next, null);
});
