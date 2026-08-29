import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type { SessionFileChange } from './sessionFileCache.js';
import { createSessionManagerTestContext } from './testing/sessionManagerTestContext.js';
import { persistTestSummaries } from './testing/historyPersistenceFixture.js';
import type { ChildSessionSummary, SessionSummary, ServerEvent } from './protocol.js';
import { droidSessionConfiguration } from './providers/providerIdentity.js';
import { cursorSessionConfiguration } from './testing/droidProviderTestSupport.js';
import { withDroidSession } from './providers/droid/droidSessionAccess.js';
import { ProviderContractError } from './providers/providerTypes.js';

type SessionHistoryEvent = Extract<ServerEvent, { type: 'session.history' }>;
type SessionUpdatedEvent = Extract<ServerEvent, { type: 'session.updated' }>;

function isSessionHistory(event: ServerEvent): event is SessionHistoryEvent {
  return event.type === 'session.history';
}

function isSessionUpdated(event: ServerEvent): event is SessionUpdatedEvent {
  return event.type === 'session.updated';
}

function writeHistorySession(
  home: string,
  id: string,
  lines: unknown[],
  sessionStart: Record<string, unknown> = {},
): SessionFileChange {
  const dir = path.join(home, '.factory', 'sessions', '2026', '07');
  mkdirSync(dir, { recursive: true });
  const sessionPath = path.join(dir, `${id}.jsonl`);
  writeFileSync(
    sessionPath,
    [
      JSON.stringify({
        type: 'session_start',
        id,
        cwd: home,
        sessionTitle: 'History',
        settings: { interactionMode: 'auto' },
        ...sessionStart,
      }),
      ...lines.map((line) => JSON.stringify(line)),
    ].join('\n') + '\n',
  );
  return { providerSessionId: id, path: sessionPath };
}

function writeHistoryChain(
  home: string,
  appSessionId: string,
  sessionId: string,
  compactedFromProviderSessionIds: string[],
): void {
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    persistTestSummaries([
      {
        ...summary(appSessionId, sessionId),
        compactedFromProviderSessionIds,
      },
    ]);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
}

function assistantMessage(id: string, text: string, timestamp: number): Record<string, unknown> {
  return {
    type: 'message',
    id,
    timestamp: new Date(timestamp).toISOString(),
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  };
}

function summary(appSessionId: string, providerSessionId: string): SessionSummary {
  const now = Date.now();
  return {
    appSessionId,
    providerSessionId,
    sessionPurpose: 'chat',
    role: 'primary',
    title: `Historical ${appSessionId}`,
    goal: '',
    cwd: '',
    workspaceKind: 'none',
    configuration: droidSessionConfiguration({
      modelId: 'model-default',
      interactionMode: 'auto',
      autonomy: 'low',
    }),
    phase: 'paused',
    streaming: false,
    queuedSends: 0,
    features: [],
    tokensIn: 0,
    tokensOut: 0,
    contextTokens: 0,
    createdAt: now,
    updatedAt: now,
  };
}

function linkedWorker(
  parentAppSessionId: string,
  childSessionId: string,
  toolUseId: string,
  status: ChildSessionSummary['status'] = 'completed',
): ChildSessionSummary {
  return {
    parentAppSessionId,
    childSessionId,
    role: 'worker',
    status,
    modelId: 'model-default',
    spawnLink: { kind: 'tool-use', id: toolUseId },
    transcriptAvailable: true,
    streamFidelity: 'state',
  };
}

test('[H1] Initial history restore', { concurrency: false }, async () => {
  const h = createSessionManagerTestContext();

  try {
    h.fixture.publishSessionFiles([
      writeHistorySession(h.home, 'app-h1', [assistantMessage('m1', 'restored', 0)]),
    ]);

    await h.handle({ type: 'session.loadHistory', appSessionId: 'app-h1' });

    const event = h.events.filter(isSessionHistory).at(-1);
    assert.ok(event);
    assert.equal(event.appSessionId, 'app-h1');
    assert.equal(event.mode, 'replace');
    assert.equal(event.transcripts[0]?.text, 'restored');
    assert.equal(
      h.calls.filter((call) => call.target === 'history' && call.method === 'recordEvent').length,
      1,
    );
  } finally {
    await h.dispose();
  }
});

