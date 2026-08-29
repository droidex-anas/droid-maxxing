import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  ReasoningEffort,
  type AskUserResult,
  type RequestPermissionHandlerResult,
} from '@factory/droid-sdk';
import type { FactoryDefaultSettings, ServerEvent, SessionSummary } from './protocol.js';
import {
  SessionLifecycle,
  type LiveSession,
  type SessionCreateCommand,
} from './SessionLifecycle.js';
import { SessionRegistry } from './SessionRegistry.js';
import {
  FakeFactoryRuntime,
  FakeFactorySession,
  type RecordedCall,
} from './testing/fakeFactoryRuntime.js';
import { encodeDroidResumeState } from './providers/droid/DroidModeMapping.js';
import { droidSessionConfiguration } from './providers/providerIdentity.js';
import { ShutdownDeadline } from './providers/shutdownDeadline.js';
import {
  DroidProviderAdapter,
  takeDroidOpenedMcp,
} from './providers/droid/DroidProviderAdapter.js';
import { createDefaultProviderRegistry } from './providers/ProviderRegistry.js';
import { DroidexDatabase } from './persistence/DroidexDatabase.js';
import { SessionStore } from './persistence/SessionStore.js';
import { TranscriptStore } from './persistence/TranscriptStore.js';
import type { SessionCreateBoundary } from './sessionCreateIdentity.js';

const ownedStores: Array<{ db: DroidexDatabase; dir: string }> = [];

