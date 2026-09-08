import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ClientCommand, ServerEvent } from '../protocol.js';
import { AutomationManager } from './AutomationManager.js';
import type { AutomationInput } from './types.js';

type SessionCreate = Extract<ClientCommand, { type: 'session.create' }>;

type ManagerOptions = ConstructorParameters<typeof AutomationManager>[0];

function createManager(dataDir: string, options: Partial<ManagerOptions> = {}): AutomationManager {
  return new AutomationManager({
    dataDir,
    turnSettleGraceMs: 80,
    emit: () => undefined,
    prepareWorkspace: async ({ cwd }) => cwd ?? '',
    launchSession: async () => undefined,
    ...options,
  });
}

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

test('a run that resumes during settle grace stays open until the next turn ends', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'droidex-automations-'));
  const launches: SessionCreate[] = [];
  const manager = createManager(directory, {
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
      session: { appSessionId: 'session-grace' },
    } as ServerEvent);
    await manager.observeSessionEvent({
      type: 'session.updated',
      session: { appSessionId: 'session-grace', streaming: true },
    } as ServerEvent);
    await manager.observeSessionEvent({
      type: 'session.updated',
      session: { appSessionId: 'session-grace', streaming: false },
    } as ServerEvent);
    assert.equal((await manager.snapshot()).runs[0]?.status, 'running');
    await manager.observeSessionEvent({
      type: 'event.appended',
      event: {
        id: 'token-grace',
        appSessionId: 'session-grace',
        sourceSessionId: 'session-grace',
        role: 'primary',
        ts: Date.now(),
        kind: 'text',
        text: 'still working',
      },
    } as ServerEvent);
    await waitWhile(async () => (await manager.snapshot()).runs[0]?.status === 'running', 120);
    await manager.observeSessionEvent({
      type: 'session.updated',
      session: { appSessionId: 'session-grace', streaming: false },
    } as ServerEvent);
    await waitFor(async () => (await manager.snapshot()).runs[0]?.status === 'completed');
    assert.equal((await manager.snapshot()).runs[0]?.status, 'completed');
  } finally {
    await manager.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a run still settles when turn events arrive during session adopt', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'droidex-automations-'));
  const launches: SessionCreate[] = [];
  const manager = createManager(directory, {
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
    const created = manager.observeSessionEvent({
      type: 'session.created',
      clientRef: launch.clientRef,
      session: { appSessionId: 'session-race' },
    } as ServerEvent);
    const appended = manager.observeSessionEvent({
      type: 'event.appended',
      event: {
        id: 'token-race',
        appSessionId: 'session-race',
        sourceSessionId: 'session-race',
        role: 'primary',
        ts: Date.now(),
        kind: 'text',
        text: 'working',
      },
    } as ServerEvent);
    const settled = manager.observeSessionEvent({
      type: 'session.updated',
      session: { appSessionId: 'session-race', streaming: false },
    } as ServerEvent);
    await Promise.all([created, appended, settled]);
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
  const manager = createManager(directory, {
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
  const manager = createManager(directory, {
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
  const manager = createManager(directory, {});

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
  const manager = createManager(directory, {
    emit: (event) => {
      published.push(event.type);
    },
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

test('a failed adoption write closes the unowned automation chat', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'droidex-automations-'));
  const launches: SessionCreate[] = [];
  const closed: string[] = [];
  const manager = createManager(directory, {
    launchSession: async (command) => {
      launches.push(command);
    },
    closeSession: async (appSessionId) => {
      closed.push(appSessionId);
    },
  });

  try {
    const automation = await manager.create(task());
    await manager.runNow(automation.id);
    await waitFor(() => launches.length === 1);
    const launch = launches[0];
    if (!launch) throw new Error('Expected an automation session launch.');
    await chmod(directory, 0o555);
    context.mock.method(console, 'error', () => undefined);
    await manager.observeSessionEvent({
      type: 'session.created',
      clientRef: launch.clientRef,
      session: { appSessionId: 'session-orphan' },
    } as ServerEvent);
    assert.deepEqual(closed, ['session-orphan']);
    assert.equal((await manager.snapshot()).runs[0]?.status, 'starting');
    assert.equal((await manager.snapshot()).sessionOrigins['session-orphan'], undefined);
  } finally {
    await chmod(directory, 0o755).catch(() => undefined);
    await manager.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a completed run keeps its worktree until the review chat closes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'droidex-automations-'));
  const worktree = join(directory, 'worktree');
  const launches: SessionCreate[] = [];
  const released: string[] = [];
  const manager = createManager(directory, {
    prepareWorkspace: async () => worktree,
    launchSession: async (command) => {
      launches.push(command);
    },
    releaseWorkspace: async ({ resolvedCwd }) => {
      if (resolvedCwd) released.push(resolvedCwd);
    },
  });

  try {
    const automation = await manager.create(
      task({ executionMode: 'worktree', workspaceCwd: directory }),
    );
    await manager.runNow(automation.id);
    await waitFor(() => launches.length === 1);
    const launch = launches[0];
    if (!launch) throw new Error('Expected an automation session launch.');
    await manager.observeSessionEvent({
      type: 'session.created',
      clientRef: launch.clientRef,
      session: { appSessionId: 'session-review' },
    } as ServerEvent);
    await manager.observeSessionEvent({
      type: 'session.updated',
      session: { appSessionId: 'session-review', streaming: true },
    } as ServerEvent);
    await manager.observeSessionEvent({
      type: 'session.updated',
      session: { appSessionId: 'session-review', streaming: false },
    } as ServerEvent);
    await waitFor(async () => (await manager.snapshot()).runs[0]?.status === 'completed');
    assert.equal(released.length, 0);
    assert.ok((await manager.snapshot()).sessionOrigins['session-review']);
    await assert.rejects(manager.remove(automation.id), /review chat/i);
    await manager.observeSessionEvent({
      type: 'session.closed',
      appSessionId: 'session-review',
    } as ServerEvent);
    await waitFor(() => released.includes(worktree));
    assert.deepEqual(released, [worktree]);
    assert.equal((await manager.snapshot()).sessionOrigins['session-review'], undefined);
    await manager.remove(automation.id);
    assert.equal((await manager.snapshot()).automations.length, 0);
  } finally {
    await manager.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

test('review-chat close releases its worktree when the origin write fails', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'droidex-automations-'));
  const worktree = join(directory, 'worktree');
  const launches: SessionCreate[] = [];
  const released: string[] = [];
  const manager = createManager(directory, {
    turnSettleGraceMs: 20,
    prepareWorkspace: async () => worktree,
    launchSession: async (command) => {
      launches.push(command);
    },
    releaseWorkspace: async ({ resolvedCwd }) => {
      if (resolvedCwd) released.push(resolvedCwd);
    },
  });

  try {
    const automation = await manager.create(
      task({ executionMode: 'worktree', workspaceCwd: directory }),
    );
    await manager.runNow(automation.id);
    await waitFor(() => launches.length === 1);
    const launch = launches[0];
    if (!launch) throw new Error('Expected an automation session launch.');
    await manager.observeSessionEvent({
      type: 'session.created',
      clientRef: launch.clientRef,
      session: { appSessionId: 'session-review-write-failure' },
    } as ServerEvent);
    await manager.observeSessionEvent({
      type: 'session.updated',
      session: { appSessionId: 'session-review-write-failure', streaming: true },
    } as ServerEvent);
    await manager.observeSessionEvent({
      type: 'session.updated',
      session: { appSessionId: 'session-review-write-failure', streaming: false },
    } as ServerEvent);
    const storePath = join(directory, 'automations.json');
    await waitFor(async () => {
      const store = JSON.parse(await readFile(storePath, 'utf8')) as {
        runs: Array<{ status: string }>;
      };
      return store.runs[0]?.status === 'completed';
    });

    await chmod(directory, 0o555);
    await assert.rejects(
      manager.observeSessionEvent({
        type: 'session.closed',
        appSessionId: 'session-review-write-failure',
      } as ServerEvent),
    );
    assert.deepEqual(released, [worktree]);
  } finally {
    await chmod(directory, 0o755).catch(() => undefined);
    await manager.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

test('an isolated worktree is not created until its path is persisted', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'droidex-automations-'));
  const worktree = join(directory, 'worktree');
  const events: string[] = [];
  const manager = createManager(directory, {
    prepareWorkspace: async () => {
      events.push('resolve');
      return worktree;
    },
    createWorkspace: async () => {
      const store = JSON.parse(await readFile(join(directory, 'automations.json'), 'utf8')) as {
        runs: Array<{ resolvedCwd: string | null }>;
      };
      assert.equal(store.runs[0]?.resolvedCwd, worktree);
      events.push('create');
    },
    launchSession: async () => {
      events.push('launch');
    },
  });

  try {
    const automation = await manager.create(
      task({ executionMode: 'worktree', workspaceCwd: directory }),
    );
    await manager.runNow(automation.id);
    await waitFor(() => events.includes('launch'));
    assert.deepEqual(events, ['resolve', 'create', 'launch']);
  } finally {
    await manager.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

test('shutdown releases a worktree materialized before launch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'droidex-automations-'));
  const worktree = join(directory, 'worktree');
  const released: string[] = [];
  const launches: SessionCreate[] = [];
  let finishMaterializing: () => void = () => undefined;
  const materializing = new Promise<void>((resolve) => {
    finishMaterializing = resolve;
  });
  let noteMaterializing: () => void = () => undefined;
  const materializingStarted = new Promise<void>((resolve) => {
    noteMaterializing = resolve;
  });
  const manager = createManager(directory, {
    prepareWorkspace: async () => worktree,
    createWorkspace: async () => {
      noteMaterializing();
      await materializing;
    },
    launchSession: async (command) => {
      launches.push(command);
    },
    releaseWorkspace: async ({ resolvedCwd }) => {
      if (resolvedCwd) released.push(resolvedCwd);
    },
  });

  try {
    const automation = await manager.create(
      task({ executionMode: 'worktree', workspaceCwd: directory }),
    );
    await manager.runNow(automation.id);
    await materializingStarted;
    const shutdown = manager.shutdown();
    finishMaterializing();
    await shutdown;
    assert.deepEqual(launches, []);
    assert.deepEqual(released, [worktree]);
  } finally {
    finishMaterializing();
    await manager.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a restarted sidecar can release a worktree created before launch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'droidex-automations-'));
  const worktree = join(directory, 'worktree');
  const released: string[] = [];
  const launches: SessionCreate[] = [];
  const first = createManager(directory, {
    prepareWorkspace: async () => worktree,
    launchSession: async (command) => {
      launches.push(command);
    },
    releaseWorkspace: async ({ resolvedCwd }) => {
      if (resolvedCwd) released.push(resolvedCwd);
    },
  });

  try {
    try {
      const automation = await first.create(task());
      await first.runNow(automation.id);
      await waitFor(() => launches.length === 1);
    } finally {
      await first.shutdown();
    }
    assert.equal(released.length, 0);
    const second = createManager(directory, {
      prepareWorkspace: async () => '',
      releaseWorkspace: async ({ resolvedCwd }) => {
        if (resolvedCwd) released.push(resolvedCwd);
      },
    });
    try {
      await waitFor(() => released.includes(worktree));
      assert.deepEqual(released, [worktree]);
    } finally {
      await second.shutdown();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a restarted sidecar releases a worktree after its review origin was dropped', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'droidex-automations-'));
  const worktree = join(directory, 'worktree');
  const released: string[] = [];
  const launches: SessionCreate[] = [];
  const first = createManager(directory, {
    prepareWorkspace: async () => worktree,
    launchSession: async (command) => {
      launches.push(command);
    },
    releaseWorkspace: async ({ resolvedCwd }) => {
      if (resolvedCwd) released.push(resolvedCwd);
    },
  });

  try {
    try {
      const automation = await first.create(
        task({ executionMode: 'worktree', workspaceCwd: directory }),
      );
      await first.runNow(automation.id);
      await waitFor(() => launches.length === 1);
      const launch = launches[0];
      if (!launch) throw new Error('Expected an automation session launch.');
      await first.observeSessionEvent({
        type: 'session.created',
        clientRef: launch.clientRef,
        session: { appSessionId: 'session-review' },
      } as ServerEvent);
      await first.observeSessionEvent({
        type: 'session.updated',
        session: { appSessionId: 'session-review', streaming: true },
      } as ServerEvent);
      await first.observeSessionEvent({
        type: 'session.updated',
        session: { appSessionId: 'session-review', streaming: false },
      } as ServerEvent);
      await waitFor(async () => (await first.snapshot()).runs[0]?.status === 'completed');
    } finally {
      await first.shutdown();
    }
    assert.equal(released.length, 0);
    const storePath = join(directory, 'automations.json');
    const store = JSON.parse(await readFile(storePath, 'utf8')) as {
      sessionOrigins: Record<string, unknown>;
    };
    delete store.sessionOrigins['session-review'];
    await writeFile(storePath, JSON.stringify(store), 'utf8');
    const second = createManager(directory, {
      prepareWorkspace: async () => '',
      releaseWorkspace: async ({ resolvedCwd }) => {
        if (resolvedCwd) released.push(resolvedCwd);
      },
    });
    try {
      await waitFor(() => released.includes(worktree));
      assert.deepEqual(released, [worktree]);
    } finally {
      await second.shutdown();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  'a failed store write does not keep scheduler advances in memory',
  { skip: process.platform === 'win32' },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'droidex-automations-'));
    let clock = Date.UTC(2026, 0, 1, 8, 0, 0);
    const dueAt = clock + 60_000;
    const manager = createManager(directory, {
      now: () => clock,
    });

    try {
      const once = await manager.create(
        task({ schedule: { kind: 'once', runAt: dueAt }, title: 'Once report' }),
      );
      clock = dueAt + 1_000;
      await chmod(directory, 0o555);
      await assert.rejects(manager.create(task({ title: 'Later' })));
      const snapshot = await manager.snapshot();
      await chmod(directory, 0o755);
      assert.equal(snapshot.automations.length, 1);
      assert.equal(snapshot.automations[0]?.id, once.id);
      assert.equal(snapshot.automations[0]?.enabled, true);
      assert.equal(snapshot.automations[0]?.nextRunAt, dueAt);
      assert.equal(snapshot.queuedRunCount, 0);
    } finally {
      await chmod(directory, 0o755).catch(() => undefined);
      await manager.shutdown();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test('overlapping creates both persist', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'droidex-automations-'));
  const manager = createManager(directory, {});

  try {
    const [left, right] = await Promise.all([
      manager.create(task({ title: 'Left' })),
      manager.create(task({ title: 'Right' })),
    ]);
    const snapshot = await manager.snapshot();
    assert.equal(snapshot.automations.length, 2);
    const titles = snapshot.automations.map((automation) => automation.title).sort();
    assert.deepEqual(titles, ['Left', 'Right']);
    assert.notEqual(left.id, right.id);
  } finally {
    await manager.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

test('an unattended run cannot create another automation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'droidex-automations-'));
  const launches: SessionCreate[] = [];
  const manager = createManager(directory, {
    launchSession: async (command) => {
      launches.push(command);
    },
    resolveSessionContext: async () => ({
      cwd: '/repo',
      modelId: 'chat-model',
      reasoningEffort: 'high',
      autonomy: 'high',
    }),
  });

  try {
    const automation = await manager.create(task({ autonomy: 'high' }));
    await manager.runNow(automation.id);
    await waitFor(() => launches.length === 1);
    const launch = launches[0];
    if (!launch) throw new Error('Expected an automation session launch.');
    await manager.observeSessionEvent({
      type: 'session.created',
      clientRef: launch.clientRef,
      session: { appSessionId: 'session-run', autonomy: 'high' },
    } as ServerEvent);
    await assert.rejects(
      manager.createFromSession(task({ timezone: 'UTC' }), 'session-run'),
      /unattended/i,
    );
    assert.equal((await manager.snapshot()).automations.length, 1);
  } finally {
    await manager.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

test('direct creation requires High autonomy', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'droidex-automations-'));
  const manager = createManager(directory, {
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
  const manager = createManager(directory, {
    emit: (event) => {
      if (event.type === 'automations.result') results.push(event);
    },
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

async function waitWhile(
  predicate: () => boolean | Promise<boolean>,
  durationMs: number,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < durationMs) {
    if (!(await predicate())) throw new Error('Condition failed while waiting.');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