test('[H2] Paging, empty history, and retry', { concurrency: false }, async () => {
  const empty = createSessionManagerTestContext();
  try {
    await empty.create({
      sessionPurpose: 'chat',
      clientRef: 'empty-h2',
      title: 'Empty H2',
      goal: 'go',
      configuration: droidSessionConfiguration({
        modelId: 'model-default',
        interactionMode: 'auto',
        autonomy: 'low',
      }),
    });
    rmSync(path.join(empty.home, '.factory', 'sessions'), { recursive: true, force: true });
    await empty.handle({ type: 'session.loadHistory', appSessionId: 'provider-1' });
    const restored = empty.events.filter(isSessionHistory).at(-1);
    assert.ok(restored);
    assert.equal(restored.mode, 'replace');
    assert.deepEqual(restored.transcripts, []);
    assert.equal(restored.hasMore, false);
    assert.equal(
      empty.events.some(
        (event) => event.type === 'session.history.error' && event.appSessionId === 'provider-1',
      ),
      false,
    );
  } finally {
    await empty.dispose();
  }

  const h = createSessionManagerTestContext();
  try {
    h.fixture.publishSessionFiles([
      writeHistorySession(h.home, 'old-h2', [assistantMessage('old', 'old', 0)]),
      writeHistorySession(
        h.home,
        'new-h2',
        Array.from({ length: 400 }, (_, index) =>
          assistantMessage(`new-${index}`, `new-${index}`, index + 1),
        ),
      ),
    ]);
    writeHistoryChain(h.home, 'app-h2', 'new-h2', ['old-h2']);

    await h.handle({ type: 'session.loadHistory', appSessionId: 'app-h2' });

    const newest = h.events.filter(isSessionHistory).at(-1);
    assert.ok(newest);
    assert.equal(newest.mode, 'replace');
    assert.equal(newest.transcripts.length, 400);
    assert.equal(newest.transcripts[0]?.text, 'new-0');
    assert.ok(newest.olderCursor);
    assert.equal(newest.hasMore, true);

    await h.handle({
      type: 'session.loadHistory',
      appSessionId: 'app-h2',
      cursor: newest.olderCursor,
    });

    const oldest = h.events.filter(isSessionHistory).at(-1);
    assert.ok(oldest);
    assert.equal(oldest.mode, 'prepend');
    assert.equal(oldest.transcripts.length, 1);
    assert.equal(oldest.transcripts[0]?.text, 'old');
    assert.equal(oldest.hasMore, false);
    assert.equal(
      h.calls.filter((call) => call.target === 'history' && call.method === 'recordEvent').length,
      401,
    );

    await h.handle({ type: 'session.loadHistory', appSessionId: 'missing-h2' });
    const historyErrors = h.events.filter(
      (event) => event.type === 'session.history.error' && event.appSessionId === 'missing-h2',
    ).length;
    assert.equal(historyErrors, 1);
    assert.equal(
      h.events.some((event) => event.type === 'error' && event.appSessionId === 'missing-h2'),
      true,
    );

    h.fixture.publishSessionFiles([
      writeHistorySession(h.home, 'missing-h2', [assistantMessage('retry', 'retried', 402)]),
    ]);
    await h.handle({ type: 'session.loadHistory', appSessionId: 'missing-h2' });
    const retried = h.events.filter(isSessionHistory).at(-1);
    assert.ok(retried);
    assert.equal(retried.mode, 'replace');
    assert.equal(retried.transcripts[0]?.text, 'retried');
    assert.equal(
      h.events.filter(
        (event) => event.type === 'session.history.error' && event.appSessionId === 'missing-h2',
      ).length,
      historyErrors,
    );
  } finally {
    await h.dispose();
  }
});

