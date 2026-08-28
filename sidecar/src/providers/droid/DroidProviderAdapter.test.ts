import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ToolConfirmationType,
  type AskUserRequestParams,
  type RequestPermissionRequestParams,
} from '@factory/droid-sdk';

import { toProviderModels } from '../../DroidCliCatalog.js';
import type { ModelInfo } from '../../protocol.js';
import {
  FakeFactoryRuntime,
  FakeFactorySession,
  assistantTextDelta,
  type RecordedCall,
} from '../../testing/fakeFactoryRuntime.js';
import { serializedProviderEventBytes, type ProviderRuntimeEvent } from '../providerEvents.js';
import {
  ProviderContractError,
  START_TURN_ACCEPTANCE_ONLY,
  type ProviderInteractionSink,
  type ProviderModel,
  type ProviderSessionCreateInput,
} from '../providerTypes.js';
import { ShutdownDeadline } from '../shutdownDeadline.js';
import {
  cancelingInteractionSink,
  createTestClock,
  createTestIdSource,
} from '../testing/FakeProviderAdapter.js';
import {
  assertActivateIsOneShot,
  assertCompleteCapabilities,
  assertEventAdmissibleForSession,
  assertExactlyOneTurnSettlement,
  assertPreActivationOverflow,
  assertSameShutdownDeadline,
  assertStartTurnDidNotSettle,
  bindProviderAdapter,
} from '../testing/ProviderContractHarness.js';
import { DroidProviderAdapter } from './DroidProviderAdapter.js';
import { DROID_DEFINITION, droidCapabilities } from './DroidModeMapping.js';

void START_TURN_ACCEPTANCE_ONLY;

function recordingSink() {
  const events: ProviderRuntimeEvent[] = [];
  return {
    events,
    sink: (event: ProviderRuntimeEvent) => {
      events.push(event);
    },
  };
}

function answeringSink(
  overrides: Partial<ProviderInteractionSink> = {},
): ProviderInteractionSink & { approvals: number; questions: number; plans: number } {
  const sink: ProviderInteractionSink & { approvals: number; questions: number; plans: number } = {
    approvals: 0,
    questions: 0,
    plans: 0,
    requestApproval: async (input) => {
      sink.approvals += 1;
      if (overrides.requestApproval) return overrides.requestApproval(input);
      return { decision: 'allow_session' };
    },
    requestQuestion: async (input) => {
      sink.questions += 1;
      if (overrides.requestQuestion) return overrides.requestQuestion(input);
      return { status: 'answered', answers: { '0': ['Workspace'] } };
    },
    requestPlanReview: async (input) => {
      sink.plans += 1;
      if (overrides.requestPlanReview) return overrides.requestPlanReview(input);
      return { decision: 'implement' };
    },
  };
  return sink;
}

function createInput(
  sink: (event: ProviderRuntimeEvent) => void,
  overrides: {
    modelId?: string;
    autonomy?: 'off' | 'low' | 'medium' | 'high';
    interactionMode?: 'auto' | 'spec' | 'agi';
    expectedGeneration?: number;
    interactionSink?: ProviderInteractionSink;
    options?: Record<string, string | number | boolean>;
    cwd?: string;
  } = {},
): ProviderSessionCreateInput {
  return {
    target: { kind: 'session', appSessionId: 'app-1' },
    configuration: {
      providerSelection: {
        providerInstanceId: 'droid',
        modelId: overrides.modelId ?? 'gpt-5.4',
        options: overrides.options ?? {},
      },
      interactionMode: overrides.interactionMode ?? 'auto',
      autonomy: overrides.autonomy ?? 'medium',
    },
    expectedGeneration: overrides.expectedGeneration ?? 3,
    cwd: overrides.cwd ?? '/tmp/project',
    eventSink: sink,
    interactionSink: overrides.interactionSink ?? cancelingInteractionSink(),
    ids: createTestIdSource('droid'),
    clock: createTestClock(),
  };
}

function adapterWithRuntime(
  runtime: FakeFactoryRuntime,
  extras: ConstructorParameters<typeof DroidProviderAdapter>[0] = {},
) {
  return new DroidProviderAdapter({ runtime, ...extras });
}

