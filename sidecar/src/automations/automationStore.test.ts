import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  AutomationStoreFile,
  emptyAutomationStore,
  parseAutomationStore,
  STORE_VERSION,
  trimAutomationStore,
} from './automationStore.js';
import type { AutomationRun, AutomationRunStatus, AutomationStore } from './types.js';

test('a store written by another version is refused instead of guessed at', () => {
  assert.throws(
    () => parseAutomationStore({ version: 2, automations: [], runs: [] }, Date.now()),
    /Unsupported automations store version 2/,
  );
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

test('a missing store starts empty without writing anything', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'droidex-store-'));
  const store = new AutomationStoreFile(join(directory, 'automations.json'));

  try {
    assert.deepEqual(await store.read(Date.now()), emptyAutomationStore());
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('queued writes collapse to the newest state and leave no temporary files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'droidex-store-'));
  const filePath = join(directory, 'automations.json');
  const store = new AutomationStoreFile(filePath);

  try {
    const first = { ...emptyAutomationStore(), sessionOrigins: {} } satisfies AutomationStore;
    const second: AutomationStore = {
      ...emptyAutomationStore(),
      sessionOrigins: {
        'session-b': {
          automationId: 'a',
          automationTitle: 'Second',
          runId: 'r',
          trigger: 'manual',
        },
      },
    };
    await Promise.all([store.write(first), store.write(second)]);
    await store.flush();
    const written: unknown = JSON.parse(await readFile(filePath, 'utf8'));
    assert.deepEqual(written, second);
    assert.deepEqual(await readdir(directory), ['automations.json']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('retention drops old history but never live runs or an automation last result', () => {
  const store = emptyAutomationStore();
  store.automations = [automation('busy'), automation('quiet')];
  for (let index = 0; index < 300; index += 1) {
    store.runs.push(run(`old-${String(index)}`, 'busy', 'completed', index));
  }
  store.runs.push(run('quiet-latest', 'quiet', 'completed', 500));
  store.runs.push(run('busy-latest', 'busy', 'failed', 600));
  store.runs.push(run('queued', 'busy', 'queued', 700));
  store.runs.push(run('running', 'quiet', 'running', 800));

  trimAutomationStore(store);

  const ids = new Set(store.runs.map((candidate) => candidate.id));
  assert.ok(store.runs.length <= 150);
  assert.ok(ids.has('queued'));
  assert.ok(ids.has('running'));
  assert.ok(ids.has('busy-latest'));
  assert.ok(ids.has('quiet-latest'));
});

test('runs whose automation was deleted are dropped when the store is read', () => {
  const now = Date.now();
  const parsed = parseAutomationStore(
    {
      version: STORE_VERSION,
      automations: [automation('kept')],
      runs: [run('orphan', 'gone', 'completed', 1), run('kept-run', 'kept', 'completed', 2)],
      proposals: [],
      sessionOrigins: {},
    },
    now,
  );
  assert.deepEqual(
    parsed.runs.map((candidate) => candidate.id),
    ['kept-run'],
  );
});

function automation(id: string): AutomationStore['automations'][number] {
  const now = 1_000;
  return {
    id,
    title: `Automation ${id}`,
    prompt: 'Do the work.',
    workspaceCwd: null,
    executionMode: 'local',
    enabled: false,
    schedule: { kind: 'daily', time: '09:00' },
    timezone: 'UTC',
    modelId: 'model-a',
    reasoningEffort: 'high',
    autonomy: 'low',
    nextRunAt: null,
    lastRunAt: null,
    lastRunStatus: null,
    lastRunError: null,
    lastRunDurationMs: null,
    lastAppSessionId: null,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

function run(
  id: string,
  automationId: string,
  status: AutomationRunStatus,
  requestedAt: number,
): AutomationRun {
  return {
    id,
    automationId,
    automation: {
      id: automationId,
      title: `Automation ${automationId}`,
      prompt: 'Do the work.',
      workspaceCwd: null,
      executionMode: 'local',
      timezone: 'UTC',
      modelId: 'model-a',
      reasoningEffort: 'high',
      autonomy: 'low',
    },
    scheduledAt: requestedAt,
    requestedAt,
    trigger: 'manual',
    status,
    startedAt: null,
    finishedAt: null,
    clientRef: null,
    appSessionId: null,
    resolvedCwd: null,
    error: null,
    effectiveModelId: null,
    effectiveReasoningEffort: null,
    selectionVerified: null,
  };
}