test(
  'child.loadHistory emits initial replace and older prepend pages through logical identity',
  {
    concurrency: false,
  },
  async () => {
    const h = createSessionManagerTestContext();
    try {
      h.fixture.publishSessionFiles([
        writeHistorySession(h.home, 'provider-child-history', [
          assistantMessage('oldest', 'oldest', 1),
          assistantMessage('middle', 'middle', 2),
          assistantMessage('newest', 'newest', 3),
        ]),
      ]);
      h.history.seedChildSessions([
        {
          parentAppSessionId: 'parent-child-history',
          childSessionId: 'logical-child-history',
          providerSessionId: 'provider-child-history',
          role: 'worker',
          status: 'completed',
          modelId: 'model-default',
          transcriptAvailable: true,
          updatedAt: 1,
        },
      ]);

      await h.handle({
        type: 'child.loadHistory',
        parentAppSessionId: 'parent-child-history',
        childSessionId: 'logical-child-history',
        limit: 2,
      });

      const initial = h.events.filter(isSessionHistory).at(-1);
      assert.ok(initial);
      assert.equal(initial.appSessionId, 'parent-child-history');
      assert.equal(initial.childSessionId, 'logical-child-history');
      assert.equal(initial.mode, 'replace');
      assert.equal(initial.loadedCount, 2);
      assert.equal(initial.hasMore, true);
      assert.deepEqual(
        initial.transcripts.map((event) => [event.text, event.appSessionId, event.sourceSessionId]),
        [
          ['middle', 'parent-child-history', 'logical-child-history'],
          ['newest', 'parent-child-history', 'logical-child-history'],
        ],
      );
      assert.equal(
        h.calls.some((call) => call.target === 'history' && call.method === 'recordEvent'),
        false,
      );

      await h.handle({
        type: 'child.loadHistory',
        parentAppSessionId: 'parent-child-history',
        childSessionId: 'logical-child-history',
        cursor: initial.olderCursor,
        limit: 2,
      });

      const older = h.events.filter(isSessionHistory).at(-1);
      assert.ok(older);
      assert.equal(older.mode, 'prepend');
      assert.equal(older.childSessionId, 'logical-child-history');
      assert.equal(older.loadedCount, 1);
      assert.equal(older.hasMore, false);
      assert.deepEqual(
        older.transcripts.map((event) => [event.text, event.appSessionId, event.sourceSessionId]),
        [['oldest', 'parent-child-history', 'logical-child-history']],
      );
    } finally {
      await h.dispose();
    }
  },
);

test(
  'child.loadHistory isolates siblings and returns empty replace for unavailable live history',
  {
    concurrency: false,
  },
  async () => {
    const h = createSessionManagerTestContext();
    try {
      h.fixture.publishSessionFiles([
        writeHistorySession(h.home, 'provider-child-a', [assistantMessage('a', 'child a', 1)]),
        writeHistorySession(h.home, 'provider-child-b', [assistantMessage('b', 'child b', 1)]),
      ]);
      h.history.seedChildSessions([
        {
          parentAppSessionId: 'parent-isolation',
          childSessionId: 'logical-a',
          providerSessionId: 'provider-child-a',
          role: 'worker',
          status: 'completed',
          modelId: 'model-default',
          transcriptAvailable: true,
          updatedAt: 1,
        },
        {
          parentAppSessionId: 'parent-isolation',
          childSessionId: 'logical-b',
          providerSessionId: 'provider-child-b',
          role: 'validator',
          status: 'completed',
          modelId: 'model-default',
          transcriptAvailable: true,
          updatedAt: 2,
        },
        {
          parentAppSessionId: 'parent-isolation',
          childSessionId: 'logical-empty',
          providerSessionId: 'provider-child-empty',
          role: 'worker',
          status: 'running',
          modelId: 'model-default',
          transcriptAvailable: true,
          updatedAt: 3,
        },
      ]);

      await h.handle({
        type: 'child.loadHistory',
        parentAppSessionId: 'parent-isolation',
        childSessionId: 'logical-b',
      });
      const childB = h.events.filter(isSessionHistory).at(-1);
      assert.ok(childB);
      assert.equal(childB.childSessionId, 'logical-b');
      assert.deepEqual(
        childB.transcripts.map((event) => [event.text, event.role]),
        [['child b', 'validator']],
      );

      await h.handle({
        type: 'child.loadHistory',
        parentAppSessionId: 'parent-isolation',
        childSessionId: 'logical-empty',
      });
      const empty = h.events.filter(isSessionHistory).at(-1);
      assert.ok(empty);
      assert.equal(empty.childSessionId, 'logical-empty');
      assert.equal(empty.mode, 'replace');
      assert.equal(empty.loadedCount, 0);
      assert.equal(empty.hasMore, false);
      assert.deepEqual(empty.progress, []);
      assert.deepEqual(empty.transcripts, []);
    } finally {
      await h.dispose();
    }
  },
);