function floodOnSubscribe(session: FakeFactorySession, count: number): FakeFactorySession {
  const subscribe = session.onNotification.bind(session);
  session.onNotification = ((listener, filter) => {
    const unsubscribe = subscribe(listener, filter);
    for (let index = 0; index < count; index += 1) {
      session.emitNotification({
        type: 'droid_working_state_changed',
        newState: 'compacting_conversation',
      });
    }
    return unsubscribe;
  }) as FakeFactorySession['onNotification'];
  return session;
}

async function waitForTurnSettlement(
  events: readonly ProviderRuntimeEvent[],
  turnId: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (events.some((event) => event.type === 'turn.settled' && event.turnId === turnId)) {
      return;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for turn.settled ${turnId}`);
}

test('DroidProviderAdapter binds as the static droid adapter with complete capabilities', () => {
  const adapter = bindProviderAdapter(
    new DroidProviderAdapter({ runtime: new FakeFactoryRuntime([]) }),
  );
  assert.deepEqual(adapter.definition, DROID_DEFINITION);
  assertCompleteCapabilities(droidCapabilities());
});

test('probe reports missing, unauthenticated, and ready Droid snapshots', async () => {
  const runtime = new FakeFactoryRuntime([]);
  const missing = new DroidProviderAdapter({
    runtime,
    findInstalledPath: () => undefined,
  });
  const missingSnapshot = await missing.probe(new AbortController().signal);
  assert.equal(missingSnapshot.readiness, 'missing');
  assert.equal(missingSnapshot.error?.code, 'missing_executable');
  assert.equal(missingSnapshot.error?.recoveryAction, 'open_droid_setup');
  assert.equal(missingSnapshot.error?.providerInstanceId, 'droid');
  assertCompleteCapabilities(missingSnapshot.capabilities);

  const unauthenticated = new DroidProviderAdapter({
    runtime,
    findInstalledPath: () => '/opt/droid',
    readCatalog: async () => [],
    detect: async () => ({
      cli: { present: true, path: '/opt/droid', version: '1.2.3' },
      auth: { apiKeyConfigured: false, loginPresent: false },
    }),
  });
  const unauthSnapshot = await unauthenticated.probe(new AbortController().signal);
  assert.equal(unauthSnapshot.readiness, 'unauthenticated');
  assert.equal(unauthSnapshot.error?.code, 'unauthenticated_provider');
  assert.equal(unauthSnapshot.error?.recoveryAction, 'open_droid_setup');
  assert.equal(unauthSnapshot.executable?.name, 'droid');
  assertCompleteCapabilities(unauthSnapshot.capabilities);

  const models: ProviderModel[] = [
    {
      id: 'gpt-5.4',
      displayName: 'GPT-5.4',
      isDefault: true,
      supportedReasoningEfforts: ['low', 'medium', 'high'],
      serviceTiers: [],
    },
  ];
  const ready = new DroidProviderAdapter({
    runtime,
    findInstalledPath: () => '/opt/droid',
    readCatalog: async () => models,
    detect: async () => ({
      cli: { present: true, path: '/opt/droid', version: '1.2.3' },
      auth: { apiKeyConfigured: true, loginPresent: true },
    }),
  });
  const snapshot = await ready.probe(new AbortController().signal);
  assert.equal(snapshot.readiness, 'ready');
  assert.equal(snapshot.executable?.name, 'droid');
  assert.equal(snapshot.executable?.version, '1.2.3');
  assert.equal(snapshot.auth?.apiProviderLabel, 'Factory');
  assert.deepEqual(snapshot.models, models);
  assert.equal(snapshot.capabilities.usageReporting, true);
  assert.equal(snapshot.capabilities.reasoningStream, true);
  assert.equal(snapshot.capabilities.steer, false);
  assert.equal(snapshot.capabilities.missionControl, true);
});

test('catalog sanitization drops provider, custom, and path fields', () => {
  const models: ModelInfo[] = [
    {
      id: 'gpt-5.4',
      displayName: 'GPT-5.4',
      provider: 'openai',
      isCustom: true,
      isDefault: true,
      supportedReasoningEfforts: ['medium'],
    },
  ];
  const sanitized = toProviderModels(models);
  const first = sanitized[0];
  assert.ok(first);
  assert.deepEqual(sanitized, [
    {
      id: 'gpt-5.4',
      displayName: 'GPT-5.4',
      isDefault: true,
      supportedReasoningEfforts: ['medium'],
      serviceTiers: [],
    },
  ]);
  assert.equal('provider' in first, false);
  assert.equal('isCustom' in first, false);
  assert.equal('path' in first, false);
});

test('probe falls back to the catalog cache when the live catalog fails', async () => {
  const cached: ProviderModel[] = [
    {
      id: 'cached-model',
      displayName: 'Cached',
      isDefault: false,
      supportedReasoningEfforts: [],
      serviceTiers: [],
    },
  ];
  const adapter = new DroidProviderAdapter({
    runtime: new FakeFactoryRuntime([]),
    findInstalledPath: () => '/opt/droid',
    readCatalog: async () => {
      throw new Error('catalog exploded');
    },
    readCatalogCache: () => cached,
    detect: async () => ({
      cli: { present: true, path: '/opt/droid', version: '1.0' },
      auth: { apiKeyConfigured: false, loginPresent: true },
    }),
  });
  const snapshot = await adapter.probe(new AbortController().signal);
  assert.deepEqual(snapshot.models, cached);
});

test('create passes cwd, mode, autonomy, model, and native handlers', async () => {
  const runtime = new FakeFactoryRuntime([]);
  const adapter = adapterWithRuntime(runtime);
  const recorded = recordingSink();
  const session = await adapter.create(
    createInput(recorded.sink, {
      cwd: '/tmp/droid-project',
      modelId: 'main-model',
      autonomy: 'high',
      interactionMode: 'spec',
      options: { reasoningEffort: 'low' },
    }),
  );
  assert.equal(runtime.createCalls.length, 1);
  const options = runtime.createCalls[0];
  assert.ok(options);
  assert.equal(options.cwd, '/tmp/droid-project');
  assert.equal(options.modelId, 'main-model');
  assert.equal(options.autonomyLevel, 'high');
  assert.equal(options.interactionMode, 'spec');
  assert.equal(options.reasoningEffort, 'low');
  assert.equal(typeof options.permissionHandler, 'function');
  assert.equal(typeof options.askUserHandler, 'function');
  session.activate();
  const binding = recorded.events.find((event) => event.type === 'binding.updated');
  assert.equal(binding?.type, 'binding.updated');
  if (binding?.type === 'binding.updated') {
    assert.deepEqual(binding.binding, {
      providerSessionId: session.providerSessionId,
      resumeState: { schemaVersion: 1, sessionId: 'provider-1' },
    });
  }
  await session.close(ShutdownDeadline.fromDurationMs(0));
});

test('resume loads the Factory session id and rejects malformed resume state', async () => {
  const runtime = new FakeFactoryRuntime([]);
  const adapter = adapterWithRuntime(runtime);
  const recorded = recordingSink();
  await assert.rejects(
    () =>
      adapter.resume({
        ...createInput(recorded.sink),
        resumeState: { schemaVersion: 2, sessionId: 'resume-1' },
      }),
    (error: unknown) =>
      error instanceof ProviderContractError && error.code === 'invalid_provider_configuration',
  );
  const session = await adapter.resume({
    ...createInput(recorded.sink),
    resumeState: { schemaVersion: 1, sessionId: 'resume-1' },
  });
  assert.equal(runtime.loadCalls.length, 1);
  assert.equal(runtime.loadCalls[0]?.sessionId, 'resume-1');
  assert.equal(runtime.createCalls.length, 0);
  session.activate();
  const binding = recorded.events.find((event) => event.type === 'binding.updated');
  assert.equal(binding?.type, 'binding.updated');
  if (binding?.type === 'binding.updated') {
    assert.deepEqual(binding.binding.resumeState, { schemaVersion: 1, sessionId: 'resume-1' });
    assert.equal(binding.binding.providerSessionId, session.providerSessionId);
  }
  await session.close(ShutdownDeadline.fromDurationMs(0));
});

test('native session start failures use the closed ProviderError contract', async () => {
  const runtime = new FakeFactoryRuntime([]);
  runtime.createQueue.push(new Error('FACTORY_SECRET stack and payload'));
  const adapter = adapterWithRuntime(runtime);
  const recorded = recordingSink();
  await assert.rejects(
    () => adapter.create(createInput(recorded.sink)),
    (error: unknown) =>
      error instanceof ProviderContractError &&
      error.code === 'native_session_start_failed' &&
      error.providerInstanceId === 'droid' &&
      error.message === 'Droid session failed to start.' &&
      !error.message.includes('FACTORY_SECRET'),
  );
});

test('startTurn resolves on acceptance; settlement arrives later exactly once', async () => {
  const runtime = new FakeFactoryRuntime([]);
  const factory = new FakeFactorySession('provider-1', {}, []);
  factory.queueStreamEvents([assistantTextDelta('hello from droid')]);
  runtime.createQueue.push(factory);
  const adapter = adapterWithRuntime(runtime);
  const recorded = recordingSink();
  const input = createInput(recorded.sink);
  const session = await adapter.create(input);
  try {
    session.activate();
    const returned = await session.startTurn({
      turnId: 'turn-1',
      prompt: { text: 'hello', skills: [], files: [], browserRefs: [] },
      configuration: input.configuration,
    });
    assertStartTurnDidNotSettle(returned, recorded.events, 'turn-1');
    await waitForTurnSettlement(recorded.events, 'turn-1');
    assertExactlyOneTurnSettlement(recorded.events, 'turn-1', { status: 'completed' });
    const liveEvent = recorded.events.find((event) => event.type === 'transcript');
    assert.ok(liveEvent);
    assertEventAdmissibleForSession(liveEvent, {
      target: { kind: 'session', appSessionId: 'app-1' },
      providerDriverKind: 'droid',
      providerInstanceId: 'droid',
      runtimeGeneration: 3,
      settledTurnIds: new Set(),
    });
    const texts = recorded.events
      .filter((event) => event.type === 'transcript' && event.event.kind === 'text')
      .map((event) => (event.type === 'transcript' ? event.event.text : undefined));
    assert.deepEqual(texts, ['hello from droid']);
  } finally {
    await session.close(ShutdownDeadline.fromDurationMs(0));
  }
});

test('a stream error after acceptance yields exactly one settlement without raw payloads', async () => {
  const runtime = new FakeFactoryRuntime([]);
  const factory = new FakeFactorySession('provider-1', {}, []);
  factory.nextStreamError = new Error('FACTORY_SECRET boom');
  runtime.createQueue.push(factory);
  const adapter = adapterWithRuntime(runtime);
  const recorded = recordingSink();
  const input = createInput(recorded.sink);
  const session = await adapter.create(input);
  session.activate();
  const returned = await session.startTurn({
    turnId: 'turn-fail',
    prompt: { text: 'hi', skills: [], files: [], browserRefs: [] },
    configuration: input.configuration,
  });
  assertStartTurnDidNotSettle(returned, recorded.events, 'turn-fail');
  await waitForTurnSettlement(recorded.events, 'turn-fail');
  assertExactlyOneTurnSettlement(recorded.events, 'turn-fail');
  const settled = recorded.events.find((event) => event.type === 'turn.settled');
  assert.equal(settled?.type, 'turn.settled');
  if (settled?.type === 'turn.settled' && settled.settlement.status === 'failed') {
    assert.equal(settled.settlement.error.message.includes('FACTORY_SECRET'), false);
    assert.equal(settled.settlement.error.providerInstanceId, 'droid');
    assert.equal(settled.settlement.error.message, 'Droid turn failed.');
  } else {
    assert.fail('expected a failed settlement');
  }
  assert.equal(JSON.stringify(recorded.events).includes('FACTORY_SECRET'), false);
  await session.close(ShutdownDeadline.fromDurationMs(0));
});

test('permission and question handlers settle through the interaction sink', async () => {
  const runtime = new FakeFactoryRuntime([]);
  const adapter = adapterWithRuntime(runtime);
  const recorded = recordingSink();
  const interactions = answeringSink();
  const session = await adapter.create(
    createInput(recorded.sink, { interactionSink: interactions }),
  );
  session.activate();
  const factory = runtime.sessions.get('provider-1');
  assert.ok(factory?.handlers.permissionHandler);
  assert.ok(factory.handlers.askUserHandler);
  const permission: RequestPermissionRequestParams = {
    toolUses: [
      {
        toolUse: { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'pwd' } },
        confirmationType: ToolConfirmationType.Execute,
        details: {
          type: ToolConfirmationType.Execute,
          fullCommand: 'pwd',
          command: 'pwd',
        },
      },
    ],
    options: [],
  };
  await factory.handlers.permissionHandler(permission);
  assert.equal(interactions.approvals, 1);
  const question: AskUserRequestParams = {
    toolCallId: 'q1',
    questions: [{ topic: 'scope', question: 'Where?', options: ['Workspace'], index: 0 }],
  };
  await factory.handlers.askUserHandler(question);
  assert.equal(interactions.questions, 1);
  await session.close(ShutdownDeadline.fromDurationMs(0));
});

test('exit-spec permission requests plan review rather than a generic approval', async () => {
  const runtime = new FakeFactoryRuntime([]);
  const adapter = adapterWithRuntime(runtime);
  const recorded = recordingSink();
  const interactions = answeringSink();
  const session = await adapter.create(
    createInput(recorded.sink, { interactionSink: interactions }),
  );
  const factory = runtime.sessions.get('provider-1');
  assert.ok(factory?.handlers.permissionHandler);
  await factory.handlers.permissionHandler({
    toolUses: [
      {
        toolUse: { type: 'tool_use', id: 't2', name: 'ExitSpecMode', input: {} },
        confirmationType: ToolConfirmationType.ExitSpecMode,
        details: { type: ToolConfirmationType.ExitSpecMode, plan: 'Ship it.' },
      },
    ],
    options: [],
  });
  assert.equal(interactions.plans, 1);
  assert.equal(interactions.approvals, 0);
  await session.close(ShutdownDeadline.fromDurationMs(0));
});

test('activate is one-shot; adapter close is reverse-order and passes the same deadline', async () => {
  const closeOrder: string[] = [];
  const calls: RecordedCall[] = [];
  const first = new FakeFactorySession('first', {}, calls);
  const second = new FakeFactorySession('second', {}, calls);
  const originalFirstClose = first.close.bind(first);
  const originalSecondClose = second.close.bind(second);
  first.close = async () => {
    closeOrder.push('first');
    await originalFirstClose();
  };
  second.close = async () => {
    closeOrder.push('second');
    await originalSecondClose();
  };
  const runtime = new FakeFactoryRuntime(calls);
  runtime.createQueue.push(first, second);
  const adapter = adapterWithRuntime(runtime);
  const recorded = recordingSink();
  const sessionA = await adapter.create(createInput(recorded.sink));
  const sessionB = await adapter.create(createInput(recorded.sink));
  assertActivateIsOneShot(sessionA);
  const deadline = ShutdownDeadline.fromDurationMs(0);
  const started = performance.now();
  await adapter.close(deadline);
  await adapter.close(deadline);
  assert.ok(performance.now() - started < 2_000);
  assertSameShutdownDeadline(adapter.receivedCloseDeadline, deadline);
  assertSameShutdownDeadline(sessionA.receivedCloseDeadline, deadline);
  assertSameShutdownDeadline(sessionB.receivedCloseDeadline, deadline);
  assert.deepEqual(closeOrder, ['second', 'first']);
});

test('pre-activation overflow discards the buffer and fails the open', async () => {
  const runtime = new FakeFactoryRuntime([]);
  const factory = floodOnSubscribe(new FakeFactorySession('flood-1', {}, []), 512);
  runtime.createQueue.push(factory);
  const adapter = adapterWithRuntime(runtime);
  const recorded = recordingSink();
  await assert.rejects(
    () => adapter.create(createInput(recorded.sink)),
    (error: unknown) =>
      error instanceof ProviderContractError && error.code === 'native_session_start_failed',
  );
  const failed = adapter.sessions[0];
  assert.ok(failed);
  assertPreActivationOverflow({
    emittedToSink: recorded.events.length,
    discarded: failed.discardedCount === 512,
    closed: failed.isClosed,
    laterEventsAccepted: failed.laterEventsAccepted,
    nativeCallbacksSettled: failed.nativeCallbacksSettled,
  });
});
