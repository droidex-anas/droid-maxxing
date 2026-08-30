import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ClientCommand, ServerEvent } from '../protocol.js';
import { AutomationManager } from './AutomationManager.js';

type SessionCreate = Extract<ClientCommand, { type: 'session.create' }>;

test('run now starts a real session and settles only after streaming ends', async () => {
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
    const automation = await manager.create({
      title: 'Repository brief',
      prompt: 'Summarize the repository.',
      workspaceCwd: '/repo',
      executionMode: 'local',
      enabled: true,
      schedule: { kind: 'daily', time: '09:00' },
      timezone: 'UTC',
      modelId: 'model-a',
      reasoningEffort: 'high',
    });
    await manager.runNow(automation.id);
    await waitFor(() => launches.length === 1);

    const launch = launches[0];
    if (!launch) throw new Error('Expected an automation session launch.');
    assert.equal(launch.modelId, 'model-a');
    assert.equal(launch.reasoningEffort, 'high');
    await manager.observeSessionEvent({
      type: 'session.created',
      clientRef: launch.clientRef,
      session: { appSessionId: 'session-a' },
    } as ServerEvent);
    await manager.observeSessionEvent({
      type: 'session.updated',
      session: { appSessionId: 'session-a', streaming: true },
    } as ServerEvent);

    const streaming = await manager.snapshot();
    assert.equal(streaming.runs[0]?.status, 'running');
    assert.equal(streaming.activeRunCount, 1);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal((await manager.snapshot()).runs[0]?.status, 'running');

    await manager.observeSessionEvent({
      type: 'session.updated',
      session: { appSessionId: 'session-a', streaming: false },
    } as ServerEvent);
    await waitFor(async () => (await manager.snapshot()).runs[0]?.status === 'completed');

    const snapshot = await manager.snapshot();
    assert.equal(snapshot.activeRunCount, 0);
    assert.equal(snapshot.runs[0]?.appSessionId, 'session-a');
    assert.equal(snapshot.runs[0]?.status, 'completed');
    assert.equal(snapshot.sessionOrigins['session-a']?.automationTitle, 'Repository brief');
  } finally {
    await manager.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a due schedule launches without a renderer run pump', async () => {
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
    await manager.create({
      title: 'Scheduled check',
      prompt: 'Run the scheduled check.',
      enabled: true,
      schedule: { kind: 'once', runAt: Date.now() + 40 },
      timezone: 'UTC',
      modelId: 'model-b',
      reasoningEffort: 'medium',
    });
    await waitFor(() => launches.length === 1, 2_000);
    const launch = launches[0];
    if (!launch) throw new Error('Expected a scheduled session launch.');
    assert.equal(launch.title, 'Scheduled check');
    assert.equal(launch.modelId, 'model-b');
    assert.equal(launch.reasoningEffort, 'medium');
  } finally {
    await manager.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

test('queued automations wait until the active run has actually settled', async () => {
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
    const first = await manager.create({
      title: 'First automation',
      prompt: 'Run first.',
      enabled: true,
      schedule: { kind: 'daily', time: '23:59' },
      timezone: 'UTC',
      modelId: 'model-a',
      reasoningEffort: 'medium',
    });
    const second = await manager.create({
      title: 'Second automation',
      prompt: 'Run second.',
      enabled: true,
      schedule: { kind: 'daily', time: '23:58' },
      timezone: 'UTC',
      modelId: 'model-b',
      reasoningEffort: 'high',
    });

    await manager.runNow(first.id);
    await manager.runNow(second.id);
    await waitFor(() => launches.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(launches.length, 1);

    const launch = launches[0];
    if (!launch) throw new Error('Expected the first automation session launch.');
    await manager.observeSessionEvent({
      type: 'session.created',
      clientRef: launch.clientRef,
      session: { appSessionId: 'session-first' },
    } as ServerEvent);
    await manager.observeSessionEvent({
      type: 'session.updated',
      session: { appSessionId: 'session-first', streaming: true },
    } as ServerEvent);
    await manager.observeSessionEvent({
      type: 'session.updated',
      session: { appSessionId: 'session-first', streaming: false },
    } as ServerEvent);

    await waitFor(() => launches.length === 2);
    const secondLaunch = launches[1];
    if (!secondLaunch) throw new Error('Expected the queued automation to launch next.');
    assert.equal(secondLaunch.title, 'Second automation');
  } finally {
    await manager.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

test('saved automations without a model selection are paused instead of silently using a default', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'droidex-automations-'));
  await writeFile(
    join(directory, 'automations.json'),
    JSON.stringify({
      version: 1,
      automations: [
        {
          id: 'legacy',
          title: 'Legacy automation',
          prompt: 'Run legacy task.',
          workspaceCwd: null,
          executionMode: 'local',
          enabled: true,
          schedule: { kind: 'daily', time: '09:00' },
          timezone: 'UTC',
          modelId: null,
          reasoningEffort: null,
          nextRunAt: Date.now() + 60_000,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
      runs: [],
      sessionOrigins: {},
    }),
    'utf8',
  );
  const manager = new AutomationManager({
    dataDir: directory,
    emit: () => undefined,
    prepareWorkspace: async ({ cwd }) => cwd ?? '',
    launchSession: async () => undefined,
  });

  try {
    const snapshot = await manager.snapshot();
    assert.equal(snapshot.automations[0]?.enabled, false);
    assert.match(snapshot.automations[0]?.lastRunError ?? '', /model and reasoning/i);
  } finally {
    await manager.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a catch-up schedule after restart keeps its selected model and reasoning', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'droidex-automations-'));
  const now = Date.now();
  await writeFile(
    join(directory, 'automations.json'),
    JSON.stringify({
      version: 1,
      automations: [
        {
          id: 'catch-up',
          title: 'Catch-up automation',
          prompt: 'Run the missed task.',
          workspaceCwd: null,
          executionMode: 'local',
          enabled: true,
          schedule: { kind: 'daily', time: '09:00' },
          timezone: 'UTC',
          modelId: 'custom:selected-model',
          reasoningEffort: 'xhigh',
          nextRunAt: now - 1_000,
          lastRunAt: null,
          lastRunStatus: null,
          lastRunError: null,
          lastRunDurationMs: null,
          lastAppSessionId: null,
          completedAt: null,
          createdAt: now - 10_000,
          updatedAt: now - 10_000,
        },
      ],
      runs: [],
      sessionOrigins: {},
    }),
    'utf8',
  );
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
    await waitFor(() => launches.length === 1);
    const launch = launches[0];
    if (!launch) throw new Error('Expected the catch-up automation to launch.');
    assert.equal(launch.modelId, 'custom:selected-model');
    assert.equal(launch.reasoningEffort, 'xhigh');
  } finally {
    await manager.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

test('transcript activity settles a run even when a streaming-start update was missed', async () => {
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
    const automation = await manager.create({
      title: 'Transcript-backed run',
      prompt: 'Do the task.',
      enabled: true,
      schedule: { kind: 'daily', time: '23:59' },
      timezone: 'UTC',
      modelId: 'model-c',
      reasoningEffort: 'high',
    });
    await manager.runNow(automation.id);
    await waitFor(() => launches.length === 1);
    const launch = launches[0];
    if (!launch) throw new Error('Expected an automation session launch.');

    await manager.observeSessionEvent({
      type: 'session.created',
      clientRef: launch.clientRef,
      session: { appSessionId: 'session-transcript' },
    } as ServerEvent);
    await manager.observeSessionEvent({
      type: 'event.appended',
      event: {
        id: 'event-a',
        appSessionId: 'session-transcript',
        sourceSessionId: 'session-transcript',
        role: 'primary',
        ts: Date.now(),
        kind: 'thinking',
        text: 'Working',
      },
    } as ServerEvent);
    await manager.observeSessionEvent({
      type: 'session.updated',
      session: { appSessionId: 'session-transcript', streaming: false },
    } as ServerEvent);

    await waitFor(async () => (await manager.snapshot()).runs[0]?.status === 'completed');
    assert.equal((await manager.snapshot()).runs[0]?.status, 'completed');
  } finally {
    await manager.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

test('ordinary chat transcript appends do not persist or publish an automation snapshot', async () => {
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
    assert.equal((await manager.snapshot()).activeRunCount, 0);
  } finally {
    await manager.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

test('invalid reasoning values are rejected before an automation can be saved', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'droidex-automations-'));
  const manager = new AutomationManager({
    dataDir: directory,
    emit: () => undefined,
    prepareWorkspace: async ({ cwd }) => cwd ?? '',
    launchSession: async () => undefined,
  });

  try {
    await assert.rejects(
      manager.create({
        title: 'Invalid reasoning',
        prompt: 'Do not save this.',
        enabled: true,
        schedule: { kind: 'daily', time: '09:00' },
        timezone: 'UTC',
        modelId: 'model-a',
        reasoningEffort: 'turbo' as never,
      }),
      /reasoning level supported by DROIDEX/i,
    );
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

test('automation proposals inherit the calling chat workspace, model, and reasoning', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'droidex-automations-'));
  const manager = new AutomationManager({
    dataDir: directory,
    emit: () => undefined,
    prepareWorkspace: async ({ cwd }) => cwd ?? '',
    launchSession: async () => undefined,
  });

  try {
    await manager.observeSessionEvent({
      type: 'session.created',
      clientRef: 'chat-create',
      session: {
        appSessionId: 'chat-session',
        cwd: '/workspace/project',
        modelId: 'custom:chat-model',
        reasoningEffort: 'xhigh',
      },
    } as ServerEvent);

    const proposal = await manager.propose(
      {
        title: 'Review open pull requests',
        prompt: 'Review open pull requests and summarize correctness risks.',
        schedule: { kind: 'weekdays', time: '09:00' },
        timezone: 'Asia/Kolkata',
      },
      'chat-session',
    );

    assert.equal(proposal.draft.workspaceCwd, '/workspace/project');
    assert.equal(proposal.draft.modelId, 'custom:chat-model');
    assert.equal(proposal.draft.reasoningEffort, 'xhigh');
    assert.deepEqual(proposal.missingFields, []);
    assert.equal((await manager.snapshot()).proposals[0]?.id, proposal.id);
  } finally {
    await manager.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

test('confirming the same proposal twice creates exactly one automation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'droidex-automations-'));
  const manager = new AutomationManager({
    dataDir: directory,
    emit: () => undefined,
    prepareWorkspace: async ({ cwd }) => cwd ?? '',
    launchSession: async () => undefined,
  });

  try {
    const proposal = await manager.propose(
      {
        title: 'Daily review',
        prompt: 'Review the repository.',
        schedule: { kind: 'daily', time: '09:00' },
        timezone: 'UTC',
        modelId: 'model-a',
        reasoningEffort: 'high',
      },
      'chat-session',
    );
    const [first, second] = await Promise.all([
      manager.confirmProposal(proposal.id),
      manager.confirmProposal(proposal.id),
    ]);
    assert.equal(first.id, second.id);
    const snapshot = await manager.snapshot();
    assert.equal(snapshot.automations.length, 1);
    assert.equal(snapshot.proposals[0]?.status, 'confirmed');
    assert.equal(snapshot.proposals[0]?.automationId, first.id);
  } finally {
    await manager.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a run records the effective selected model and reasoning', async () => {
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
    const automation = await manager.create({
      title: 'Selection audit',
      prompt: 'Run with the selected model.',
      enabled: true,
      schedule: { kind: 'daily', time: '23:59' },
      timezone: 'UTC',
      modelId: 'model-selected',
      reasoningEffort: 'high',
    });
    await manager.runNow(automation.id);
    await waitFor(() => launches.length === 1);
    const launch = launches[0];
    if (!launch) throw new Error('Expected an automation launch.');
    await manager.observeSessionEvent({
      type: 'session.created',
      clientRef: launch.clientRef,
      session: {
        appSessionId: 'selection-session',
        modelId: 'model-selected',
        reasoningEffort: 'high',
      },
    } as ServerEvent);
    const run = (await manager.snapshot()).runs[0];
    assert.equal(run?.effectiveModelId, 'model-selected');
    assert.equal(run?.effectiveReasoningEffort, 'high');
    assert.equal(run?.selectionVerified, true);
  } finally {
    await manager.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a mismatched effective model makes the completed turn fail honestly', async () => {
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
    const automation = await manager.create({
      title: 'Mismatch audit',
      prompt: 'Run with the selected model.',
      enabled: true,
      schedule: { kind: 'daily', time: '23:59' },
      timezone: 'UTC',
      modelId: 'model-requested',
      reasoningEffort: 'high',
    });
    await manager.runNow(automation.id);
    await waitFor(() => launches.length === 1);
    const launch = launches[0];
    if (!launch) throw new Error('Expected an automation launch.');
    await manager.observeSessionEvent({
      type: 'session.created',
      clientRef: launch.clientRef,
      session: {
        appSessionId: 'mismatch-session',
        modelId: 'model-other',
        reasoningEffort: 'medium',
      },
    } as ServerEvent);
    await manager.observeSessionEvent({
      type: 'session.updated',
      session: {
        appSessionId: 'mismatch-session',
        modelId: 'model-other',
        reasoningEffort: 'medium',
        streaming: true,
      },
    } as ServerEvent);
    await manager.observeSessionEvent({
      type: 'session.updated',
      session: {
        appSessionId: 'mismatch-session',
        modelId: 'model-other',
        reasoningEffort: 'medium',
        streaming: false,
      },
    } as ServerEvent);
    await waitFor(async () => (await manager.snapshot()).runs[0]?.status === 'failed');
    const run = (await manager.snapshot()).runs[0];
    assert.equal(run?.selectionVerified, false);
    assert.match(run?.error ?? '', /instead of the selected/i);
  } finally {
    await manager.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

test('proposal context resolver fills the actual chat model, reasoning, workspace, and autonomy', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'droidex-automations-'));
  const manager = new AutomationManager({
    dataDir: directory,
    emit: () => undefined,
    prepareWorkspace: async ({ cwd }) => cwd ?? '',
    launchSession: async () => undefined,
    resolveSessionContext: async () => ({
      cwd: '/resolved/workspace',
      modelId: 'resolved-model',
      reasoningEffort: 'medium',
      autonomy: 'low',
    }),
  });

  try {
    const proposal = await manager.propose(
      {
        title: 'Resolved proposal',
        prompt: 'Review the repository.',
        schedule: { kind: 'daily', time: '09:00' },
        timezone: 'UTC',
      },
      'session-with-defaults',
    );
    assert.equal(proposal.draft.workspaceCwd, '/resolved/workspace');
    assert.equal(proposal.draft.modelId, 'resolved-model');
    assert.equal(proposal.draft.reasoningEffort, 'medium');
    assert.deepEqual(proposal.missingFields, []);
  } finally {
    await manager.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

test('direct creation inherits chat settings only in high autonomy', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'droidex-automations-'));
  let autonomy: 'low' | 'high' = 'low';
  const manager = new AutomationManager({
    dataDir: directory,
    emit: () => undefined,
    prepareWorkspace: async ({ cwd }) => cwd ?? '',
    launchSession: async () => undefined,
    resolveSessionContext: async () => ({
      cwd: '/repo',
      modelId: 'chat-model',
      reasoningEffort: 'high',
      autonomy,
    }),
  });
  const input = {
    title: 'Direct automation',
    prompt: 'Run a direct automation.',
    schedule: { kind: 'daily' as const, time: '09:00' },
    timezone: 'UTC',
  };

  try {
    await assert.rejects(manager.createFromSession(input, 'chat'), /High autonomy/i);
    autonomy = 'high';
    const automation = await manager.createFromSession(input, 'chat');
    assert.equal(automation.workspaceCwd, '/repo');
    assert.equal(automation.modelId, 'chat-model');
    assert.equal(automation.reasoningEffort, 'high');
  } finally {
    await manager.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

test('saved and queued automations are checked against the live model catalog', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'droidex-automations-'));
  const checked: string[] = [];
  const manager = new AutomationManager({
    dataDir: directory,
    emit: () => undefined,
    prepareWorkspace: async ({ cwd }) => cwd ?? '',
    launchSession: async () => undefined,
    validateSelection: async (modelId, reasoningEffort) => {
      checked.push(`${modelId}:${reasoningEffort}`);
      if (modelId === 'removed-model') throw new Error('Selected model is no longer available.');
    },
  });

  try {
    await assert.rejects(
      manager.create({
        title: 'Removed model',
        prompt: 'Do not save.',
        enabled: true,
        schedule: { kind: 'daily', time: '09:00' },
        timezone: 'UTC',
        modelId: 'removed-model',
        reasoningEffort: 'high',
      }),
      /no longer available/i,
    );
    const automation = await manager.create({
      title: 'Available model',
      prompt: 'Run normally.',
      enabled: true,
      schedule: { kind: 'daily', time: '09:00' },
      timezone: 'UTC',
      modelId: 'model-a',
      reasoningEffort: 'medium',
    });
    await manager.runNow(automation.id);
    assert.ok(checked.filter((entry) => entry === 'model-a:medium').length >= 2);
  } finally {
    await manager.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

test('an automation that could not be saved is not left behind in memory', async (t) => {
  if (process.getuid?.() === 0) {
    t.skip('The unwritable-directory check cannot fail as root.');
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), 'droidex-automations-'));
  const manager = new AutomationManager({
    dataDir: directory,
    emit: () => undefined,
    prepareWorkspace: async ({ cwd }) => cwd ?? '',
    launchSession: async () => undefined,
  });

  try {
    await manager.snapshot();
    await chmod(directory, 0o500);
    await assert.rejects(
      manager.create({
        title: 'Unsavable automation',
        prompt: 'Never persisted.',
        enabled: true,
        schedule: { kind: 'daily', time: '09:00' },
        timezone: 'UTC',
        modelId: 'model-a',
        reasoningEffort: 'high',
      }),
      /EACCES|EPERM/,
    );
    await chmod(directory, 0o700);
    const snapshot = await manager.snapshot();
    assert.deepEqual(snapshot.automations, []);
    assert.deepEqual(snapshot.runs, []);
  } finally {
    await chmod(directory, 0o700).catch(() => undefined);
    await manager.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

test('restarting fails unfinished runs, closes their chats, and releases their worktrees', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'droidex-automations-'));
  const now = Date.now();
  await writeFile(
    join(directory, 'automations.json'),
    JSON.stringify({
      version: 1,
      automations: [
        {
          id: 'interrupted',
          title: 'Interrupted automation',
          prompt: 'Was running when DROIDEX stopped.',
          workspaceCwd: null,
          executionMode: 'local',
          enabled: false,
          schedule: { kind: 'daily', time: '09:00' },
          timezone: 'UTC',
          modelId: 'model-a',
          reasoningEffort: 'high',
          nextRunAt: null,
          createdAt: now - 10_000,
          updatedAt: now - 10_000,
        },
      ],
      runs: [
        {
          id: 'run-interrupted',
          automationId: 'interrupted',
          automation: {
            id: 'interrupted',
            title: 'Interrupted automation',
            prompt: 'Was running when DROIDEX stopped.',
            workspaceCwd: '/repo',
            executionMode: 'worktree',
            timezone: 'UTC',
            modelId: 'model-a',
            reasoningEffort: 'high',
          },
          scheduledAt: now - 5_000,
          requestedAt: now - 5_000,
          trigger: 'manual',
          status: 'running',
          startedAt: now - 5_000,
          appSessionId: 'orphaned-session',
          resolvedCwd: '/repo/.worktrees/interrupted/repo',
        },
      ],
      proposals: [],
      sessionOrigins: {},
    }),
    'utf8',
  );
  const closed: string[] = [];
  const released: (string | null)[] = [];
  const manager = new AutomationManager({
    dataDir: directory,
    emit: () => undefined,
    prepareWorkspace: async ({ cwd }) => cwd ?? '',
    launchSession: async () => undefined,
    closeSession: async (appSessionId) => {
      closed.push(appSessionId);
    },
    releaseWorkspace: async (workspace) => {
      released.push(workspace.resolvedCwd);
    },
  });

  try {
    await waitFor(() => closed.length === 1 && released.length === 1);
    assert.deepEqual(closed, ['orphaned-session']);
    assert.deepEqual(released, ['/repo/.worktrees/interrupted/repo']);
    const run = (await manager.snapshot()).runs[0];
    assert.equal(run?.status, 'failed');
    assert.match(run?.error ?? '', /restarted/i);
  } finally {
    await manager.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

test('an automation whose only run already passed has no upcoming run', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'droidex-automations-'));
  const manager = new AutomationManager({
    dataDir: directory,
    emit: () => undefined,
    prepareWorkspace: async ({ cwd }) => cwd ?? '',
    launchSession: async () => undefined,
  });

  try {
    const automation = await manager.create({
      title: 'Elapsed one-off',
      prompt: 'Was scheduled for yesterday.',
      enabled: true,
      schedule: { kind: 'once', runAt: Date.now() - 60_000 },
      timezone: 'UTC',
      modelId: 'model-a',
      reasoningEffort: 'high',
    });
    assert.equal(automation.nextRunAt, null);
  } finally {
    await manager.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a failed scheduler write settles the run it could not record and stays armed', async (t) => {
  if (process.getuid?.() === 0) {
    t.skip('The unwritable-directory check cannot fail as root.');
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), 'droidex-automations-'));
  const now = Date.now();
  await writeFile(
    join(directory, 'automations.json'),
    JSON.stringify({
      version: 1,
      automations: [
        savedAutomation('unwritable', 'Unwritable run', now + 400),
        savedAutomation('later', 'Later run', now + 1_200),
      ],
      runs: [],
      proposals: [],
      sessionOrigins: {},
    }),
    'utf8',
  );
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
    await manager.snapshot();
    await chmod(directory, 0o500);
    // The first automation comes due while the store cannot be written: its run
    // must settle instead of blocking the queue, and the failure must not escape
    // the unawaited drain as an unhandled rejection.
    await waitFor(async () => {
      const run = (await manager.snapshot()).runs.find(
        (candidate) => candidate.status === 'failed',
      );
      return run?.automationId === 'unwritable';
    }, 3_000);
    assert.equal(launches.length, 0);
    await chmod(directory, 0o700);
    // The scheduler is the only thing that wakes for the second automation, so a
    // failed write must not have left it unarmed.
    await waitFor(() => launches.length === 1, 3_000);
    assert.equal(launches[0]?.title, 'Later run');
  } finally {
    await chmod(directory, 0o700).catch(() => undefined);
    await manager.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

test('shutdown waits for a settling run to release its isolated worktree', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'droidex-automations-'));
  const launches: SessionCreate[] = [];
  const releases: string[] = [];
  let finishRelease = (): void => undefined;
  const releaseFinished = new Promise<void>((resolve) => {
    finishRelease = resolve;
  });
  const manager = new AutomationManager({
    dataDir: directory,
    emit: () => undefined,
    prepareWorkspace: async () => '/repo/.worktrees/nightly/repo',
    launchSession: async (command) => {
      launches.push(command);
    },
    releaseWorkspace: async (workspace) => {
      releases.push(`start:${workspace.resolvedCwd ?? ''}`);
      await releaseFinished;
      releases.push(`done:${workspace.resolvedCwd ?? ''}`);
    },
  });

  try {
    const automation = await manager.create({
      title: 'Nightly worktree run',
      prompt: 'Run in an isolated worktree.',
      workspaceCwd: '/repo',
      executionMode: 'worktree',
      enabled: true,
      schedule: { kind: 'daily', time: '23:59' },
      timezone: 'UTC',
      modelId: 'model-a',
      reasoningEffort: 'high',
    });
    await manager.runNow(automation.id);
    await waitFor(() => launches.length === 1);
    const launch = launches[0];
    if (!launch) throw new Error('Expected an automation launch.');
    await manager.observeSessionEvent({
      type: 'session.created',
      clientRef: launch.clientRef,
      session: { appSessionId: 'worktree-session' },
    } as ServerEvent);

    // Session teardown during shutdown is observed without being awaited, which
    // is exactly how the sidecar reports it.
    void manager.observeSessionEvent({
      type: 'session.closed',
      appSessionId: 'worktree-session',
    } as ServerEvent);
    await waitFor(() => releases.length === 1);

    const closing = manager.shutdown().then(() => {
      releases.push('shutdown');
    });
    // Proving shutdown waits needs an observation window: its own store flush
    // settles on the event loop, so a shutdown that does not wait for the
    // release would already have finished by now.
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.deepEqual(releases, ['start:/repo/.worktrees/nightly/repo']);
    finishRelease();
    await closing;
    assert.deepEqual(releases, [
      'start:/repo/.worktrees/nightly/repo',
      'done:/repo/.worktrees/nightly/repo',
      'shutdown',
    ]);
  } finally {
    finishRelease();
    await manager.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a worktree prepared for a run nobody tracks anymore is released', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'droidex-automations-'));
  const released: (string | null)[] = [];
  let prepareStarted = false;
  let allowPrepare = (): void => undefined;
  const prepareAllowed = new Promise<void>((resolve) => {
    allowPrepare = resolve;
  });
  const manager = new AutomationManager({
    dataDir: directory,
    emit: () => undefined,
    prepareWorkspace: async () => {
      prepareStarted = true;
      await prepareAllowed;
      return '/repo/.worktrees/abandoned/repo';
    },
    launchSession: async () => undefined,
    releaseWorkspace: async (workspace) => {
      released.push(workspace.resolvedCwd);
    },
  });

  try {
    const automation = await manager.create({
      title: 'Abandoned worktree run',
      prompt: 'Run in an isolated worktree.',
      workspaceCwd: '/repo',
      executionMode: 'worktree',
      enabled: true,
      schedule: { kind: 'daily', time: '23:59' },
      timezone: 'UTC',
      modelId: 'model-a',
      reasoningEffort: 'high',
    });
    await manager.runNow(automation.id);
    await waitFor(() => prepareStarted);

    // Shutting down while the worktree is still being created abandons the run,
    // so the finished worktree has to go with it.
    const closing = manager.shutdown();
    allowPrepare();
    await closing;
    assert.deepEqual(released, ['/repo/.worktrees/abandoned/repo']);
  } finally {
    allowPrepare();
    await rm(directory, { recursive: true, force: true });
  }
});

test('deleting an automation turns its confirmed proposal back into a draft', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'droidex-automations-'));
  const manager = new AutomationManager({
    dataDir: directory,
    emit: () => undefined,
    prepareWorkspace: async ({ cwd }) => cwd ?? '',
    launchSession: async () => undefined,
  });

  try {
    const proposal = await manager.propose(
      {
        title: 'Weekly review',
        prompt: 'Review the repository.',
        schedule: { kind: 'weekly', weekday: 1, time: '09:00' },
        timezone: 'UTC',
        modelId: 'model-a',
        reasoningEffort: 'high',
      },
      'chat-session',
    );
    const automation = await manager.confirmProposal(proposal.id);
    await manager.remove(automation.id);

    const stored = (await manager.snapshot()).proposals[0];
    assert.equal(stored?.status, 'draft');
    assert.equal(stored?.automationId, null);
    assert.equal(stored?.confirmedAt, null);
    // Confirming again is the recovery path, so it must produce a new automation.
    const recreated = await manager.confirmProposal(proposal.id);
    assert.notEqual(recreated.id, automation.id);
    assert.equal((await manager.snapshot()).automations.length, 1);
  } finally {
    await manager.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

test('waiting for a run that is not due yet writes and publishes nothing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'droidex-automations-'));
  const clock = Date.UTC(2026, 0, 1, 8, 0, 0);
  let published = 0;
  const manager = new AutomationManager({
    dataDir: directory,
    emit: (event) => {
      if (event.type === 'automations.snapshot') published += 1;
    },
    prepareWorkspace: async ({ cwd }) => cwd ?? '',
    launchSession: async () => undefined,
    now: () => clock,
    schedulerRecheckMs: 5,
  });

  try {
    await manager.create({
      title: 'Distant run',
      prompt: 'Run in an hour.',
      enabled: true,
      schedule: { kind: 'once', runAt: clock + 3_600_000 },
      timezone: 'UTC',
      modelId: 'model-a',
      reasoningEffort: 'high',
    });
    assert.notEqual((await manager.snapshot()).scheduler.nextWakeAt, null);

    // Long enough for many re-checks. The clock the scheduler reads has not
    // moved, so waking to compare it must stay free of a store write.
    const settled = published;
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(published, settled);
  } finally {
    await manager.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a run whose time passed while the machine slept starts on the next wake', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'droidex-automations-'));
  const launches: SessionCreate[] = [];
  let clock = Date.UTC(2026, 0, 1, 8, 0, 0);
  const dueAt = clock + 3_600_000;
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
    await manager.create({
      title: 'Overnight report',
      prompt: 'Report overnight.',
      enabled: true,
      schedule: { kind: 'once', runAt: dueAt },
      timezone: 'UTC',
      modelId: 'model-a',
      reasoningEffort: 'high',
    });
    assert.equal(launches.length, 0);

    // The machine was suspended past the due time: no command arrives and no
    // timer elapsed for that hour, only the wall clock moved.
    clock = dueAt + 60_000;
    await waitFor(() => launches.length === 1);

    assert.equal(launches[0]?.title, 'Overnight report');
    const snapshot = await manager.snapshot();
    // The occurrence that was missed, not a fresh one invented on waking.
    assert.equal(snapshot.runs[0]?.scheduledAt, dueAt);
    assert.equal(snapshot.runs[0]?.trigger, 'schedule');
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

function savedAutomation(id: string, title: string, nextRunAt: number) {
  return {
    id,
    title,
    prompt: `Run ${title}.`,
    workspaceCwd: null,
    executionMode: 'local',
    enabled: true,
    schedule: { kind: 'once', runAt: nextRunAt },
    timezone: 'UTC',
    modelId: 'model-a',
    reasoningEffort: 'high',
    nextRunAt,
    createdAt: nextRunAt - 60_000,
    updatedAt: nextRunAt - 60_000,
  };
}