test(
  'child.loadHistory rejects missing child without leaking another child transcript',
  {
    concurrency: false,
  },
  async () => {
    const h = createSessionManagerTestContext();
    try {
      h.fixture.publishSessionFiles([
        writeHistorySession(h.home, 'provider-known-child', [
          assistantMessage('known', 'known', 1),
        ]),
      ]);
      h.history.seedChildSessions([
        {
          parentAppSessionId: 'parent-known',
          childSessionId: 'known-child',
          providerSessionId: 'provider-known-child',
          role: 'worker',
          status: 'completed',
          modelId: 'model-default',
          transcriptAvailable: true,
          updatedAt: 1,
        },
      ]);

      await h.handle({
        type: 'child.loadHistory',
        parentAppSessionId: 'parent-known',
        childSessionId: 'missing-child',
      });

      assert.equal(
        h.events.some(
          (event) =>
            event.type === 'child.error' &&
            event.code === 'child.not_in_session' &&
            event.parentAppSessionId === 'parent-known' &&
            event.childSessionId === 'missing-child',
        ),
        true,
      );
      assert.equal(h.events.some(isSessionHistory), false);
    } finally {
      await h.dispose();
    }
  },
);

test('[A1] Child-session link persistence', { concurrency: false }, async () => {
  const h = createSessionManagerTestContext();

  try {
    await h.create({
      sessionPurpose: 'mission-control',
      clientRef: 'a1',
      title: 'A1',
      goal: 'go',
      configuration: droidSessionConfiguration({
        modelId: 'model-default',
        interactionMode: 'agi',
        autonomy: 'low',
      }),
    });
    const parent = h.provider.session('provider-1');
    await parent.waitForPrompts(1);
    await h.waitForIdle();
    h.history.seedSessionLaunchSettings('worker-a1', { modelId: 'model-default' });
    parent.queueStreamEvents([
      {
        type: 'tool_progress',
        toolName: 'Task',
        toolUseId: 'tool-a1',
        content: '',
        update: {
          type: 'tool_call',
          subagentSessionId: 'worker-a1',
          parameters: { subagent_type: 'worker' },
        },
      },
    ]);
    await h.handle({
      type: 'session.send',
      appSessionId: 'provider-1',
      text: 'spawn worker',
    });

    const persistence = h.calls.find(
      (call) => call.target === 'history' && call.method === 'upsertChildSession',
    )?.args[0];
    assert.ok(persistence && typeof persistence === 'object');
    assert.deepEqual(
      {
        parentAppSessionId: Reflect.get(persistence, 'parentAppSessionId'),
        childSessionId: Reflect.get(persistence, 'childSessionId'),
        providerSessionId: Reflect.get(persistence, 'providerSessionId'),
        role: Reflect.get(persistence, 'role'),
        label: Reflect.get(persistence, 'label'),
        status: Reflect.get(persistence, 'status'),
        modelId: Reflect.get(persistence, 'modelId'),
        spawnLink: Reflect.get(persistence, 'spawnLink'),
        transcriptAvailable: Reflect.get(persistence, 'transcriptAvailable'),
      },
      {
        parentAppSessionId: 'provider-1',
        childSessionId: 'child-1',
        providerSessionId: 'worker-a1',
        role: 'worker',
        label: 'worker',
        status: 'running',
        modelId: 'model-default',
        spawnLink: { kind: 'tool-use', id: 'tool-a1' },
        transcriptAvailable: true,
      },
    );
    assert.equal(
      h.events.some(
        (event) =>
          event.type === 'session.child' &&
          event.child.parentAppSessionId === 'provider-1' &&
          event.child.childSessionId === 'child-1' &&
          event.child.status === 'running',
      ),
      true,
    );
  } finally {
    await h.dispose();
  }
});

