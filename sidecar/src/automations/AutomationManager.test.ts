import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ClientCommand, ServerEvent } from '../protocol.js';
import { AutomationManager } from './AutomationManager.js';
import type { AutomationInput } from './types.js';

type SessionCreate = Extract<ClientCommand, { type: 'session.create' }>;

function task(overrides: Partial<AutomationInput> = {}): AutomationInput {
  return {
    title: 'Task',
    prompt: 'Do the task.',
    enabled: true,
    schedule: { kind: 'daily', time: '23:59' },
    timezone: 'UTC',
    modelId: 'model-a',
    reasoningEffort: 'high',
    ...overrides,
  };
}

test('a run launches a chat and completes only after the turn settles', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'droidex-automations-'));
  const launches: SessionCreate[] = [];
  const manager = new AutomationManager({
    dataDir: directory,
    emit: () => undefined,
    prepareWorkspace: async ({ cwd }) => cwd ?? '',
    launchSession: async (command) => {
      launches.push(command);
    },
  });

  try {
    const automation = await manager.create(task());
    await manager.runNow(automation.id);
    await waitFor(() => launches.length === 1);
    const launch = launches[0];
    if (!launch) throw new Error('Expected an automation session launch.');
    assert.equal(launch.autonomy, 'low');
    await manager.observeSessionEvent({
      type: 'session.created',
      clientRef: launch.clientRef,
      session: { appSessionId: 'session-a' },
    } as ServerEvent);
    await manager.observeSessionEvent({
      type: 'session.updated',
      session: { appSessionId: 'session-a', streaming: true },
    } as ServerEvent);
    await manager.observeSessionEvent({
      type: 'session.updated',
      session: { appSessionId: 'session-a', streaming: false },
    } as ServerEvent);
    await waitFor(async () => (await manager.snapshot()).runs[0]?.status === 'completed');
    assert.equal((await manager.snapshot()).runs[0]?.status, 'completed');
  } finally {
    await manager.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

test('closing a chat while it is still streaming fails the run', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'droidex-automations-'));
  const launches: SessionCreate[] = [];
  const manager = new AutomationManager({
    dataDir: directory,
    emit: () => undefined,
    prepareWorkspace: async ({ cwd }) => cwd ?? '',
    launchSession: async (command) => {
      launches.push(command);
    },
  });

  try {
    const automation = await manager.create(task());
    await manager.runNow(automation.id);
    await waitFor(() => launches.length === 1);
    const launch = launches[0];
    if (!launch) throw new Error('Expected an automation session launch.');
    await manager.observeSessionEvent({
      type: 'session.created',
      clientRef: launch.clientRef,
      session: { appSessionId: 'session-mid-stream' },
    } as ServerEvent);
    await manager.observeSessionEvent({
      type: 'session.updated',
      session: { appSessionId: 'session-mid-stream', streaming: true },
    } as ServerEvent);
    await manager.observeSessionEvent({
      type: 'session.closed',
      appSessionId: 'session-mid-stream',
    } as ServerEvent);
    await waitFor(async () => (await manager.snapshot()).runs[0]?.status === 'failed');
    assert.match(
      (await manager.snapshot()).runs[0]?.error ?? '',
      /closed before its turn finished/,
    );
  } finally {
    await manager.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

test('one automation cannot stack a second open run', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'droidex-automations-'));
  const launches: SessionCreate[] = [];
  let clock = Date.UTC(2026, 0, 1, 8, 0, 0);
  const dueAt = clock + 60_000;
  const manager = new AutomationManager({
    dataDir: directory,
    emit: () => undefined,
    prepareWorkspace: async ({ cwd }) => cwd ?? '',
    launchSession: async (command) => {
      launches.push(command);
    },
    now: () => clock,
    schedulerRecheckMs: 5,
  });

  try {
    const automation = await manager.create(
      task({ schedule: { kind: 'once', runAt: dueAt }, title: 'Once report' }),
    );
    await manager.runNow(automation.id);
    await manager.runNow(automation.id);
    await waitFor(() => launches.length === 1);
    const launch = launches[0];
    if (!launch) throw new Error('Expected a manual automation launch.');
    await manager.observeSessionEvent({
      type: 'session.created',
      clientRef: launch.clientRef,
      session: { appSessionId: 'session-once' },
    } as ServerEvent);
    await manager.observeSessionEvent({
      type: 'session.updated',
      session: { appSessionId: 'session-once', streaming: true },
    } as ServerEvent);
    clock = dueAt + 1_000;
    await new Promise((resolve) => setTimeout(resolve, 40));
    const snapshot = await manager.snapshot();
    assert.equal(launches.length, 1);
    assert.equal(snapshot.queuedRunCount, 0);
  } finally {
    await manager.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

test('an enabled one-time schedule cannot be backdated', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'droidex-automations-'));
  const manager = new AutomationManager({
    dataDir: directory,
    emit: () => undefined,
    prepareWorkspace: async ({ cwd }) => cwd ?? '',
    launchSession: async () => undefined,
  });

  try {
    await assert.rejects(
      manager.create(task({ schedule: { kind: 'once', runAt: Date.now() - 1_000 } })),
      /future date and time/i,
    );
    assert.equal((await manager.snapshot()).automations.length, 0);
  } finally {
    await manager.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

test('ordinary chat transcript appends do not persist an automation snapshot', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'droidex-automations-'));
  const published: string[] = [];
  const manager = new AutomationManager({
    dataDir: directory,
    emit: (event) => {
      published.push(event.type);
    },
    prepareWorkspace: async ({ cwd }) => cwd ?? '',
    launchSession: async () => undefined,
  });

  try {
    await manager.snapshot();
    published.length = 0;
    await manager.observeSessionEvent({
      type: 'event.appended',
      event: {
        id: 'token-1',
        appSessionId: 'ordinary-chat',
        sourceSessionId: 'ordinary-chat',
        role: 'primary',
        ts: Date.now(),
        kind: 'text',
        text: 'streaming',
      },
    } as ServerEvent);
    assert.deepEqual(published, []);
  } finally {
    await manager.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

test('direct creation requires High autonomy', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'droidex-automations-'));
  const manager = new AutomationManager({
    dataDir: directory,
    emit: () => undefined,
    prepareWorkspace: async ({ cwd }) => cwd ?? '',
    launchSession: async () => undefined,
    resolveSessionContext: async () => ({
      cwd: '/repo',
      modelId: 'chat-model',
      reasoningEffort: 'high',
      autonomy: 'low',
    }),
  });

  try {
    await assert.rejects(
      manager.createFromSession(task({ timezone: 'UTC' }), 'chat'),
      /High autonomy/i,
    );
  } finally {
    await manager.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

test('unknown automations commands fail instead of succeeding empty', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'droidex-automations-'));
  const results: Array<{ ok: boolean; error?: string }> = [];
  const manager = new AutomationManager({
    dataDir: directory,
    emit: (event) => {
      if (event.type === 'automations.result') results.push(event);
    },
    prepareWorkspace: async ({ cwd }) => cwd ?? '',
    launchSession: async () => undefined,
  });

  try {
    const handled = await manager.handleBridgeCommand({
      type: 'automations.dismissProposal',
      requestId: 'req-unknown',
      id: 'proposal-1',
    });
    assert.equal(handled, true);
    assert.equal(results[0]?.ok, false);
    assert.match(results[0]?.error ?? '', /Unknown automations command/);
  } finally {
    await manager.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 1_500,
): Promise<void> {
  const startedAt = Date.now();
  while (!(await predicate())) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('Timed out waiting for condition.');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
