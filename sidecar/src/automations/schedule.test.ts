import assert from 'node:assert/strict';
import test from 'node:test';
import { createAutomationRecord, normalizeAutomationInput } from './automationInput.js';
import { AutomationScheduler } from './automationScheduler.js';
import { nextAutomationRun } from './schedule.js';
import type { AutomationStore } from './types.js';

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

test('scheduler backs off after a due-store write fails', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let clock = 1_000;
  const automation = createAutomationRecord(
    normalizeAutomationInput({
      title: 'Task',
      prompt: 'Do the task.',
      enabled: true,
      schedule: { kind: 'once', runAt: 2_000 },
      timezone: 'UTC',
      modelId: 'model-a',
      reasoningEffort: 'high',
    }),
    clock,
  );
  const store: AutomationStore = {
    version: 1,
    automations: [automation],
    runs: [],
    proposals: [],
    sessionOrigins: {},
  };
  let flushes = 0;
  const scheduler = new AutomationScheduler({
    store: () => store,
    now: () => clock,
    isClosed: () => false,
    runs: { queueScheduled: () => undefined, startQueued: () => undefined },
    flushDue: () => {
      flushes += 1;
      return Promise.reject(new Error('disk unavailable'));
    },
    recheckMs: 100,
  });
  context.mock.method(console, 'error', () => undefined);
  try {
    clock = 2_000;
    scheduler.arm();
    context.mock.timers.tick(0);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(flushes, 1);

    context.mock.timers.tick(99);
    assert.equal(flushes, 1);
    context.mock.timers.tick(1);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(flushes, 2);
  } finally {
    scheduler.stop();
  }
});