test('[A1b] a Task child waits for exact launch settings without failing its parent', async () => {
  const h = createSessionManagerTestContext({
    getFactoryDefaults: () => Promise.resolve({}),
  });

  try {
    await h.create({
      sessionPurpose: 'mission-control',
      clientRef: 'a1b',
      title: 'A1b',
      goal: 'go',
      configuration: droidSessionConfiguration({
        modelId: 'model-default',
        interactionMode: 'agi',
        autonomy: 'low',
      }),
    });
    const parent = h.provider.session('provider-1');
    await parent.waitForPrompts(1);
    await h.waitForIdle();
    parent.queueStreamEvents([
      {
        type: 'tool_progress',
        toolName: 'Task',
        toolUseId: 'tool-a1b',
        content: '',
        update: {
          type: 'tool_call',
          subagentSessionId: 'worker-a1b',
          parameters: { subagent_type: 'worker' },
        },
      },
    ]);
    await h.handle({
      type: 'session.send',
      appSessionId: 'provider-1',
      text: 'spawn worker',
    });

    assert.equal(h.history.childSessions('provider-1').length, 0);
    assert.equal(
      h.events.some((event) => event.type === 'error'),
      false,
    );

    h.history.seedSessionLaunchSettings('worker-a1b', { modelId: 'model-exact' });
    parent.queueStreamEvents([
      {
        type: 'tool_result',
        toolName: 'Task',
        toolUseId: 'tool-a1b',
        content: 'session_id: worker-a1b\ndone',
        isError: false,
      },
    ]);
    await h.handle({
      type: 'session.send',
      appSessionId: 'provider-1',
      text: 'collect worker',
    });

    const child = h.history.childSessions('provider-1')[0];
    assert.equal(child?.modelId, 'model-exact');
    assert.equal(child?.status, 'completed');
  } finally {
    await h.dispose();
  }
});

