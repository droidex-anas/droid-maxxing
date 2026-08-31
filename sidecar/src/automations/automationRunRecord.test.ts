import assert from 'node:assert/strict';
import test from 'node:test';
import { projectSettledRun } from './automationRunRecord.js';
import type { Automation, AutomationRun } from './types.js';

test('a settled run that never reached a chat keeps the previous transcript link', () => {
  const automation = {
    lastAppSessionId: 'session-previous',
    lastRunAt: 1,
    lastRunStatus: 'completed',
    lastRunError: null,
    lastRunDurationMs: 10,
    updatedAt: 1,
  } as Automation;
  const run = {
    appSessionId: null,
    startedAt: null,
    status: 'failed',
    error: 'DROIDEX did not create the automation chat before the startup timeout.',
  } as AutomationRun;

  projectSettledRun(automation, run, 50);

  assert.equal(automation.lastAppSessionId, 'session-previous');
  assert.equal(automation.lastRunStatus, 'failed');
});