test.after(() => {
  for (const { db, dir } of ownedStores) {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

function seedStoredSession(store: SessionStore, summary: SessionSummary): void {
  store.createProvisional(
    {
      appSessionId: summary.appSessionId,
      clientRef: `ref-${summary.appSessionId}`,
      summary,
    },
    summary.updatedAt,
  );
  if (summary.providerSessionId) {
    store.bindInitialProviderRuntime(
      summary.appSessionId,
      0,
      summary.providerSessionId,
      encodeDroidResumeState(summary.providerSessionId),
    );
  }
  store.markStarted(summary.appSessionId, summary.updatedAt);
}

function wrapSessionStore(store: SessionStore, calls: RecordedCall[]) {
  const persisted: SessionSummary[] = [];
  let nextUpdateError: Error | undefined;
  return {
    persisted,
    failNextUpdate(error: Error) {
      nextUpdateError = error;
    },
    store: {
      createProvisional: store.createProvisional.bind(store),
      findByClientRef: store.findByClientRef.bind(store),
      bindInitialProviderRuntime: store.bindInitialProviderRuntime.bind(store),
      markStarted: store.markStarted.bind(store),
      markFailed: store.markFailed.bind(store),
      beginRetryStart: store.beginRetryStart.bind(store),
      removeFailed: store.removeFailed.bind(store),
      get: store.get.bind(store),
      list: store.list.bind(store),
      updateResumeState: store.updateResumeState.bind(store),
      replaceProviderRuntime: store.replaceProviderRuntime.bind(store),
      upsertChild: store.upsertChild.bind(store),
      getChild: store.getChild.bind(store),
      listChildren: store.listChildren.bind(store),
      updateSummary: (...args: Parameters<SessionStore['updateSummary']>) => {
        if (nextUpdateError) {
          const error = nextUpdateError;
          nextUpdateError = undefined;
          throw error;
        }
        const result = store.updateSummary(...args);
        persisted.push({ ...result.summary });
        calls.push({ target: 'store', method: 'updateSummary', args: [result.summary] });
        return result;
      },
    },
  };
}

class RejectingInterruptSession extends FakeFactorySession {
  override interrupt(): Promise<void> {
    return super.interrupt().then(() => {
      throw new Error('interrupt rejected');
    });
  }
}

class CallbackCloseSession extends FakeFactorySession {
  constructor(
    sessionId: string,
    calls: RecordedCall[],
    private readonly afterClose: () => Promise<void>,
  ) {
    super(sessionId, {}, calls);
  }

  override async close(): Promise<void> {
    await super.close();
    await this.afterClose();
  }
}

class RejectingCloseSession extends FakeFactorySession {
  override async close(): Promise<void> {
    await super.close();
    throw new Error(`close failed: ${this.sessionId}`);
  }
}

function createHarness(
  ordinarySummaries: SessionSummary[] = [],
  options: {
    sessionStore?: ConstructorParameters<typeof SessionLifecycle>[0]['sessionStore'];
    transcriptStore?: ConstructorParameters<typeof SessionLifecycle>[0]['transcriptStore'];
    atomic?: ConstructorParameters<typeof SessionLifecycle>[0]['atomic'];
    nextAppSessionId?: () => string;
    nextTurnId?: () => string;
    nextId?: () => string;
    onCreateBoundary?: ConstructorParameters<typeof SessionLifecycle>[0]['onCreateBoundary'];
    attachSessionStore?: boolean;
  } = {},
) {
  const calls: RecordedCall[] = [];
  const events: ServerEvent[] = [];
  const appliedProviderEvents: unknown[] = [];
  const publicationRegistration: boolean[] = [];
  const forgettingAfterUnregister: boolean[] = [];
  const eventFlowForgettingAfterUnregister: boolean[] = [];
  const missionForgettingAfterUnregister: boolean[] = [];
  const runtime = new FakeFactoryRuntime(calls);
  let projection: Partial<SessionSummary> = {};
  let applyPending: (appSessionId: string) => Promise<boolean> = () => Promise.resolve(true);
  let enableAutoCompaction = (): Promise<boolean> => Promise.resolve(true);
  let compactionLimit = (): Promise<number> => Promise.resolve(800);
  let shutdownStarted = false;
  let closeChildren: (appSessionId: string) => Promise<void> = () => Promise.resolve();
  let emitSessionList: (closedProviderSessionId: string) => void | Promise<void> = () =>
    recordEvent({ type: 'sessions.list', ...registry.listSummaries() });
  let nextEmitFailure: { type: ServerEvent['type']; error: Error } | undefined;
  let now = 10_000;
  let mcpId = 0;
  let rawStore = options.sessionStore;
  if (!rawStore) {
    const dir = mkdtempSync(join(tmpdir(), 'droidex-lifecycle-'));
    const db = new DroidexDatabase(join(dir, 'state', 'droidex.sqlite'));
    ownedStores.push({ db, dir });
    rawStore = new SessionStore(db);
  }
  const wrapped = wrapSessionStore(rawStore as SessionStore, calls);
  for (const row of ordinarySummaries) {
    seedStoredSession(rawStore as SessionStore, row);
  }
  const attachStoreToLifecycle =
    Boolean(options.sessionStore) ||
    (options.attachSessionStore ?? ordinarySummaries.length > 0);
  const recordEvent = (event: ServerEvent): void => {
    if (nextEmitFailure?.type === event.type) {
      const error = nextEmitFailure.error;
      nextEmitFailure = undefined;
      throw error;
    }
    events.push(event);
    calls.push({ target: 'protocol', method: event.type, args: [event] });
    if (event.type === 'session.created' || event.type === 'session.updated') {
      publicationRegistration.push(registry.getLive(event.session.appSessionId) !== undefined);
    }
  };
  const registry = new SessionRegistry<LiveSession>({
    projectSummary: (item) => ({ ...item, ...projection }),
    onSummaryUpdated: (session) => recordEvent({ type: 'session.updated', session }),
    now: () => {
      now += 1;
      return now;
    },
    sessionStore: wrapped.store,
  });
  const defaults: FactoryDefaultSettings = {
    modelId: 'model-default',
    reasoningEffort: ReasoningEffort.Low,
    autonomy: 'low',
    interactionMode: 'auto',
  };
  const mcpRefs: string[] = [];
  const startLocalMcpServers = (ref?: { id: string }) => {
    if (ref) mcpRefs.push(ref.id);
    const resourceId = ++mcpId;
    calls.push({ target: 'runtime', method: 'mcp.start', args: [resourceId] });
    return Promise.resolve({
      servers: [
        {
          close: () => {
            calls.push({
              target: 'cleanup',
              method: 'mcp.close',
              args: [`mcp-${resourceId}`],
            });
            return Promise.resolve();
          },
        },
      ],
      configs: [],
    });
  };
  const lifecycle = new SessionLifecycle({
    providers: createDefaultProviderRegistry({
      droid: () =>
        new DroidProviderAdapter({
          runtime,
          startLocalMcpServers,
          makePermissionHandler: () => () =>
            new Promise<RequestPermissionHandlerResult>(() => undefined),
          makeAskUserHandler: () => () => new Promise<AskUserResult>(() => undefined),
        }),
    }),
    registry,
    ensureConnected: () => {
      calls.push({ target: 'runtime', method: 'ensureConnected', args: [] });
    },
    getFactoryDefaults: () => Promise.resolve(defaults),
    maxContextTokensForModel: () => 1_000,
    childSessions: {
      attachParent: (appSessionId) => {
        calls.push({ target: 'cleanup', method: 'children.attach', args: [appSessionId] });
      },
      closeParent: (appSessionId) => closeChildren(appSessionId),
    },
    takeOpenedResources: (provider) => takeDroidOpenedMcp(provider) ?? { servers: [], configs: [] },
    interactionSink: {
      requestApproval: async () => ({ decision: 'cancel' as const }),
      requestQuestion: async () => ({ status: 'cancelled' as const }),
      requestPlanReview: async () => ({ decision: 'cancel' as const }),
    },
    eventFlow: {
      apply: (event) => {
        appliedProviderEvents.push(event);
      },
      beginTurn: () => undefined,
    },
    ...(attachStoreToLifecycle ? { sessionStore: wrapped.store } : {}),
    ...(options.transcriptStore ? { transcriptStore: options.transcriptStore } : {}),
    ...(options.atomic ? { atomic: options.atomic } : {}),
    ...(options.nextId ? { nextId: options.nextId } : {}),
    ...(options.onCreateBoundary ? { onCreateBoundary: options.onCreateBoundary } : {}),
    nextAppSessionId:
      options.nextAppSessionId ??
      (() => {
        const queued = runtime.createQueue[0];
        return queued instanceof FakeFactorySession ? queued.sessionId : randomUUID();
      }),
    ...(options.nextTurnId ? { nextTurnId: options.nextTurnId } : {}),
    compaction: {
      resolveLimit: () => compactionLimit(),
      arm: async (target, limit) => {
        if (!target.isCurrent()) return false;
        calls.push({
          target: 'provider',
          method: 'autoCompaction.arm',
          args: [target.session.sessionId, limit],
        });
        const armed = await enableAutoCompaction();
        return target.isCurrent() && armed;
      },
      subscribePrimary: (liveSession) => {
        liveSession.unsubscribe = liveSession.session.onNotification(() => undefined);
      },
      afterTurn: (liveSession) => {
        calls.push({
          target: 'cleanup',
          method: 'autoCompaction.settled',
          args: [liveSession.summary.appSessionId],
        });
      },
      cancel: (liveSession) => {
        liveSession.autoCompacting = false;
        calls.push({
          target: 'cleanup',
          method: 'watchdog.clear',
          args: [liveSession.summary.appSessionId],
        });
      },
      forgetSession: (appSessionId) => {
        calls.push({
          target: 'cleanup',
          method: 'compaction.forgetSession',
          args: [appSessionId],
        });
      },
    },
    isShutdownStarted: () => shutdownStarted,
    applyPendingSettingsToSummary: (item) => ({ ...item, ...projection }),
    applyPendingSessionSettings: (appSessionId) => applyPending(appSessionId),
    preparePrimaryTurn: async () => true,
    finishPrimaryTurn: async () => undefined,
    context: {
      refresh: (liveSession) => {
        calls.push({
          target: 'provider',
          method: 'context.refresh',
          args: [liveSession.summary.appSessionId],
        });
        return Promise.resolve();
      },
      stopSession: (live) => {
        calls.push({
          target: 'cleanup',
          method: 'poll.stop',
          args: [live.summary.appSessionId],
        });
        if (live.summary.providerSessionId)
          calls.push({
            target: 'cleanup',
            method: 'poll.stop',
            args: [live.summary.providerSessionId],
          });
      },
      forgetSession: (live) => {
        calls.push({
          target: 'cleanup',
          method: 'runtimeCaches.clear',
          args: [live.summary.appSessionId],
        });
      },
    },
    forgetInteractions: (appSessionId) => {
      forgettingAfterUnregister.push(registry.getLive(appSessionId) === undefined);
      calls.push({ target: 'cleanup', method: 'interactions.forget', args: [appSessionId] });
    },
    forgetEventFlow: (appSessionId) => {
      eventFlowForgettingAfterUnregister.push(registry.getLive(appSessionId) === undefined);
      calls.push({ target: 'cleanup', method: 'eventFlow.forget', args: [appSessionId] });
    },
    forgetMissionControl: (appSessionId) => {
      missionForgettingAfterUnregister.push(registry.getLive(appSessionId) === undefined);
      calls.push({ target: 'cleanup', method: 'missionControl.forget', args: [appSessionId] });
    },
    forgetPendingSettings: (appSessionId) => {
      calls.push({ target: 'cleanup', method: 'pendingSettings.forget', args: [appSessionId] });
    },
    closeBrowserSession: (appSessionId) => {
      calls.push({ target: 'browser', method: 'browser.close', args: [appSessionId] });
      return Promise.resolve();
    },
    emit: recordEvent,
    emitError: (error) => recordEvent({ type: 'error', ...error }),
    emitStatus: (appSessionId, text) => {
      calls.push({ target: 'protocol', method: 'status', args: [appSessionId, text] });
    },
    emitSessionList: (closedProviderSessionId) => emitSessionList(closedProviderSessionId),
  });

  return {
    calls,
    events,
    appliedProviderEvents,
    store: wrapped.store,
    persisted: wrapped.persisted,
    failNextPersist: wrapped.failNextUpdate,
    runtime,
    registry,
    lifecycle,
    mcpRefs,
    publicationRegistration,
    forgettingAfterUnregister,
    eventFlowForgettingAfterUnregister,
    missionForgettingAfterUnregister,
    setProjection: (patch: Partial<SessionSummary>) => {
      projection = { ...patch };
    },
    setPendingApply: (action: (appSessionId: string) => Promise<boolean>) => {
      applyPending = action;
    },
    setEnableAutoCompaction: (action: () => Promise<boolean>) => {
      enableAutoCompaction = action;
    },
    setCompactionLimit: (action: () => Promise<number>) => {
      compactionLimit = action;
    },
    setEmitSessionList: (action: (closedProviderSessionId: string) => void | Promise<void>) => {
      emitSessionList = action;
    },
    setShutdownStarted: (started: boolean) => {
      shutdownStarted = started;
    },
    setChildCloser: (action: (appSessionId: string) => Promise<void>) => {
      closeChildren = action;
    },
    failNextEmit: (type: ServerEvent['type'], error: Error) => {
      nextEmitFailure = { type, error };
    },
  };
}

type Harness = ReturnType<typeof createHarness>;

function summary(
  appSessionId: string,
  providerSessionId = appSessionId,
  patch: Partial<SessionSummary> = {},
): SessionSummary {
  return {
    appSessionId,
    providerSessionId,
    sessionPurpose: 'chat',
    role: 'user',
    title: appSessionId,
    goal: 'test',
    cwd: '/workspace',
    workspaceKind: 'folder',
    configuration: droidSessionConfiguration({
      modelId: 'model-default',
      reasoningEffort: ReasoningEffort.Low,
      interactionMode: 'auto',
      autonomy: 'low',
    }),
    phase: 'paused',
    features: [],
    tokensIn: 0,
    tokensOut: 0,
    contextTokens: 0,
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}

function createCommand(goal = 'first'): SessionCreateCommand {
  return {
    type: 'session.create',
    clientRef: 'client-1',
    title: 'Test session',
    goal,
    cwd: '/workspace',
    sessionPurpose: 'chat',
    configuration: droidSessionConfiguration({
      modelId: 'model-default',
      interactionMode: 'auto',
      autonomy: 'low',
    }),
  };
}

function queueCreate(harness: Harness, sessionId: string): FakeFactorySession {
  const session = new FakeFactorySession(sessionId, {}, harness.calls);
  harness.runtime.createQueue.push(session);
  return session;
}

function queueLoad(
  harness: Harness,
  providerSessionId: string,
  session: FakeFactorySession = new FakeFactorySession(providerSessionId, {}, harness.calls),
): FakeFactorySession {
  harness.runtime.loadQueue.set(providerSessionId, [session]);
  return session;
}

function requireLive(harness: Harness, id: string): LiveSession {
  const live = harness.registry.getLive(id);
  assert.ok(live);
  return live;
}

function interruptCount(harness: Harness): number {
  return harness.calls.filter((call) => call.target === 'provider' && call.method === 'interrupt')
    .length;
}

test('create and cold resume publish only after registration', async () => {
  const created = createHarness();
  const createdProvider = queueCreate(created, 'created-1');
  await created.lifecycle.create(createCommand());
  await createdProvider.waitForPrompts(1);
  const createTrace = created.calls.map((call) => call.method);
  const createPublished = createTrace.indexOf('session.created');
  assert.ok(createPublished >= 0);
  assert.ok(createPublished < createTrace.indexOf('stream'));
  assert.equal(created.registry.getCanonicalSummary('created-1')?.appSessionId, 'created-1');
  assert.equal(created.runtime.createCalls[0]?.cwd, '/workspace');
  assert.equal(created.publicationRegistration.every(Boolean), true);
  const resumed = createHarness([summary('app-2', 'provider-2')]);
  queueLoad(resumed, 'provider-2');
  await resumed.lifecycle.resume('app-2');

  const resumeTrace = resumed.calls.map((call) => call.method);
  assert.deepEqual(
    resumeTrace.filter((method) =>
      ['loadSession', 'autoCompaction.arm', 'onNotification', 'updateSummary'].includes(method),
    ),
    ['loadSession', 'autoCompaction.arm', 'onNotification', 'updateSummary'],
  );
  assert.deepEqual(
    resumed.events.slice(-2).map((event) => event.type),
    ['session.created', 'session.updated'],
  );
  assert.equal(resumed.runtime.loadCalls[0]?.handlers.cwd, '/workspace');
  assert.equal(resumed.publicationRegistration.every(Boolean), true);
});

test('create persists a canonical app id that is not the native session id', async () => {
  const created = createHarness([], { nextAppSessionId: () => 'app-canonical-1' });
  const createdProvider = queueCreate(created, 'native-9');
  await created.lifecycle.create(createCommand());
  await createdProvider.waitForPrompts(1);
  const published = created.events.find((event) => event.type === 'session.created');
  assert.equal(published?.type, 'session.created');
  if (published?.type === 'session.created') {
    assert.equal(published.session.appSessionId, 'app-canonical-1');
    assert.notEqual(published.session.appSessionId, 'native-9');
  }
  assert.equal(created.registry.getLive('app-canonical-1')?.provider.providerSessionId, 'native-9');
  assert.equal(created.runtime.createCalls.length, 1);
});

test('folder-less chats run in the DROIDEX chats directory', async (t) => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'droidex-user-data-'));
  const previousUserDataDir = process.env.DROIDEX_USER_DATA_DIR;
  process.env.DROIDEX_USER_DATA_DIR = userDataDir;
  t.after(async () => {
    if (previousUserDataDir === undefined) delete process.env.DROIDEX_USER_DATA_DIR;
    else process.env.DROIDEX_USER_DATA_DIR = previousUserDataDir;
    await rm(userDataDir, { recursive: true, force: true });
  });

  const harness = createHarness();
  const provider = queueCreate(harness, 'plain-chat');
  await harness.lifecycle.create({ ...createCommand(), cwd: '' });
  await provider.waitForPrompts(1);

  const chatCwd = join(userDataDir, 'chats');
  assert.equal(harness.runtime.createCalls[0]?.cwd, chatCwd);
  assert.equal((await stat(chatCwd)).isDirectory(), true);
  assert.deepEqual(
    harness.registry.getCanonicalSummary('plain-chat') && {
      cwd: harness.registry.getCanonicalSummary('plain-chat')?.cwd,
      workspaceKind: harness.registry.getCanonicalSummary('plain-chat')?.workspaceKind,
    },
    { cwd: '', workspaceKind: 'none' },
  );
});

test('create omits an unarmed daemon compaction limit from its summary', async () => {
  const harness = createHarness();
  const provider = queueCreate(harness, 'unarmed-create');
  harness.setEnableAutoCompaction(() => Promise.resolve(false));

  await harness.lifecycle.create(createCommand());
  await provider.waitForPrompts(1);

  const created = harness.events.find(
    (event) => event.type === 'session.created' && event.session.appSessionId === 'unarmed-create',
  );
  assert.equal(created?.type, 'session.created');
  assert.equal(created.session.compactionTokenLimit, undefined);
  assert.equal(
    harness.registry.getCanonicalSummary('unarmed-create')?.compactionTokenLimit,
    undefined,
  );
  assert.equal(
    harness.calls.some(
      (call) =>
        call.method === 'autoCompaction.arm' &&
        call.args[0] === 'unarmed-create' &&
        call.args[1] === 800,
    ),
    true,
  );
});

test('create failure closes started MCP resources without publishing', async () => {
  const harness = createHarness();
  harness.runtime.createQueue.push(new Error('create failed'));
  await harness.lifecycle.create(createCommand());
  assert.equal(harness.calls.filter((call) => call.method === 'mcp.close').length, 1);
  assert.equal(harness.persisted.length, 0);
  assert.equal(
    harness.events.some((event) => event.type === 'session.created'),
    false,
  );
  assert.equal(
    harness.events.some(
      (event) =>
        event.type === 'error' &&
        event.code === 'session.create_failed' &&
        event.clientRef === 'client-1' &&
        event.message === 'create failed',
    ),
    true,
  );
});

test('post-open create and resume failures close provider and MCP resources', async () => {
  const created = createHarness();
  queueCreate(created, 'failed-create');
  created.setEnableAutoCompaction(() => Promise.reject(new Error('create setup failed')));
  await created.lifecycle.create(createCommand());
  assert.deepEqual(
    created.calls
      .filter((call) => call.method === 'mcp.close' || call.method === 'session.close')
      .map((call) => [call.method, call.args[0]]),
    [
      ['mcp.close', 'mcp-1'],
      ['session.close', 'failed-create'],
    ],
  );
  assert.equal(created.registry.getLive('failed-create'), undefined);

  const resumed = createHarness([summary('failed-resume-app', 'failed-resume-provider')]);
  queueLoad(resumed, 'failed-resume-provider');
  resumed.setEnableAutoCompaction(() => Promise.reject(new Error('resume setup failed')));
  await resumed.lifecycle.resume('failed-resume-app');
  assert.deepEqual(
    resumed.calls
      .filter((call) => call.method === 'mcp.close' || call.method === 'session.close')
      .map((call) => [call.method, call.args[0]]),
    [
      ['mcp.close', 'mcp-1'],
      ['session.close', 'failed-resume-provider'],
    ],
  );
  assert.equal(resumed.registry.getLive('failed-resume-app'), undefined);
});

test('registration failure closes resources without indexing the failed session', async () => {
  const harness = createHarness([], { attachSessionStore: true });
  queueCreate(harness, 'failed-registration');
  harness.failNextPersist(new Error('persist failed'));

  await harness.lifecycle.create(createCommand());

  assert.deepEqual(
    harness.calls
      .filter((call) => call.method === 'mcp.close' || call.method === 'session.close')
      .map((call) => [call.method, call.args[0]]),
    [
      ['mcp.close', 'mcp-1'],
      ['session.close', 'failed-registration'],
    ],
  );
  assert.equal(harness.registry.getLive('failed-registration'), undefined);
  assert.equal(
    harness.events.some((event) => event.type === 'error' && event.message === 'persist failed'),
    true,
  );
});

test('post-registration publication failures unregister and close opened resources', async () => {
  const created = createHarness();
  queueCreate(created, 'failed-create-publication');
  created.failNextEmit('session.created', new Error('create publication failed'));

  await created.lifecycle.create(createCommand());

  assert.equal(created.registry.getLive('failed-create-publication'), undefined);
  assert.deepEqual(
    created.calls
      .filter((call) => ['unsubscribe', 'mcp.close', 'session.close'].includes(call.method))
      .map((call) => [call.method, call.args[0]]),
    [
      ['unsubscribe', 'failed-create-publication'],
      ['mcp.close', 'mcp-1'],
      ['session.close', 'failed-create-publication'],
    ],
  );
  assert.equal(
    created.events.some(
      (event) => event.type === 'error' && event.message === 'create publication failed',
    ),
    true,
  );

  const resumed = createHarness([
    summary('failed-resume-publication-app', 'failed-resume-publication-provider'),
  ]);
  queueLoad(resumed, 'failed-resume-publication-provider');
  resumed.failNextEmit('session.created', new Error('resume publication failed'));

  await resumed.lifecycle.resume('failed-resume-publication-app');

  assert.equal(resumed.registry.getLive('failed-resume-publication-app'), undefined);
  assert.deepEqual(
    resumed.calls
      .filter((call) => ['unsubscribe', 'mcp.close', 'session.close'].includes(call.method))
      .map((call) => [call.method, call.args[0]]),
    [
      ['unsubscribe', 'failed-resume-publication-provider'],
      ['mcp.close', 'mcp-1'],
      ['session.close', 'failed-resume-publication-provider'],
    ],
  );
  assert.equal(
    resumed.events.some(
      (event) => event.type === 'error' && event.message === 'resume publication failed',
    ),
    true,
  );
});

test('send lazily resumes once and sends the prompt exactly once', async () => {
  const harness = createHarness([summary('app-3', 'provider-3')]);
  const provider = queueLoad(harness, 'provider-3');
  await harness.lifecycle.send('app-3', 'only once');
  assert.equal(harness.runtime.loadCalls.length, 1);
  assert.deepEqual(provider.prompts, ['only once']);
});

test('an eager resume and immediate send share one provider load', async () => {
  const harness = createHarness([summary('warm-app', 'warm-provider')]);
  const provider = queueLoad(harness, 'warm-provider');
  let releaseLimit: (limit: number) => void = () => undefined;
  harness.setCompactionLimit(
    () =>
      new Promise<number>((resolve) => {
        releaseLimit = resolve;
      }),
  );

  const warming = harness.lifecycle.resume('warm-app');
  await new Promise<void>((resolve) => setImmediate(resolve));
  const sending = harness.lifecycle.send('warm-app', 'send while warming');

  assert.equal(harness.runtime.loadCalls.length, 1);
  releaseLimit(800);
  assert.equal(await warming, true);
  await sending;
  assert.deepEqual(provider.prompts, ['send while warming']);
  assert.equal(harness.runtime.loadCalls.length, 1);
});

test('failed lazy resume emits only the original load error', async () => {
  const harness = createHarness([summary('lazy-failure-app', 'lazy-failure-provider')]);
  harness.runtime.loadQueue.set('lazy-failure-provider', [new Error('provider load failed')]);

  await harness.lifecycle.send('lazy-failure-app', 'not delivered');

  assert.deepEqual(
    harness.events
      .filter((event): event is Extract<ServerEvent, { type: 'error' }> => event.type === 'error')
      .map((event) => event.message),
    ['provider load failed'],
  );
});

test('failed turn setup clears streaming so the next send can run', async () => {
  const harness = createHarness([], { attachSessionStore: true });
  const provider = queueCreate(harness, 'setup-recovery');
  await harness.lifecycle.create(createCommand());
  await provider.waitForPrompts(1);
  await new Promise<void>((resolve) => setImmediate(resolve));
  harness.failNextPersist(new Error('persist failed'));

  await assert.rejects(harness.lifecycle.send('setup-recovery', 'failed setup'), /persist failed/);

  assert.equal(requireLive(harness, 'setup-recovery').streaming, false);
  await harness.lifecycle.send('setup-recovery', 'recovered');
  assert.deepEqual(provider.prompts, ['first', 'recovered']);
});

test('queued sends stay FIFO while send-now prompts are newest first', async () => {
  const fifo = createHarness();
  const fifoProvider = queueCreate(fifo, 'fifo');
  const fifoGate = fifoProvider.deferNextStream();
  await fifo.lifecycle.create(createCommand('first'));
  await fifoProvider.waitForPrompts(1);
  await fifo.lifecycle.send('fifo', 'second');
  await fifo.lifecycle.send('fifo', 'third');
  fifoGate.resolve();
  await fifoProvider.waitForPrompts(3);
  assert.deepEqual(fifoProvider.prompts, ['first', 'second', 'third']);
  const steered = createHarness();
  const steerProvider = queueCreate(steered, 'steered');
  const steerGate = steerProvider.deferNextStream();
  await steered.lifecycle.create(createCommand('first'));
  await steerProvider.waitForPrompts(1);
  await steered.lifecycle.sendNow('steered', 'steer one');
  await steered.lifecycle.sendNow('steered', 'steer two');
  steerGate.resolve();
  await steerProvider.waitForPrompts(3);
  assert.deepEqual(steerProvider.prompts, ['first', 'steer one', 'steer two']);
  assert.ok(interruptCount(steered) >= 1);
});

test('send-now queues without interrupting compaction and reports interrupt rejection', async () => {
  const compacting = createHarness();
  const provider = queueCreate(compacting, 'compacting');
  await compacting.lifecycle.create(createCommand());
  await provider.waitForPrompts(1);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const live = requireLive(compacting, 'compacting');
  live.compacting = true;
  await compacting.lifecycle.sendNow('compacting', 'manual');
  live.compacting = false;
  live.autoCompacting = true;
  await compacting.lifecycle.sendNow('compacting', 'automatic');
  assert.deepEqual(live.pendingSends, ['automatic', 'manual']);
  assert.equal(interruptCount(compacting), 0);
  const rejected = createHarness();
  const rejectingProvider = new RejectingInterruptSession('rejected', {}, rejected.calls);
  const gate = rejectingProvider.deferNextStream();
  rejected.runtime.createQueue.push(rejectingProvider);
  await rejected.lifecycle.create(createCommand());
  await rejectingProvider.waitForPrompts(1);
  await rejected.lifecycle.sendNow('rejected', 'keep queued');
  assert.deepEqual(requireLive(rejected, 'rejected').pendingSends, ['keep queued']);
  assert.equal(requireLive(rejected, 'rejected').interruptingForSteer, false);
  assert.equal(
    rejected.events.some(
      (event) => event.type === 'error' && event.code === 'session.send_now_failed',
    ),
    true,
  );
  gate.resolve();
  await rejectingProvider.waitForPrompts(2);
});

test('turn start leaves updatedAt alone and the settled turn moves it', async () => {
  // updatedAt drives sidebar order and the renderer's unread marker. While a
  // turn is in flight the session must not read as unread; only the settled
  // turn (the model's finished response) moves updatedAt.
  const harness = createHarness();
  const provider = queueCreate(harness, 'touch');
  await harness.lifecycle.create(createCommand());
  await provider.waitForPrompts(1);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const before = harness.registry.getCanonicalSummary('touch')?.updatedAt;
  assert.ok(before !== undefined);

  const gate = provider.deferNextStream();
  const sending = harness.lifecycle.send('touch', 'second');
  await provider.waitForPrompts(2);
  const mid = harness.registry.getCanonicalSummary('touch');
  assert.equal(mid?.streaming, true);
  assert.equal(mid?.updatedAt, before);

  gate.resolve();
  await sending;
  const after = harness.registry.getCanonicalSummary('touch');
  assert.equal(after?.streaming, false);
  assert.ok(after !== undefined && after.updatedAt > before);
});

test('queueing sends while streaming leaves updatedAt alone', async () => {
  const harness = createHarness();
  const provider = queueCreate(harness, 'queue-touch');
  const gate = provider.deferNextStream();
  await harness.lifecycle.create(createCommand());
  await provider.waitForPrompts(1);
  const before = harness.registry.getCanonicalSummary('queue-touch')?.updatedAt;

  await harness.lifecycle.send('queue-touch', 'queued one');
  await harness.lifecycle.send('queue-touch', 'queued two');
  const mid = harness.registry.getCanonicalSummary('queue-touch');
  assert.equal(mid?.queuedSends, 2);
  assert.equal(mid?.updatedAt, before);

  gate.resolve();
  await provider.waitForPrompts(3);
});

test('interrupt handles idle, streaming, manual compaction, and auto-compaction states', async () => {
  const harness = createHarness();
  const provider = queueCreate(harness, 'stop');
  await harness.lifecycle.create(createCommand());
  await provider.waitForPrompts(1);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const live = requireLive(harness, 'stop');
  await harness.lifecycle.interrupt('stop');
  assert.equal(interruptCount(harness), 1);
  assert.equal(live.interrupting, false);
  live.streaming = true;
  await harness.lifecycle.interrupt('stop');
  assert.equal(interruptCount(harness), 2);
  assert.equal(live.interrupting, true);
  live.streaming = false;
  live.interrupting = false;
  live.compacting = true;
  live.pendingSends = ['drop'];
  await harness.lifecycle.interrupt('stop');
  assert.equal(interruptCount(harness), 2);
  assert.deepEqual(live.pendingSends, []);
  live.compacting = false;
  live.autoCompacting = true;
  await harness.lifecycle.interrupt('stop');
  assert.equal(interruptCount(harness), 3);
  assert.equal(live.autoCompacting, false);
  assert.equal(
    harness.calls.some((call) => call.method === 'watchdog.clear' && call.args[0] === 'stop'),
    true,
  );

  const rejected = createHarness();
  const rejectingProvider = new RejectingInterruptSession('rejected-stop', {}, rejected.calls);
  rejected.runtime.createQueue.push(rejectingProvider);
  await rejected.lifecycle.create(createCommand());
  await rejectingProvider.waitForPrompts(1);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const rejectedLive = requireLive(rejected, 'rejected-stop');
  rejectedLive.autoCompacting = true;
  await assert.rejects(rejected.lifecycle.interrupt('rejected-stop'), /interrupt rejected/);
  assert.equal(rejectedLive.interrupting, false);
  assert.equal(rejectedLive.autoCompacting, true);
  assert.equal(
    rejected.calls.some(
      (call) => call.method === 'watchdog.clear' && call.args[0] === 'rejected-stop',
    ),
    false,
  );

  const aliased = createHarness([summary('stable-stop', 'provider-stop')]);
  queueLoad(aliased, 'provider-stop');
  await aliased.lifecycle.resume('stable-stop');
  const aliasedLive = requireLive(aliased, 'stable-stop');
  aliasedLive.autoCompacting = true;
  aliased.calls.length = 0;
  await aliased.lifecycle.interrupt('provider-stop');
  assert.equal(
    aliased.calls.some(
      (call) => call.method === 'watchdog.clear' && call.args[0] === 'stable-stop',
    ),
    true,
  );
});

test('resuming an already-live session does not reload or persist it', async () => {
  const harness = createHarness();
  const provider = queueCreate(harness, 'live');
  await harness.lifecycle.create(createCommand());
  await provider.waitForPrompts(1);
  await new Promise<void>((resolve) => setImmediate(resolve));
  harness.calls.length = 0;
  harness.events.length = 0;
  harness.persisted.length = 0;
  await harness.lifecycle.resume('live');
  assert.equal(harness.runtime.loadCalls.length, 0);
  assert.equal(harness.persisted.length, 0);
  assert.deepEqual(
    harness.events.map((event) => event.type),
    ['session.created'],
  );
  assert.equal(harness.calls.filter((call) => call.method === 'context.refresh').length, 1);
  assert.deepEqual(
    harness.calls
      .filter((call) =>
        [
          'mcp.start',
          'loadSession',
          'autoCompaction.arm',
          'onNotification',
          'updateSummary',
        ].includes(call.method),
      )
      .map((call) => call.method),
    [],
  );
});

test('create and resume abandon in-flight opens when shutdown admission closes', async () => {
  const creating = createHarness();
  let releaseCreateLimit: (limit: number) => void = () => undefined;
  creating.setCompactionLimit(
    () =>
      new Promise<number>((resolve) => {
        releaseCreateLimit = resolve;
      }),
  );
  const create = creating.lifecycle.create(createCommand());
  await new Promise<void>((resolve) => setImmediate(resolve));
  creating.setShutdownStarted(true);
  releaseCreateLimit(800);
  await create;
  assert.equal(creating.runtime.createCalls.length, 0);
  assert.equal(creating.registry.liveSessionsSnapshot().length, 0);
  assert.equal(creating.calls.filter((call) => call.method === 'autoCompaction.arm').length, 0);
  assert.equal(
    creating.events.some((event) => event.type === 'error'),
    false,
  );

  const historical = summary('resume-stable', 'resume-provider');
  const resuming = createHarness([historical], { attachSessionStore: false });
  const provider = queueLoad(resuming, 'resume-stable');
  let releaseResumeLimit: (limit: number) => void = () => undefined;
  resuming.setCompactionLimit(
    () =>
      new Promise<number>((resolve) => {
        releaseResumeLimit = resolve;
      }),
  );
  const resume = resuming.lifecycle.resume('resume-stable');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(resuming.runtime.loadCalls.length, 1);
  resuming.setShutdownStarted(true);
  releaseResumeLimit(800);
  assert.equal(await resume, false);
  assert.equal(resuming.registry.liveSessionsSnapshot().length, 0);
  assert.equal(resuming.calls.filter((call) => call.method === 'autoCompaction.arm').length, 0);
  assert.equal(
    resuming.calls.filter(
      (call) => call.method === 'session.close' && call.args[0] === provider.sessionId,
    ).length,
    1,
  );
  assert.equal(
    resuming.events.some((event) => event.type === 'error'),
    false,
  );
});

test('close follows ownership order and closeAll closes its initial snapshot', async () => {
  const harness = createHarness();
  const provider = new CallbackCloseSession('owner', harness.calls, () => {
    assert.ok(harness.registry.getLive('owner'));
    return Promise.resolve();
  });
  harness.runtime.createQueue.push(provider);
  await harness.lifecycle.create(createCommand());
  await provider.waitForPrompts(1);
  await new Promise<void>((resolve) => setImmediate(resolve));
  requireLive(harness, 'owner');
  const child = new FakeFactorySession('child', {}, harness.calls);
  const unsubscribeChild = child.onNotification(() => undefined);
  harness.setChildCloser(async () => {
    unsubscribeChild();
    await child.close();
  });
  harness.calls.length = 0;
  await harness.lifecycle.close('owner');
  const closeTrace = harness.calls
    .filter((call) =>
      [
        'unsubscribe',
        'session.close',
        'mcp.close',
        'browser.close',
        'compaction.forgetSession',
        'runtimeCaches.clear',
      ].includes(call.method),
    )
    .map((call) => `${call.method}:${String(call.args[0] ?? '')}`);
  assert.deepEqual(closeTrace, [
    'unsubscribe:child',
    'session.close:child',
    'compaction.forgetSession:owner',
    'unsubscribe:owner',
    'mcp.close:mcp-1',
    'session.close:owner',
    'browser.close:owner',
    'runtimeCaches.clear:owner',
  ]);
  assert.deepEqual(harness.forgettingAfterUnregister, [true]);
  assert.deepEqual(harness.eventFlowForgettingAfterUnregister, [true]);
  assert.deepEqual(harness.missionForgettingAfterUnregister, [true]);
  assert.equal(harness.registry.getLive('owner'), undefined);
  assert.ok(
    harness.calls.findIndex((call) => call.method === 'missionControl.forget') <
      harness.calls.findIndex((call) => call.method === 'session.closed'),
  );
  assert.ok(
    harness.calls.findIndex((call) => call.method === 'pendingSettings.forget') <
      harness.calls.findIndex((call) => call.method === 'session.closed'),
  );
  const ownerList = harness.events.findLast((event) => event.type === 'sessions.list');
  assert.equal(
    ownerList?.sessions.some((session) => session.appSessionId === 'owner'),
    false,
  );

  const all = createHarness();
  let registerLate = (): Promise<void> => Promise.resolve();
  const first = new CallbackCloseSession('first', all.calls, () => registerLate());
  all.runtime.createQueue.push(first);
  const second = queueCreate(all, 'second');
  await all.lifecycle.create(createCommand());
  await first.waitForPrompts(1);
  await all.lifecycle.create(createCommand());
  await second.waitForPrompts(1);
  await new Promise<void>((resolve) => setImmediate(resolve));
  registerLate = async () => {
    const late = queueCreate(all, 'late');
    await all.lifecycle.create(createCommand());
    await late.waitForPrompts(1);
  };
  await all.lifecycle.closeAll();
  assert.deepEqual(
    all.calls.filter((call) => call.method === 'session.close').map((call) => call.args[0]),
    ['first', 'second'],
  );
  assert.deepEqual(
    all.registry.liveSessionsSnapshot().map((session) => session.summary.appSessionId),
    ['late'],
  );
  await all.lifecycle.closeAll();
  assert.equal(all.registry.liveSessionsSnapshot().length, 0);
});

test('close waits for the authoritative post-close session list', async () => {
  const harness = createHarness();
  const provider = queueCreate(harness, 'await-list');
  await harness.lifecycle.create(createCommand());
  await provider.waitForPrompts(1);

  let releaseList = (): void => undefined;
  const listReady = new Promise<void>((resolve) => {
    releaseList = resolve;
  });
  harness.setEmitSessionList(() => listReady);

  let closed = false;
  const closing = harness.lifecycle.close('await-list').then(() => {
    closed = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closed, false);

  releaseList();
  await closing;
  assert.equal(closed, true);
});

test('closeAll marks its full snapshot before sequential cleanup', async () => {
  const harness = createHarness();
  let releaseFirst = (): void => undefined;
  const first = new CallbackCloseSession(
    'first-marked',
    harness.calls,
    () =>
      new Promise<void>((resolve) => {
        releaseFirst = resolve;
      }),
  );
  const second = new FakeFactorySession('second-marked', {}, harness.calls);
  harness.runtime.createQueue.push(first, second);
  await harness.lifecycle.create(createCommand());
  await first.waitForPrompts(1);
  await harness.lifecycle.create(createCommand());
  await second.waitForPrompts(1);
  await new Promise<void>((resolve) => setImmediate(resolve));

  const firstLive = requireLive(harness, 'first-marked');
  const secondLive = requireLive(harness, 'second-marked');
  const closingAll = harness.lifecycle.closeAll();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(harness.registry.getLive('first-marked'), undefined);
  assert.equal(harness.registry.getLive('second-marked'), undefined);
  assert.equal(firstLive.closeMode, 'discard-pending');
  assert.equal(secondLive.closeMode, 'discard-pending');
  assert.ok(secondLive.closePromise);

  let directSecondSettled = false;
  const directSecond = harness.lifecycle.close('second-marked').then(() => {
    directSecondSettled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(directSecondSettled, false);
  assert.equal(
    harness.calls.some(
      (call) => call.method === 'session.close' && call.args[0] === 'second-marked',
    ),
    false,
  );

  releaseFirst();
  await Promise.all([closingAll, directSecond]);
  assert.deepEqual(
    harness.calls.filter((call) => call.method === 'session.close').map((call) => call.args[0]),
    ['first-marked', 'second-marked'],
  );
});

test('closeAll records a cleanup failure and still closes later sessions', async () => {
  const harness = createHarness();
  const first = new RejectingCloseSession('first-rejecting', {}, harness.calls);
  const second = new FakeFactorySession('second-after-rejection', {}, harness.calls);
  harness.runtime.createQueue.push(first, second);
  await harness.lifecycle.create(createCommand());
  await first.waitForPrompts(1);
  await harness.lifecycle.create(createCommand());
  await second.waitForPrompts(1);
  await new Promise<void>((resolve) => setImmediate(resolve));

  await assert.rejects(harness.lifecycle.closeAll(), /close failed: first-rejecting/);
  assert.deepEqual(
    harness.calls.filter((call) => call.method === 'session.close').map((call) => call.args[0]),
    ['first-rejecting', 'second-after-rejection'],
  );
  assert.equal(harness.registry.liveSessionsSnapshot().length, 0);
});

test('closing an active session discards queued sends without reopening it', async () => {
  const harness = createHarness();
  const provider = queueCreate(harness, 'closing');
  const gate = provider.deferNextStream();
  await harness.lifecycle.create(createCommand('active'));
  await provider.waitForPrompts(1);
  await harness.lifecycle.send('closing', 'queued');
  const live = requireLive(harness, 'closing');

  await harness.lifecycle.close('closing');
  gate.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(provider.prompts, ['active']);
  assert.deepEqual(live.pendingSends, []);
  assert.equal(harness.runtime.loadCalls.length, 0);
  assert.equal(harness.registry.getLive('closing'), undefined);
});

test('concurrent close waits for cleanup and discard overrides queue preservation', async () => {
  const harness = createHarness();
  let finishProviderClose: () => void = () => undefined;
  const provider = new CallbackCloseSession(
    'concurrent-close',
    harness.calls,
    () =>
      new Promise<void>((resolve) => {
        finishProviderClose = resolve;
      }),
  );
  harness.runtime.createQueue.push(provider);
  await harness.lifecycle.create(createCommand());
  await provider.waitForPrompts(1);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const live = requireLive(harness, 'concurrent-close');
  live.pendingSends = ['preserve unless user closes'];

  const preserving = harness.lifecycle.close('concurrent-close', 'preserve-pending');
  await new Promise<void>((resolve) => setImmediate(resolve));
  let discardSettled = false;
  const discarding = harness.lifecycle.close('concurrent-close').then(() => {
    discardSettled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(discardSettled, false);
  assert.equal(live.closeMode, 'discard-pending');
  assert.deepEqual(live.pendingSends, []);
  finishProviderClose();
  await Promise.all([preserving, discarding]);
  assert.equal(harness.registry.getLive('concurrent-close'), undefined);
});

test('pending settings stay projected until successful first-send application', async () => {
  const saved = summary('app-pending', 'provider-pending', {
    configuration: droidSessionConfiguration({
      modelId: 'model-saved',
      reasoningEffort: ReasoningEffort.Low,
      interactionMode: 'auto',
      autonomy: 'low',
    }),
  });
  const harness = createHarness([saved]);
  const provider = new FakeFactorySession('provider-pending', {}, harness.calls, {
    settings: { modelId: 'model-saved', reasoningEffort: ReasoningEffort.Low },
  });
  queueLoad(harness, 'provider-pending', provider);
  const pendingNative = {
    modelId: 'model-pending',
    reasoningEffort: ReasoningEffort.High,
  };
  const pendingSummary: Partial<SessionSummary> = {
    configuration: droidSessionConfiguration({
      modelId: 'model-pending',
      reasoningEffort: ReasoningEffort.High,
      interactionMode: 'auto',
      autonomy: 'low',
    }),
  };
  harness.setProjection(pendingSummary);
  await harness.lifecycle.resume('app-pending');
  assert.equal(
    harness.registry.getCanonicalSummary('app-pending')?.configuration.providerSelection.modelId,
    'model-saved',
  );
  assert.equal(
    harness.registry.resolveSummary('app-pending')?.configuration.providerSelection.modelId,
    'model-pending',
  );
  assert.equal(
    harness.registry.listSummaries().sessions[0]?.configuration.providerSelection.options
      .reasoningEffort,
    ReasoningEffort.High,
  );
  assert.equal(
    harness.store.get('app-pending')?.summary.configuration.providerSelection.modelId,
    'model-saved',
  );
  assert.equal(
    harness.events.find((event) => event.type === 'session.created')?.session.configuration
      .providerSelection.modelId,
    'model-pending',
  );
  const replaced = harness.registry.replaceProvider('app-pending', 'provider-next');
  assert.equal(replaced?.configuration.providerSelection.modelId, 'model-saved');
  assert.equal(
    harness.store.get('app-pending')?.summary.configuration.providerSelection.modelId,
    'model-saved',
  );
  harness.setPendingApply(async (appSessionId) => {
    await provider.updateSettings(pendingNative);
    harness.registry.updateSummary(appSessionId, pendingSummary);
    return true;
  });
  await harness.lifecycle.send('app-pending', 'apply now');
  assert.equal(provider.settings[0]?.['modelId'], 'model-pending');
  assert.deepEqual(provider.prompts, ['apply now']);
  const settingsCall = harness.calls.findIndex((call) => call.method === 'updateSettings');
  const streamCall = harness.calls.findIndex(
    (call) => call.method === 'stream' && call.args[1] === 'apply now',
  );
  assert.ok(settingsCall >= 0 && settingsCall < streamCall);
  assert.equal(
    harness.registry.getCanonicalSummary('app-pending')?.configuration.providerSelection.modelId,
    'model-pending',
  );
  assert.equal(
    harness.store.get('app-pending')?.summary.configuration.providerSelection.options
      .reasoningEffort,
    ReasoningEffort.High,
  );

  const failed = createHarness([saved]);
  const failedProvider = new FakeFactorySession('provider-pending', {}, failed.calls, {
    settings: { modelId: 'model-saved', reasoningEffort: ReasoningEffort.Low },
  });
  queueLoad(failed, 'provider-pending', failedProvider);
  failed.setProjection(pendingSummary);
  await failed.lifecycle.resume('app-pending');
  failed.setPendingApply(() => Promise.resolve(false));
  await failed.lifecycle.send('app-pending', 'must not stream');
  assert.deepEqual(failedProvider.prompts, []);
  assert.equal(
    failed.registry.getCanonicalSummary('app-pending')?.configuration.providerSelection.modelId,
    'model-saved',
  );
  assert.equal(
    failed.registry.resolveSummary('app-pending')?.configuration.providerSelection.modelId,
    'model-pending',
  );
});

test('invalidateLiveSessions bumps generations and unregisters before native close', async () => {
  const harness = createHarness();
  const provider = queueCreate(harness, 'invalidate-me');
  await harness.lifecycle.create(createCommand());
  await provider.waitForPrompts(1);
  const live = requireLive(harness, 'invalidate-me');
  const generation = live.binding.runtimeGeneration;
  const snapshot = harness.lifecycle.invalidateLiveSessions();
  assert.equal(snapshot.length, 1);
  assert.equal(harness.registry.getLive('invalidate-me'), undefined);
  assert.equal(live.binding.runtimeGeneration, generation + 1);
  assert.equal(live.closeMode, 'discard-pending');
  await harness.lifecycle.closeAll();
  assert.equal(
    harness.calls.some(
      (call) => call.method === 'session.close' && call.args[0] === 'invalidate-me',
    ),
    true,
  );
});

test('closeAll passes the same deadline object to native session close', async () => {
  const harness = createHarness();
  const provider = queueCreate(harness, 'deadline-owner');
  await harness.lifecycle.create(createCommand());
  await provider.waitForPrompts(1);
  const deadline = ShutdownDeadline.fromDurationMs(1_000, 40);
  await harness.lifecycle.closeAll(deadline);
  const closeCall = harness.calls.find(
    (call) => call.method === 'session.close' && call.args[0] === 'deadline-owner',
  );
  assert.equal(closeCall?.args[1], deadline);
});

test('per-app mutating commands serialize so a second send queues behind the live turn', async () => {
  const harness = createHarness();
  const provider = queueCreate(harness, 'serialized');
  await harness.lifecycle.create(createCommand());
  await provider.waitForPrompts(1);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const gate = provider.deferNextStream();
  const first = harness.lifecycle.send('serialized', 'one');
  await provider.waitForPrompts(2);
  const second = harness.lifecycle.send('serialized', 'two');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(requireLive(harness, 'serialized').pendingSends, ['two']);
  assert.equal(interruptCount(harness), 0);
  const interrupting = harness.lifecycle.interrupt('serialized');
  await interrupting;
  assert.equal(interruptCount(harness), 1);
  gate.resolve();
  await first;
  await second;
});

test('a close racing an unactivated open discards the buffer and cannot resurrect the session', async () => {
  const harness = createHarness();
  let releaseArm: (armed: boolean) => void = () => undefined;
  harness.setEnableAutoCompaction(
    () =>
      new Promise<boolean>((resolve) => {
        releaseArm = resolve;
      }),
  );
  queueCreate(harness, 'race-open');
  const creating = harness.lifecycle.create(createCommand());
  await new Promise<void>((resolve) => {
    const poll = (): void => {
      if (harness.calls.some((call) => call.method === 'autoCompaction.arm')) resolve();
      else setImmediate(poll);
    };
    poll();
  });
  assert.equal(harness.registry.getLive('race-open'), undefined);
  const closing = harness.lifecycle.close('race-open');
  releaseArm(true);
  await creating;
  await closing;
  assert.equal(harness.registry.getLive('race-open'), undefined);
  assert.equal(
    harness.events.some((event) => event.type === 'session.created'),
    false,
  );
  assert.equal(
    harness.calls.some((call) => call.method === 'session.close' && call.args[0] === 'race-open'),
    true,
  );
  assert.equal(await harness.lifecycle.resume('race-open'), false);
  await harness.lifecycle.send('race-open', 'must not resurrect');
  assert.equal(harness.registry.getLive('race-open'), undefined);
});

function assertCreateBoundaryOrder(
  boundaries: readonly string[],
  earlier: SessionCreateBoundary,
  later: SessionCreateBoundary,
): void {
  const earlierIndex = boundaries.indexOf(earlier);
  const laterIndex = boundaries.indexOf(later);
  assert.notEqual(earlierIndex, -1, `missing create boundary: ${earlier}`);
  assert.notEqual(laterIndex, -1, `missing create boundary: ${later}`);
  assert.ok(earlierIndex < laterIndex, `${earlier} must precede ${later}`);
}

async function waitForAppliedTurn(harness: Harness): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (
      harness.appliedProviderEvents.some(
        (event) =>
          typeof event === 'object' &&
          event !== null &&
          'type' in event &&
          event.type === 'turn.settled',
      )
    ) {
      return;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('No turn.settled provider event was applied.');
}

async function withCanonicalStores(
  run: (input: {
    store: SessionStore;
    transcript: TranscriptStore;
    db: DroidexDatabase;
  }) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'droidex-f7-'));
  const db = new DroidexDatabase(join(dir, 'state', 'droidex.sqlite'));
  try {
    await run({ store: new SessionStore(db), transcript: new TranscriptStore(db), db });
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test('create allocates identity before native work and never uses the native id', async () => {
  await withCanonicalStores(async ({ store, transcript, db }) => {
    const boundaries: SessionCreateBoundary[] = [];
    const created = createHarness([], {
      sessionStore: store,
      transcriptStore: transcript,
      atomic: (work) => db.atomic(work),
      nextAppSessionId: () => 'app-canonical-1',
      nextTurnId: () => 'turn-canonical-1',
      nextId: () => 'evt-diag-1',
      onCreateBoundary: (boundary) => {
        boundaries.push(boundary);
      },
    });
    const createdProvider = queueCreate(created, 'native-9');
    await created.lifecycle.create(createCommand());
    await createdProvider.waitForPrompts(1);
    await waitForAppliedTurn(created);
    const published = created.events.find((event) => event.type === 'session.created');
    assert.equal(published?.type, 'session.created');
    if (published?.type === 'session.created') {
      assert.equal(published.session.appSessionId, 'app-canonical-1');
      assert.notEqual(published.session.appSessionId, 'native-9');
    }
    assert.deepEqual(created.mcpRefs, ['app-canonical-1']);
    assert.equal(store.get('app-canonical-1')?.binding.providerSessionId, 'native-9');
    assert.equal(store.findByClientRef('client-1')?.summary.appSessionId, 'app-canonical-1');
    assertCreateBoundaryOrder(boundaries, 'provisional-persisted', 'before-provider-open');
    assertCreateBoundaryOrder(boundaries, 'binding-persisted', 'activated');
    const createdIndex = created.events.findIndex((event) => event.type === 'session.created');
    assert.equal(
      created.events.slice(0, createdIndex).some((event) => event.type === 'event.appended'),
      false,
    );
    assert.equal(store.get('app-canonical-1')?.binding.runtimeGeneration, 1);
    assert.equal(store.get('app-canonical-1')?.lifecycleStatus, 'running');
    assert.equal(
      transcript.page({ kind: 'session', appSessionId: 'app-canonical-1' }).events.length,
      0,
    );
  });
});

test('injected failures at each create boundary stay deterministic', async () => {
  await withCanonicalStores(async ({ store, transcript, db }) => {
    const failAt = async (boundary: SessionCreateBoundary) => {
      const harness = createHarness([], {
        sessionStore: store,
        transcriptStore: transcript,
        atomic: (work) => db.atomic(work),
        nextAppSessionId: () => `app-${boundary}`,
        nextTurnId: () => `turn-${boundary}`,
        onCreateBoundary: (reached) => {
          if (reached === boundary) throw new Error(`crash:${boundary}`);
        },
      });
      queueCreate(harness, `native-${boundary}`);
      await harness.lifecycle.create({
        ...createCommand(`${boundary}-goal`),
        clientRef: `ref-${boundary}`,
      });
      return harness;
    };

    const beforePersist = await failAt('identity-allocated');
    assert.equal(beforePersist.runtime.createCalls.length, 0);
    assert.equal(store.get('app-identity-allocated'), undefined);

    const beforeNative = await failAt('provisional-persisted');
    assert.equal(beforeNative.runtime.createCalls.length, 0);
    assert.equal(store.get('app-provisional-persisted')?.lifecycleStatus, 'failed');

    const beforeOpen = await failAt('before-provider-open');
    assert.equal(beforeOpen.runtime.createCalls.length, 0);
    assert.equal(store.get('app-before-provider-open')?.lifecycleStatus, 'failed');

    const afterNative = await failAt('provider-opened');
    assert.equal(afterNative.runtime.createCalls.length, 1);
    assert.equal(
      afterNative.calls.some(
        (call) => call.method === 'session.close' && call.args[0] === 'native-provider-opened',
      ),
      true,
    );
    assert.equal(store.get('app-provider-opened')?.lifecycleStatus, 'failed');
    assert.equal(
      transcript
        .page({ kind: 'session', appSessionId: 'app-provider-opened' })
        .events.some((event) => event.payload.type === 'error'),
      true,
    );

    const afterBind = await failAt('binding-persisted');
    assert.equal(
      afterBind.events.some((event) => event.type === 'session.created'),
      false,
    );
    assert.equal(
      store.get('app-binding-persisted')?.binding.providerSessionId,
      'native-binding-persisted',
    );
  });
});

test('replaying the same clientRef never starts a second native session', async () => {
  await withCanonicalStores(async ({ store, transcript, db }) => {
    const first = createHarness([], {
      sessionStore: store,
      transcriptStore: transcript,
      atomic: (work) => db.atomic(work),
      nextAppSessionId: () => 'app-replay',
      nextTurnId: () => 'turn-replay',
    });
    queueCreate(first, 'native-replay');
    await first.lifecycle.create(createCommand());
    await first.runtime.sessions.get('native-replay')?.waitForPrompts(1);
    await waitForAppliedTurn(first);

    const second = createHarness([], {
      sessionStore: store,
      transcriptStore: transcript,
      atomic: (work) => db.atomic(work),
      nextAppSessionId: () => 'app-replay-2',
      nextTurnId: () => 'turn-replay-2',
    });
    queueCreate(second, 'native-replay-2');
    await second.lifecycle.create(createCommand());
    assert.equal(second.runtime.createCalls.length, 0);
    const created = second.events.find((event) => event.type === 'session.created');
    assert.equal(created?.type, 'session.created');
    if (created?.type === 'session.created') {
      assert.equal(created.session.appSessionId, 'app-replay');
    }
    assert.equal(store.findByClientRef('client-1')?.summary.appSessionId, 'app-replay');
  });
});

test('overlapping creates with the same clientRef start only one native session', async () => {
  await withCanonicalStores(async ({ store, transcript, db }) => {
    const harness = createHarness([], {
      sessionStore: store,
      transcriptStore: transcript,
      atomic: (work) => db.atomic(work),
      nextAppSessionId: () => 'app-overlap',
      nextTurnId: () => 'turn-overlap',
    });
    queueCreate(harness, 'native-overlap');
    const first = harness.lifecycle.create(createCommand());
    const second = harness.lifecycle.create(createCommand());
    await Promise.all([first, second]);
    await harness.runtime.sessions.get('native-overlap')?.waitForPrompts(1);
    await waitForAppliedTurn(harness);
    assert.equal(harness.runtime.createCalls.length, 1);
    assert.equal(store.findByClientRef('client-1')?.summary.appSessionId, 'app-overlap');
    const created = harness.events.filter((event) => event.type === 'session.created');
    assert.ok(created.length >= 1);
    assert.equal(
      created.every(
        (event) => event.type === 'session.created' && event.session.appSessionId === 'app-overlap',
      ),
      true,
    );
  });
});

test('a failed open stays visible and is never rebound', async () => {
  await withCanonicalStores(async ({ store, transcript, db }) => {
    const harness = createHarness([], {
      sessionStore: store,
      transcriptStore: transcript,
      atomic: (work) => db.atomic(work),
      nextAppSessionId: () => 'app-failed-open',
      nextTurnId: () => 'turn-failed-open',
    });
    harness.runtime.createQueue.push(new Error('native exploded'));
    await harness.lifecycle.create(createCommand());
    const failed = store.get('app-failed-open');
    assert.equal(failed?.lifecycleStatus, 'failed');
    assert.equal(failed?.binding.providerSessionId, undefined);
    assert.equal(
      store.list().some((row) => row.summary.appSessionId === 'app-failed-open'),
      true,
    );

    const retry = createHarness([], {
      sessionStore: store,
      transcriptStore: transcript,
      atomic: (work) => db.atomic(work),
      nextAppSessionId: () => 'app-failed-rebind',
    });
    queueCreate(retry, 'native-rebind');
    await retry.lifecycle.create(createCommand());
    assert.equal(retry.runtime.createCalls.length, 0);
    assert.equal(
      retry.events.some((event) => event.type === 'session.created'),
      false,
    );
    assert.equal(
      retry.events.some(
        (event) =>
          event.type === 'error' &&
          event.code === 'session.create_failed' &&
          event.clientRef === 'client-1' &&
          event.message === 'native exploded',
      ),
      true,
    );
    assert.equal(store.get('app-failed-open')?.binding.providerSessionId, undefined);
    assert.equal(store.get('app-failed-rebind'), undefined);
  });
});

test('retryStart after a failed unbound create starts native work on the same app id', async () => {
  await withCanonicalStores(async ({ store, transcript, db }) => {
    const harness = createHarness([], {
      sessionStore: store,
      transcriptStore: transcript,
      atomic: (work) => db.atomic(work),
      nextAppSessionId: () => 'app-retry',
      nextTurnId: () => 'turn-retry-1',
    });
    harness.runtime.createQueue.push(new Error('native exploded'));
    await harness.lifecycle.create(createCommand());
    assert.equal(store.get('app-retry')?.lifecycleStatus, 'failed');

    const retry = createHarness([], {
      sessionStore: store,
      transcriptStore: transcript,
      atomic: (work) => db.atomic(work),
      nextTurnId: () => 'turn-retry-2',
    });
    queueCreate(retry, 'native-retry');
    await retry.lifecycle.retryStart('app-retry');
    await retry.runtime.sessions.get('native-retry')?.waitForPrompts(1);
    await waitForAppliedTurn(retry);
    assert.equal(retry.runtime.createCalls.length, 1);
    assert.equal(store.get('app-retry')?.lifecycleStatus, 'running');
    assert.equal(store.get('app-retry')?.binding.providerSessionId, 'native-retry');
    assert.equal(
      retry.events.some((event) => event.type === 'session.created'),
      false,
    );
    assert.equal(
      retry.events.some(
        (event) => event.type === 'session.updated' && event.session.appSessionId === 'app-retry',
      ),
      true,
    );
  });
});

test('retryStart rejects a live session and removeFailed deletes only a failed row', async () => {
  await withCanonicalStores(async ({ store, transcript, db }) => {
    const live = createHarness([], {
      sessionStore: store,
      transcriptStore: transcript,
      atomic: (work) => db.atomic(work),
      nextAppSessionId: () => 'app-live',
      nextTurnId: () => 'turn-live',
    });
    queueCreate(live, 'native-live');
    await live.lifecycle.create(createCommand('live'));
    await live.lifecycle.retryStart('app-live');
    assert.equal(live.runtime.createCalls.length, 1);
    assert.equal(
      live.events.some(
        (event) =>
          event.type === 'error' &&
          event.code === 'session.retry_start_failed' &&
          event.appSessionId === 'app-live',
      ),
      true,
    );

    const failed = createHarness([], {
      sessionStore: store,
      transcriptStore: transcript,
      atomic: (work) => db.atomic(work),
      nextAppSessionId: () => 'app-remove',
      nextTurnId: () => 'turn-remove',
    });
    failed.runtime.createQueue.push(new Error('native exploded'));
    await failed.lifecycle.create({ ...createCommand('remove'), clientRef: 'ref-remove' });
    await live.lifecycle.removeFailed('app-live');
    assert.equal(store.get('app-live')?.lifecycleStatus, 'running');
    assert.equal(
      live.events.some((event) => event.type === 'session.removed'),
      false,
    );
    await failed.lifecycle.removeFailed('app-remove');
    assert.equal(store.get('app-remove'), undefined);
    assert.equal(
      failed.events.some(
        (event) => event.type === 'session.removed' && event.appSessionId === 'app-remove',
      ),
      true,
    );
  });
});