test('[A1c] provider replacement preserves the logical child identity', async () => {
  const h = createSessionManagerTestContext();

  try {
    await h.create({
      sessionPurpose: 'mission-control',
      clientRef: 'a1c',
      title: 'A1c',
      goal: 'go',
      configuration: droidSessionConfiguration({
        modelId: 'model-default',
        interactionMode: 'agi',
        autonomy: 'low',
      }),
    });
    const parent = h.provider.session('provider-1');
    await parent.waitForPrompts(1);
    await h.waitForIdle();
    h.history.seedSessionLaunchSettings('worker-a1c-old', { modelId: 'model-default' });
    h.history.seedSessionLaunchSettings('worker-a1c-new', { modelId: 'model-default' });
    const observeProvider = async (providerSessionId: string, text: string): Promise<void> => {
      parent.queueStreamEvents([
        {
          type: 'tool_progress',
          toolName: 'Task',
          toolUseId: 'tool-a1c',
          content: '',
          update: {
            type: 'tool_call',
            subagentSessionId: providerSessionId,
            parameters: { subagent_type: 'worker' },
          },
        },
      ]);
      await h.handle({
        type: 'session.send',
        appSessionId: 'provider-1',
        text,
      });
    };

    await observeProvider('worker-a1c-old', 'spawn worker');
    await h.handle({
      type: 'child.open',
      parentAppSessionId: 'provider-1',
      childSessionId: 'child-1',
      requestId: 'open-child-a1c-old',
    });
    await observeProvider('worker-a1c-new', 'replace worker runtime');
    await h.waitForIdle();

    const children = h.history.childSessions('provider-1');
    assert.equal(children.length, 1);
    assert.equal(children[0]?.childSessionId, 'child-1');
    assert.equal(children[0]?.providerSessionId, 'worker-a1c-new');
    assert.equal(
      h.calls.some(
        (call) =>
          call.target === 'cleanup' &&
          call.method === 'session.close' &&
          call.args[0] === 'worker-a1c-old',
      ),
      true,
    );

    await h.handle({
      type: 'child.open',
      parentAppSessionId: 'provider-1',
      childSessionId: 'child-1',
      requestId: 'open-child-a1c-new',
    });
    assert.equal(h.runtime.loadCalls.at(-1)?.sessionId, 'worker-a1c-new');
    assert.equal(
      h.events.some(
        (event) =>
          event.type === 'child.updated' &&
          event.requestId === 'open-child-a1c-new' &&
          event.childSessionId === 'child-1' &&
          event.access === 'ready' &&
          event.runtimeGeneration === 4,
      ),
      true,
    );

    await observeProvider('worker-a1c-old', 'late stale worker observation');
    assert.equal(
      h.history.childSession('provider-1', 'child-1')?.providerSessionId,
      'worker-a1c-new',
    );
    assert.equal(
      h.calls.some(
        (call) =>
          call.target === 'cleanup' &&
          call.method === 'session.close' &&
          call.args[0] === 'worker-a1c-new',
      ),
      false,
    );
  } finally {
    await h.dispose();
  }
});

test('[A2] Open and replay a linked child session', { concurrency: false }, async () => {
  const h = createSessionManagerTestContext();

  try {
    h.fixture.seedHistorySummaries([summary('app-a2', 'provider-a2')]);
    h.fixture.seedChildSessions([
      linkedWorker('app-a2', 'worker-a2', 'tool-a2', 'paused'),
      linkedWorker('app-a2', 'worker-unknown-a2', 'tool-unknown-a2'),
    ]);
    h.fixture.publishSessionFiles([
      writeHistorySession(h.home, 'provider-a2', [
        {
          type: 'message',
          id: 'user-a2',
          timestamp: new Date(0).toISOString(),
          message: { role: 'user', content: [{ type: 'text', text: 'parent prompt' }] },
        },
        assistantMessage('parent-a2', 'parent response', 1),
      ]),
      writeHistorySession(h.home, 'worker-a2', [assistantMessage('child-a2', 'child replay', 0)], {
        callingSessionId: 'provider-a2',
        callingToolUseId: 'tool-a2',
      }),
    ]);

    await h.handle({ type: 'session.loadHistory', appSessionId: 'app-a2' });
    const historical = h.events.filter(isSessionHistory).at(-1);
    assert.ok(historical);
    assert.equal(
      historical.childSessions?.find((child) => child.childSessionId === 'worker-a2')?.status,
      'paused',
    );
    assert.equal(
      historical.childSessions?.find((child) => child.childSessionId === 'worker-unknown-a2')
        ?.status,
      'completed',
    );

    await h.handle({ type: 'session.resume', appSessionId: 'app-a2' });
    await h.handle({
      type: 'child.open',
      parentAppSessionId: 'app-a2',
      childSessionId: 'worker-a2',
      requestId: 'open-worker-a2',
    });
    const primary = h.provider.session('provider-a2');
    h.history.seedSessionLaunchSettings('worker-completed-a2', {
      modelId: 'model-default',
    });
    h.history.seedSessionLaunchSettings('worker-running-a2', {
      modelId: 'model-default',
    });
    primary.queueStreamEvents([
      {
        type: 'tool_progress',
        toolName: 'Task',
        toolUseId: 'tool-completed-a2',
        content: '',
        update: {
          type: 'tool_call',
          subagentSessionId: 'worker-completed-a2',
          parameters: { subagent_type: 'worker' },
        },
      },
      {
        type: 'tool_result',
        toolName: 'Task',
        toolUseId: 'tool-completed-a2',
        content: 'done',
        isError: false,
      },
      {
        type: 'tool_progress',
        toolName: 'Task',
        toolUseId: 'tool-running-a2',
        content: '',
        update: {
          type: 'tool_call',
          subagentSessionId: 'worker-running-a2',
          parameters: { subagent_type: 'worker' },
        },
      },
    ]);
    await h.handle({
      type: 'session.send',
      appSessionId: 'app-a2',
      text: 'run child',
    });
    await h.handle({ type: 'session.loadHistory', appSessionId: 'app-a2' });

    assert.equal(h.runtime.loadCalls.at(-1)?.sessionId, 'worker-a2');
    assert.equal(
      h.events.some(
        (event) =>
          event.type === 'child.updated' &&
          event.childSessionId === 'worker-a2' &&
          event.access === 'ready',
      ),
      true,
    );
    assert.equal(
      h.events.some(
        (event) =>
          event.type === 'session.history' &&
          event.childSessionId === 'worker-a2' &&
          event.transcripts.some(
            (transcript) =>
              transcript.sourceSessionId === 'worker-a2' && transcript.text === 'child replay',
          ),
      ),
      true,
    );
    const live = h.events.filter(isSessionHistory).at(-1);
    assert.ok(live);
    assert.equal(
      live.childSessions?.find((child) => child.childSessionId === 'worker-a2')?.status,
      'paused',
    );
    assert.equal(
      live.childSessions?.find((child) => child.spawnLink?.id === 'tool-completed-a2')?.status,
      'completed',
    );
    assert.equal(
      live.childSessions?.find((child) => child.spawnLink?.id === 'tool-running-a2')?.status,
      'running',
    );
    assert.equal(
      live.childSessions?.find((child) => child.childSessionId === 'worker-unknown-a2')?.status,
      'completed',
    );
  } finally {
    await h.dispose();
  }
});

