import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createAutomationRecord, normalizeAutomationInput } from './automationInput.js';
import { newQueuedRun } from './automationRunRecord.js';
import {
  AutomationStoreFile,
  emptyAutomationStore,
  parseAutomationStore,
  storeHasRunSession,
  trimAutomationStore,
} from './automationStore.js';

test('a store written by another version is refused instead of guessed at', () => {
  assert.throws(
    () => parseAutomationStore({ version: 2, automations: [], runs: [] }, Date.now()),
    /Unsupported automations store version 2/,
  );
});

test('invalid stored records are dropped and logged', () => {
  const messages: string[] = [];
  const original = console.error;
  console.error = (message?: unknown) => {
    messages.push(String(message));
  };
  try {
    const store = parseAutomationStore(
      {
        version: 1,
        automations: [
          {
            id: 'automation-1',
            title: '',
            prompt: 'Do the task.',
            schedule: { kind: 'daily', time: '23:59' },
          },
        ],
        runs: [],
        proposals: [
          {
            id: 'proposal-1',
            sourceAppSessionId: 'session-1',
            draft: {
              title: '',
              prompt: 'Do the task.',
              schedule: { kind: 'daily', time: '23:59' },
            },
          },
        ],
      },
      Date.now(),
    );
    assert.deepEqual(store.automations, []);
    assert.deepEqual(store.proposals, []);
    assert.deepEqual(messages, [
      'Dropped an invalid automation record',
      'Dropped an invalid automation proposal',
    ]);
  } finally {
    console.error = original;
  }
});

test('trim keeps a review worktree until its chat origin is dropped', () => {
  const now = Date.now();
  const busy = createAutomationRecord(
    normalizeAutomationInput({
      title: 'Busy',
      prompt: 'Do the task.',
      enabled: false,
      schedule: { kind: 'daily', time: '23:59' },
      timezone: 'UTC',
      modelId: 'model-a',
      reasoningEffort: 'high',
    }),
    now,
  );
  const isolated = createAutomationRecord(
    normalizeAutomationInput({
      title: 'Isolated',
      prompt: 'Do the task.',
      workspaceCwd: '/repo',
      executionMode: 'worktree',
      enabled: false,
      schedule: { kind: 'daily', time: '23:59' },
      timezone: 'UTC',
      modelId: 'model-a',
      reasoningEffort: 'high',
    }),
    now,
  );
  const store = emptyAutomationStore();
  const runs = [];
  for (let index = 0; index < 160; index += 1) {
    const run = newQueuedRun(busy, now + index, now + index, 'manual');
    run.status = 'completed';
    run.finishedAt = now + index;
    runs.push(run);
  }
  const review = newQueuedRun(isolated, now, now, 'manual');
  review.status = 'completed';
  review.finishedAt = now;
  review.appSessionId = 'session-review';
  review.resolvedCwd = '/repo/.worktrees/isolated/repo';
  runs.push(review);
  store.runs = runs;
  store.sessionOrigins['session-review'] = {
    automationId: isolated.id,
    automationTitle: isolated.title,
    runId: review.id,
    trigger: 'manual',
  };
  for (let index = 0; index < 210; index += 1) {
    store.sessionOrigins[`old-${String(index)}`] = {
      automationId: busy.id,
      automationTitle: busy.title,
      runId: `old-run-${String(index)}`,
      trigger: 'manual',
    };
  }

  trimAutomationStore(store);

  assert.equal(
    store.runs.some((run) => run.id === review.id),
    true,
  );
  assert.ok(store.sessionOrigins['session-review']);
});

test('trim keeps the origin of an in-flight run', () => {
  const now = Date.now();
  const automation = createAutomationRecord(
    normalizeAutomationInput({
      title: 'Task',
      prompt: 'Do the task.',
      enabled: false,
      schedule: { kind: 'daily', time: '23:59' },
      timezone: 'UTC',
      modelId: 'model-a',
      reasoningEffort: 'high',
    }),
    now,
  );
  const store = emptyAutomationStore();
  const run = newQueuedRun(automation, now, now, 'manual');
  run.status = 'running';
  run.appSessionId = 'session-live';
  store.runs = [run];
  store.sessionOrigins['session-live'] = {
    automationId: automation.id,
    automationTitle: automation.title,
    runId: run.id,
    trigger: 'manual',
  };
  for (let index = 0; index < 210; index += 1) {
    store.sessionOrigins[`old-${String(index)}`] = {
      automationId: automation.id,
      automationTitle: automation.title,
      runId: `old-run-${String(index)}`,
      trigger: 'manual',
    };
  }

  trimAutomationStore(store);

  assert.ok(store.sessionOrigins['session-live']);
});

test('a run session is still recognized after its origin record is dropped', () => {
  const now = Date.now();
  const store = emptyAutomationStore();
  const automation = createAutomationRecord(
    normalizeAutomationInput({
      title: 'Task',
      prompt: 'Do the task.',
      enabled: false,
      schedule: { kind: 'daily', time: '23:59' },
      timezone: 'UTC',
      modelId: 'model-a',
      reasoningEffort: 'high',
    }),
    now,
  );
  store.sessionOrigins['from-origin'] = {
    automationId: automation.id,
    automationTitle: automation.title,
    runId: 'run-1',
    trigger: 'manual',
  };
  assert.equal(storeHasRunSession(store, 'from-origin'), true);
  store.sessionOrigins = {};
  const run = newQueuedRun(automation, now, now, 'manual');
  run.appSessionId = 'from-run';
  store.runs = [run];
  assert.equal(storeHasRunSession(store, 'from-run'), true);
  store.runs = [];
  automation.lastAppSessionId = 'from-last';
  store.automations = [automation];
  assert.equal(storeHasRunSession(store, 'from-last'), true);
  assert.equal(storeHasRunSession(store, 'ordinary-chat'), false);
});

test('an unreadable store is quarantined with a recoverable path', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'droidex-store-'));
  const filePath = join(directory, 'automations.json');
  await writeFile(filePath, '{ not json', 'utf8');
  const store = new AutomationStoreFile(filePath);

  try {
    await assert.rejects(store.read(1_700_000_000_000), /unreadable-1700000000000/);
    const entries = await readdir(directory);
    assert.deepEqual(entries, ['automations.json.unreadable-1700000000000']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