test('[A3] Child send, steer, and interrupt', { concurrency: false }, async () => {
  const h = createSessionManagerTestContext();

  try {
    h.fixture.seedHistorySummaries([summary('app-a3', 'provider-a3')]);
    h.fixture.seedChildSessions([
      linkedWorker('app-a3', 'worker-a3', 'tool-a3', 'paused'),
      linkedWorker('app-a3', 'worker-failed-a3', 'tool-failed-a3', 'paused'),
    ]);

    await h.handle({ type: 'session.resume', appSessionId: 'app-a3' });
    await h.handle({
      type: 'child.open',
      parentAppSessionId: 'app-a3',
      childSessionId: 'worker-a3',
      requestId: 'open-worker-a3',
    });

    const gate = h.provider.deferNextStream('worker-a3');
    const sending = h.handle({
      type: 'child.send',
      parentAppSessionId: 'app-a3',
      childSessionId: 'worker-a3',
      text: 'normal',
    });
    await h.provider.waitForPrompts('worker-a3', 1);
    await h.handle({
      type: 'child.sendNow',
      parentAppSessionId: 'app-a3',
      childSessionId: 'worker-a3',
      text: 'steer',
    });
    gate.resolve();
    await sending;
    await h.provider.waitForPrompts('worker-a3', 2);
    await h.handle({
      type: 'child.interrupt',
      parentAppSessionId: 'app-a3',
      childSessionId: 'worker-a3',
    });

    const parentUpdates = h.events.filter(
      (event) => isSessionUpdated(event) && event.session.appSessionId === 'app-a3',
    );
    h.runtime.loadQueue.set('worker-failed-a3', [new Error('child load failed')]);
    await h.handle({
      type: 'child.open',
      parentAppSessionId: 'app-a3',
      childSessionId: 'worker-failed-a3',
      requestId: 'open-worker-failed-a3',
    });

    assert.deepEqual(h.provider.session('worker-a3').prompts, ['normal', 'steer']);
    assert.equal(
      h.calls.filter(
        (call) =>
          call.target === 'provider' && call.method === 'interrupt' && call.args[0] === 'worker-a3',
      ).length,
      2,
    );
    assert.equal(
      h.events.some(
        (event) =>
          event.type === 'child.error' &&
          event.code === 'child.open_failed' &&
          event.parentAppSessionId === 'app-a3' &&
          event.childSessionId === 'worker-failed-a3',
      ),
      true,
    );
    const loadCallCount = h.runtime.loadCalls.length;
    await h.handle({
      type: 'child.open',
      parentAppSessionId: 'app-a3',
      childSessionId: 'worker-unknown-a3',
      requestId: 'open-worker-unknown-a3',
    });
    assert.equal(h.runtime.loadCalls.length, loadCallCount);
    assert.equal(
      h.events.some(
        (event) =>
          event.type === 'child.error' &&
          event.code === 'child.not_in_session' &&
          event.childSessionId === 'worker-unknown-a3',
      ),
      true,
    );
    assert.equal(
      h.events.some(
        (event) => event.type === 'child.updated' && event.childSessionId === 'worker-unknown-a3',
      ),
      false,
    );
    assert.deepEqual(
      h.events.filter(
        (event) => isSessionUpdated(event) && event.session.appSessionId === 'app-a3',
      ),
      parentUpdates,
    );
  } finally {
    await h.dispose();
  }
});

test('[A4] Opening a child for a non-live historical session settles honestly', async () => {
  const h = createSessionManagerTestContext();

  try {
    h.fixture.seedHistorySummaries([summary('app-a4', 'provider-a4')]);
    h.fixture.seedChildSessions([linkedWorker('app-a4', 'worker-a4', 'tool-a4')]);

    await h.handle({
      type: 'child.open',
      parentAppSessionId: 'app-a4',
      childSessionId: 'worker-a4',
      requestId: 'open-worker-a4',
    });

    assert.equal(h.runtime.loadCalls.length, 0);
    assert.equal(
      h.events.some(
        (event) =>
          event.type === 'child.updated' &&
          event.parentAppSessionId === 'app-a4' &&
          event.childSessionId === 'worker-a4' &&
          event.access === 'history',
      ),
      true,
    );
    assert.equal(
      h.events.some(
        (event) =>
          event.type === 'child.error' &&
          event.parentAppSessionId === 'app-a4' &&
          event.childSessionId === 'worker-a4',
      ),
      false,
    );
  } finally {
    await h.dispose();
  }
});

test('fork, rewind, and rename fail for a cursor summary before loadSession', async () => {
  const historical = {
    ...summary('app-cursor', 'provider-cursor'),
    configuration: cursorSessionConfiguration({ modelId: 'cursor-model' }),
  };
  let loads = 0;
  for (const { capability, operation } of [
    { capability: 'fork' as const, operation: 'forkSession' },
    { capability: 'rewind' as const, operation: 'getRewindInfo' },
    { capability: 'rewind' as const, operation: 'executeRewind' },
    { capability: undefined, operation: 'renameSession' },
  ]) {
    await assert.rejects(
      () =>
        withDroidSession({
          live: undefined,
          summary: historical,
          appSessionId: 'app-cursor',
          ...(capability === undefined ? {} : { capability }),
          operation,
          snapshotCapabilities: () => undefined,
          loadSession: async () => {
            loads += 1;
            throw new Error('should not load a cursor session');
          },
          fn: async () => undefined,
        }),
      (error: unknown) => {
        assert.ok(error instanceof ProviderContractError);
        assert.equal(error.code, 'unsupported_capability');
        assert.equal(error.providerInstanceId, 'cursor');
        assert.match(error.message, new RegExp(operation));
        return true;
      },
    );
  }
  assert.equal(loads, 0);
});
