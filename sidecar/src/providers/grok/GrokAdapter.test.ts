import assert from 'node:assert/strict';
import test from 'node:test';

import { AcpConnection } from '../acp/AcpConnection.js';
import type { ProviderRuntimeEvent } from '../providerEvents.js';
import {
  ProviderContractError,
  START_TURN_ACCEPTANCE_ONLY,
  type ProviderInteractionSink,
  type ProviderSessionCreateInput,
} from '../providerTypes.js';
import { ShutdownDeadline } from '../shutdownDeadline.js';
import { createTestClock, createTestIdSource } from '../testing/FakeProviderAdapter.js';
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
import { GrokProviderAdapter, type GrokAdapterOptions } from './GrokAdapter.js';
import {
  GROK_ACP_CLIENT_INFO,
  GROK_AUTH_METHOD_API_KEY,
  GROK_AUTH_METHOD_CACHED_TOKEN,
  GROK_DEFAULT_SPAWN_ARGS,
  GROK_DEFINITION,
  GROK_OAUTH2_REFERRER,
  GROK_SPAWN_ARGS_BY_AUTONOMY,
  GROK_VERSION_TIMEOUT_MS,
} from './grokHandshake.js';
import type { GrokAcpClient } from './grokSession.js';
import { ManualGrokTimer } from './grokWatchdog.js';
import {
  GROK_FAKE_EXTENSION_ENV,
  GROK_FAKE_MODELS_ENV,
  GROK_FAKE_PERMISSION_COUNT_ENV,
  GROK_FAKE_PLAN_DETECT_ENV,
  GROK_FAKE_PROMPT_ENV,
  GROK_FAKE_SECOND_PERMISSION_COMMAND_ENV,
  fakeGrokAgentSpawn,
} from './testing/fakeGrokAgent.js';

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
      if (overrides.requestApproval) {
        return overrides.requestApproval(input);
      }
      return { decision: 'allow_session' };
    },
    requestQuestion: async (input) => {
      sink.questions += 1;
      if (overrides.requestQuestion) {
        return overrides.requestQuestion(input);
      }
      return {
        status: 'answered',
        answers: {
          scope: ['Workspace'],
          'Which changes should be included?': ['Tests', 'Docs'],
        },
      };
    },
    requestPlanReview: async (input) => {
      sink.plans += 1;
      if (overrides.requestPlanReview) {
        return overrides.requestPlanReview(input);
      }
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
    expectedGeneration?: number;
    interactionSink?: ProviderInteractionSink;
    options?: Record<string, string | number | boolean>;
  } = {},
): ProviderSessionCreateInput {
  return {
    target: { kind: 'session', appSessionId: 'app-1' },
    configuration: {
      providerSelection: {
        providerInstanceId: 'grok',
        modelId: overrides.modelId ?? 'grok-build',
        options: overrides.options ?? {},
      },
      interactionMode: 'auto',
      autonomy: overrides.autonomy ?? 'medium',
    },
    expectedGeneration: overrides.expectedGeneration ?? 3,
    cwd: process.cwd(),
    eventSink: sink,
    interactionSink: overrides.interactionSink ?? answeringSink(),
    ids: createTestIdSource('grok'),
    clock: createTestClock(),
  };
}

class ControllableAcp implements GrokAcpClient {
  readonly sessionId: string;
  readonly sessionSetupResult: unknown;
  readonly requests: Array<{ method: string; params: unknown }> = [];
  cancels = 0;
  closedWith: ShutdownDeadline | undefined;
  #prompt:
    | {
        resolve: (value: unknown) => void;
        reject: (error: unknown) => void;
      }
    | undefined;

  constructor(
    sessionId = 'mock-session-1',
    models: {
      currentModelId: string;
      availableModels: Array<{ modelId: string; name: string }>;
    } = {
      currentModelId: 'grok-build',
      availableModels: [{ modelId: 'grok-build', name: 'Grok Build' }],
    },
  ) {
    this.sessionId = sessionId;
    this.sessionSetupResult = { sessionId, models };
  }

  request(method: string, params?: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    return Promise.resolve({});
  }

  notify(): void {
    return;
  }

  prompt(_blocks: readonly unknown[]): Promise<unknown> {
    let resolve: (value: unknown) => void = () => undefined;
    let reject: (error: unknown) => void = () => undefined;
    const promise = new Promise<unknown>((next, fail) => {
      resolve = next;
      reject = fail;
    });
    this.#prompt = { resolve, reject };
    return promise;
  }

  cancel(): void {
    this.cancels += 1;
  }

  async close(deadline: ShutdownDeadline): Promise<void> {
    this.closedWith = deadline;
    this.#prompt?.reject(new Error('closed'));
  }

  completePrompt(result: unknown = { stopReason: 'end_turn' }): void {
    this.#prompt?.resolve(result);
  }

  failPrompt(error: unknown): void {
    this.#prompt?.reject(error);
  }
}

function adapterWithPeer(env: NodeJS.ProcessEnv = {}, extras: GrokAdapterOptions = {}) {
  const spawn = fakeGrokAgentSpawn(env);
  return new GrokProviderAdapter({
    spawnAcp: spawn,
    env: spawn.env,
    runCommand: async () => ({
      stdout: 'grok 1.2.3\n',
      stderr: '',
      code: 0,
      timedOut: false,
    }),
    ...extras,
  });
}

function adapterWithControllable(peer: ControllableAcp, extras: GrokAdapterOptions = {}) {
  return new GrokProviderAdapter({
    connectAcp: async (options) => {
      void options;
      return peer;
    },
    runCommand: async () => ({
      stdout: 'grok 1.2.3\n',
      stderr: '',
      code: 0,
      timedOut: false,
    }),
    ...extras,
  });
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

test('GrokProviderAdapter binds as a grok adapter with complete capabilities', () => {
  const adapter = bindProviderAdapter(new GrokProviderAdapter());
  assert.deepEqual(adapter.definition, GROK_DEFINITION);
});

test('probe reports ready with unknown auth, version timeout budget, and sessionSetup models', async () => {
  const versionCalls: Array<{ args: readonly string[]; timeoutMs: number }> = [];
  const peer = new ControllableAcp();
  const adapter = adapterWithControllable(peer, {
    runCommand: async (input) => {
      versionCalls.push({ args: input.args, timeoutMs: input.timeoutMs });
      return { stdout: 'grok 1.2.3\n', stderr: '', code: 0, timedOut: false };
    },
  });
  const snapshot = await adapter.probe(new AbortController().signal);
  assert.equal(snapshot.readiness, 'ready');
  assert.equal(snapshot.auth, undefined);
  assert.equal(snapshot.executable?.version, '1.2.3');
  assert.equal(snapshot.models[0]?.id, 'grok-build');
  assertCompleteCapabilities(snapshot.capabilities);
  assert.equal(snapshot.capabilities.usageReporting, false);
  assert.equal(snapshot.capabilities.reasoningStream, false);
  assert.equal(snapshot.capabilities.steer, false);
  assert.deepEqual(versionCalls[0], { args: ['--version'], timeoutMs: GROK_VERSION_TIMEOUT_MS });

  const timedOut = adapterWithControllable(peer, {
    runCommand: async () => ({ stdout: '', stderr: '', code: 1, timedOut: true }),
  });
  const timeoutSnapshot = await timedOut.probe(new AbortController().signal);
  assert.equal(timeoutSnapshot.readiness, 'unavailable');

  const missing = new GrokProviderAdapter({
    binaryPath: '/definitely/not-a-grok-binary',
  });
  const missingSnapshot = await missing.probe(new AbortController().signal);
  assert.equal(missingSnapshot.readiness, 'missing');
  assert.equal(missingSnapshot.error?.code, 'missing_executable');
  assert.equal(missingSnapshot.error?.message.includes('ENOENT'), false);
});

test('empty model catalog over ACP falls back to grok-build', async () => {
  const adapter = adapterWithPeer({ [GROK_FAKE_MODELS_ENV]: '' });
  const snapshot = await adapter.probe(new AbortController().signal);
  assert.equal(snapshot.models.length, 1);
  assert.equal(snapshot.models[0]?.id, 'grok-build');
});

test('probe reads advertised models from the ACP sessionSetupResult', async () => {
  const adapter = adapterWithPeer();
  const snapshot = await adapter.probe(new AbortController().signal);
  assert.equal(snapshot.readiness, 'ready');
  assert.equal(snapshot.auth, undefined);
  assert.deepEqual(
    snapshot.models.map((model) => model.id),
    ['grok-build', 'grok-4.6'],
  );
});

test('create handshake uses DROIDEX client info and the selected auth method', async () => {
  let connection: AcpConnection | undefined;
  const spawn = fakeGrokAgentSpawn({ XAI_API_KEY: 'sk-test' });
  const adapter = new GrokProviderAdapter({
    spawnAcp: spawn,
    env: spawn.env,
    connectAcp: async (options) => {
      connection = await AcpConnection.connect(options);
      return connection;
    },
  });
  const recorded = recordingSink();
  const session = await adapter.create(createInput(recorded.sink));
  try {
    assert.ok(connection);
    const handshake = await connection.request('x/handshake');
    assert.ok(isPlainObject(handshake) && isPlainObject(handshake.initializeParams));
    assert.deepEqual(handshake.initializeParams.clientInfo, GROK_ACP_CLIENT_INFO);
    assert.ok(isPlainObject(handshake.authenticateParams));
    assert.equal(handshake.authenticateParams.methodId, GROK_AUTH_METHOD_API_KEY);
  } finally {
    await session.close(ShutdownDeadline.fromDurationMs(5_000));
  }
});

test('cached_token is used when XAI_API_KEY is absent', async () => {
  let connection: AcpConnection | undefined;
  const spawn = fakeGrokAgentSpawn();
  delete spawn.env.XAI_API_KEY;
  const adapter = new GrokProviderAdapter({
    spawnAcp: spawn,
    env: spawn.env,
    connectAcp: async (options) => {
      connection = await AcpConnection.connect(options);
      return connection;
    },
  });
  const recorded = recordingSink();
  const session = await adapter.create(createInput(recorded.sink));
  try {
    assert.ok(connection);
    const handshake = await connection.request('x/handshake');
    assert.ok(isPlainObject(handshake) && isPlainObject(handshake.authenticateParams));
    assert.equal(handshake.authenticateParams.methodId, GROK_AUTH_METHOD_CACHED_TOKEN);
  } finally {
    await session.close(ShutdownDeadline.fromDurationMs(5_000));
  }
});

test('each autonomy posture produces the matching spawn argv and DROIDEX referrer', async () => {
  for (const autonomy of ['off', 'low', 'medium', 'high'] as const) {
    let seen: { args: readonly string[]; env?: NodeJS.ProcessEnv } | undefined;
    const adapter = new GrokProviderAdapter({
      env: { GROK_OAUTH2_REFERRER: 't3code' },
      connectAcp: async (options) => {
        seen = { args: options.spawn.args, env: options.spawn.env };
        return new ControllableAcp();
      },
    });
    const recorded = recordingSink();
    const session = await adapter.create(createInput(recorded.sink, { autonomy }));
    assert.deepEqual(seen?.args, [...GROK_SPAWN_ARGS_BY_AUTONOMY[autonomy]]);
    assert.equal(seen?.env?.GROK_OAUTH2_REFERRER, GROK_OAUTH2_REFERRER);
    await session.close(ShutdownDeadline.fromDurationMs(0));
  }
});

test('startTurn resolves on acceptance; settlement arrives later exactly once', async () => {
  const adapter = adapterWithPeer();
  const recorded = recordingSink();
  const session = await adapter.create(createInput(recorded.sink));
  try {
    session.activate();
    const returned = await session.startTurn({
      turnId: 'turn-1',
      prompt: { text: 'hello', skills: [], files: [], browserRefs: [] },
      configuration: createInput(recorded.sink).configuration,
    });
    assertStartTurnDidNotSettle(returned, recorded.events, 'turn-1');
    await waitForTurnSettlement(recorded.events, 'turn-1');
    assertExactlyOneTurnSettlement(recorded.events, 'turn-1', { status: 'completed' });
    const liveEvent = recorded.events.find((event) => event.type === 'transcript');
    assert.ok(liveEvent);
    assertEventAdmissibleForSession(liveEvent, {
      target: { kind: 'session', appSessionId: 'app-1' },
      providerDriverKind: 'grok',
      providerInstanceId: 'grok',
      runtimeGeneration: 3,
      settledTurnIds: new Set(),
    });
  } finally {
    await session.close(ShutdownDeadline.fromDurationMs(5_000));
  }
});

test('reasoning effort is passed through session/set_model', async () => {
  let connection: AcpConnection | undefined;
  const adapter = new GrokProviderAdapter({
    spawnAcp: fakeGrokAgentSpawn(),
    connectAcp: async (options) => {
      connection = await AcpConnection.connect(options);
      return connection;
    },
  });
  const recorded = recordingSink();
  const session = await adapter.create(createInput(recorded.sink));
  try {
    session.activate();
    await session.startTurn({
      turnId: 'turn-model',
      prompt: { text: 'hi', skills: [], files: [], browserRefs: [] },
      configuration: createInput(recorded.sink, {
        modelId: 'grok-4.6',
        options: { reasoningEffort: 'xhigh' },
      }).configuration,
    });
    await waitForTurnSettlement(recorded.events, 'turn-model');
    assert.ok(connection);
    const handshake = await connection.request('x/handshake');
    assert.ok(isPlainObject(handshake) && Array.isArray(handshake.setModelCalls));
    const first = handshake.setModelCalls[0];
    assert.ok(isPlainObject(first));
    assert.equal(first.modelId, 'grok-4.6');
    assert.ok(isPlainObject(first._meta));
    assert.equal(first._meta.reasoningEffort, 'xhigh');
  } finally {
    await session.close(ShutdownDeadline.fromDurationMs(5_000));
  }
});

test('a bad model id is rejected by the model-token regex', async () => {
  const adapter = adapterWithPeer();
  const recorded = recordingSink();
  const session = await adapter.create(createInput(recorded.sink, { modelId: 'grok-build' }));
  try {
    session.activate();
    await assert.rejects(
      () =>
        session.startTurn({
          turnId: 'turn-bad',
          prompt: { text: 'hi', skills: [], files: [], browserRefs: [] },
          configuration: createInput(recorded.sink, { modelId: 'not a token' }).configuration,
        }),
      (error: unknown) =>
        error instanceof ProviderContractError && error.code === 'invalid_provider_configuration',
    );
  } finally {
    await session.close(ShutdownDeadline.fromDurationMs(0));
  }
});

test('settlement from prompt-complete and from prompt result is exactly one, including both', async () => {
  for (const behavior of ['complete', 'prompt-complete', 'both'] as const) {
    const adapter = adapterWithPeer({ [GROK_FAKE_PROMPT_ENV]: behavior });
    const recorded = recordingSink();
    const session = await adapter.create(createInput(recorded.sink));
    try {
      session.activate();
      await session.startTurn({
        turnId: `turn-${behavior}`,
        prompt: { text: 'hi', skills: [], files: [], browserRefs: [] },
        configuration: createInput(recorded.sink).configuration,
      });
      await waitForTurnSettlement(recorded.events, `turn-${behavior}`);
      assertExactlyOneTurnSettlement(recorded.events, `turn-${behavior}`, { status: 'completed' });
    } finally {
      await session.close(ShutdownDeadline.fromDurationMs(5_000));
    }
  }
});

test('rate-limit -32003 is a ProviderError without leaking the peer payload', async () => {
  const adapter = adapterWithPeer({ [GROK_FAKE_PROMPT_ENV]: 'rate-limit-rpc' });
  const recorded = recordingSink();
  const session = await adapter.create(createInput(recorded.sink));
  try {
    session.activate();
    await session.startTurn({
      turnId: 'turn-rl',
      prompt: { text: 'hi', skills: [], files: [], browserRefs: [] },
      configuration: createInput(recorded.sink).configuration,
    });
    await waitForTurnSettlement(recorded.events, 'turn-rl');
    const settled = recorded.events.find((event) => event.type === 'turn.settled');
    assert.equal(settled?.type, 'turn.settled');
    if (settled?.type === 'turn.settled' && settled.settlement.status === 'failed') {
      assert.equal(settled.settlement.error.providerInstanceId, 'grok');
      assert.equal(settled.settlement.error.code, 'unavailable_provider_instance');
      assert.equal(settled.settlement.error.message.includes('native payload'), false);
      assert.match(settled.settlement.error.message, /usage limit/i);
    } else {
      assert.fail('expected a failed settlement');
    }
  } finally {
    await session.close(ShutdownDeadline.fromDurationMs(5_000));
  }
});

test('prompt-complete rate_limit is a ProviderError', async () => {
  const adapter = adapterWithPeer({ [GROK_FAKE_PROMPT_ENV]: 'rate-limit-complete' });
  const recorded = recordingSink();
  const session = await adapter.create(createInput(recorded.sink));
  try {
    session.activate();
    await session.startTurn({
      turnId: 'turn-rlc',
      prompt: { text: 'hi', skills: [], files: [], browserRefs: [] },
      configuration: createInput(recorded.sink).configuration,
    });
    await waitForTurnSettlement(recorded.events, 'turn-rlc');
    const settled = recorded.events.find((event) => event.type === 'turn.settled');
    assert.equal(settled?.type, 'turn.settled');
    if (settled?.type === 'turn.settled' && settled.settlement.status === 'failed') {
      assert.equal(settled.settlement.error.providerInstanceId, 'grok');
      assert.match(settled.settlement.error.message, /usage limit/i);
    } else {
      assert.fail('expected a failed settlement');
    }
  } finally {
    await session.close(ShutdownDeadline.fromDurationMs(5_000));
  }
});

test('prefixed and unprefixed extension methods both work', async () => {
  for (const prefix of ['prefixed', 'unprefixed'] as const) {
    const interaction = answeringSink();
    const adapter = adapterWithPeer({
      [GROK_FAKE_PROMPT_ENV]: 'question',
      [GROK_FAKE_EXTENSION_ENV]: prefix,
    });
    const recorded = recordingSink();
    const session = await adapter.create(
      createInput(recorded.sink, { interactionSink: interaction }),
    );
    try {
      session.activate();
      await session.startTurn({
        turnId: `turn-q-${prefix}`,
        prompt: { text: 'hi', skills: [], files: [], browserRefs: [] },
        configuration: createInput(recorded.sink).configuration,
      });
      await waitForTurnSettlement(recorded.events, `turn-q-${prefix}`);
      assert.equal(interaction.questions, 1);
    } finally {
      await session.close(ShutdownDeadline.fromDurationMs(5_000));
    }
  }
});

test('ask_user_question answers are keyed by question text including multi-select', async () => {
  let connection: AcpConnection | undefined;
  const spawn = fakeGrokAgentSpawn({ [GROK_FAKE_PROMPT_ENV]: 'question' });
  const adapter = new GrokProviderAdapter({
    spawnAcp: spawn,
    env: spawn.env,
    connectAcp: async (options) => {
      connection = await AcpConnection.connect(options);
      return connection;
    },
  });
  const recorded = recordingSink();
  const session = await adapter.create(createInput(recorded.sink));
  try {
    session.activate();
    await session.startTurn({
      turnId: 'turn-ask',
      prompt: { text: 'hi', skills: [], files: [], browserRefs: [] },
      configuration: createInput(recorded.sink).configuration,
    });
    await waitForTurnSettlement(recorded.events, 'turn-ask');
    assert.ok(connection);
    const handshake = await connection.request('x/handshake');
    assert.ok(isPlainObject(handshake) && Array.isArray(handshake.questionResults));
    const result = handshake.questionResults[0];
    assert.ok(isPlainObject(result) && isPlainObject(result.answers));
    assert.deepEqual(result.answers['Which scope should Grok use?'], ['Workspace']);
    assert.deepEqual(result.answers['Which changes should be included?'], ['Tests', 'Docs']);
    assert.equal(result.answers.scope, undefined);
  } finally {
    await session.close(ShutdownDeadline.fromDurationMs(5_000));
  }
});

test('exit_plan_mode is captured promptly so the gate does not hang', async () => {
  for (const detect of ['title', 'variant'] as const) {
    const interaction = answeringSink();
    let connection: AcpConnection | undefined;
    const spawn = fakeGrokAgentSpawn({
      [GROK_FAKE_PROMPT_ENV]: 'plan',
      [GROK_FAKE_PLAN_DETECT_ENV]: detect,
    });
    const adapter = new GrokProviderAdapter({
      spawnAcp: spawn,
      env: spawn.env,
      connectAcp: async (options) => {
        connection = await AcpConnection.connect(options);
        return connection;
      },
    });
    const recorded = recordingSink();
    const session = await adapter.create(
      createInput(recorded.sink, { interactionSink: interaction }),
    );
    try {
      session.activate();
      await session.startTurn({
        turnId: `turn-plan-${detect}`,
        prompt: { text: 'hi', skills: [], files: [], browserRefs: [] },
        configuration: createInput(recorded.sink).configuration,
      });
      await waitForTurnSettlement(recorded.events, `turn-plan-${detect}`);
      assert.ok(connection);
      const handshake = await connection.request('x/handshake');
      assert.ok(isPlainObject(handshake) && Array.isArray(handshake.exitPlanResults));
      const captured = handshake.exitPlanResults[0];
      assert.ok(isPlainObject(captured));
      assert.equal(captured.outcome, 'abandoned');
      assert.equal(interaction.plans, 1);
    } finally {
      await session.close(ShutdownDeadline.fromDurationMs(5_000));
    }
  }
});

test('identical plan bodies are deduplicated per turn', async () => {
  const interaction = answeringSink();
  const adapter = adapterWithPeer({ [GROK_FAKE_PROMPT_ENV]: 'plan-twice' });
  const recorded = recordingSink();
  const session = await adapter.create(
    createInput(recorded.sink, { interactionSink: interaction }),
  );
  try {
    session.activate();
    await session.startTurn({
      turnId: 'turn-dedupe',
      prompt: { text: 'hi', skills: [], files: [], browserRefs: [] },
      configuration: createInput(recorded.sink).configuration,
    });
    await waitForTurnSettlement(recorded.events, 'turn-dedupe');
    assert.equal(interaction.plans, 1);
  } finally {
    await session.close(ShutdownDeadline.fromDurationMs(5_000));
  }
});

test('permission fingerprints are remembered within a session and not across sessions', async () => {
  const first = answeringSink();
  const adapter = adapterWithPeer({
    [GROK_FAKE_PROMPT_ENV]: 'permission',
    [GROK_FAKE_PERMISSION_COUNT_ENV]: '2',
    [GROK_FAKE_SECOND_PERMISSION_COMMAND_ENV]: 'ls',
  });
  const recorded = recordingSink();
  const session = await adapter.create(
    createInput(recorded.sink, { autonomy: 'off', interactionSink: first }),
  );
  try {
    session.activate();
    await session.startTurn({
      turnId: 'turn-perm',
      prompt: { text: 'hi', skills: [], files: [], browserRefs: [] },
      configuration: createInput(recorded.sink, { autonomy: 'off' }).configuration,
    });
    await waitForTurnSettlement(recorded.events, 'turn-perm');
    assert.equal(first.approvals, 1);
  } finally {
    await session.close(ShutdownDeadline.fromDurationMs(5_000));
  }

  const second = answeringSink();
  const adapter2 = adapterWithPeer({
    [GROK_FAKE_PROMPT_ENV]: 'permission',
    [GROK_FAKE_PERMISSION_COUNT_ENV]: '1',
  });
  const recorded2 = recordingSink();
  const session2 = await adapter2.create(
    createInput(recorded2.sink, { autonomy: 'off', interactionSink: second }),
  );
  try {
    session2.activate();
    await session2.startTurn({
      turnId: 'turn-perm-2',
      prompt: { text: 'hi', skills: [], files: [], browserRefs: [] },
      configuration: createInput(recorded2.sink, { autonomy: 'off' }).configuration,
    });
    await waitForTurnSettlement(recorded2.events, 'turn-perm-2');
    assert.equal(second.approvals, 1);
  } finally {
    await session2.close(ShutdownDeadline.fromDurationMs(5_000));
  }
});

test('a different command after session allow is asked again', async () => {
  const interaction = answeringSink();
  const adapter = adapterWithPeer({
    [GROK_FAKE_PROMPT_ENV]: 'permission',
    [GROK_FAKE_PERMISSION_COUNT_ENV]: '2',
    [GROK_FAKE_SECOND_PERMISSION_COMMAND_ENV]: 'rm',
  });
  const recorded = recordingSink();
  const session = await adapter.create(
    createInput(recorded.sink, { autonomy: 'off', interactionSink: interaction }),
  );
  try {
    session.activate();
    await session.startTurn({
      turnId: 'turn-diff',
      prompt: { text: 'hi', skills: [], files: [], browserRefs: [] },
      configuration: createInput(recorded.sink, { autonomy: 'off' }).configuration,
    });
    await waitForTurnSettlement(recorded.events, 'turn-diff');
    assert.equal(interaction.approvals, 2);
  } finally {
    await session.close(ShutdownDeadline.fromDurationMs(5_000));
  }
});

test('interactions settle once on response, interrupt, close, crash, and shutdown', async () => {
  const hanging: ProviderInteractionSink = {
    requestApproval: () => new Promise(() => undefined),
    requestQuestion: () => new Promise(() => undefined),
    requestPlanReview: () => new Promise(() => undefined),
  };

  const interruptPeer = new ControllableAcp();
  const interruptAdapter = adapterWithControllable(interruptPeer);
  const interruptRecorded = recordingSink();
  const interruptSession = await interruptAdapter.create(
    createInput(interruptRecorded.sink, { interactionSink: hanging }),
  );
  interruptSession.activate();
  await interruptSession.startTurn({
    turnId: 'turn-int',
    prompt: { text: 'hi', skills: [], files: [], browserRefs: [] },
    configuration: createInput(interruptRecorded.sink).configuration,
  });
  const permission = interruptSession.onAcpServerRequest({
    id: 1,
    method: 'session/request_permission',
    params: {
      sessionId: 'mock-session-1',
      toolCall: {
        toolCallId: 't1',
        title: 'Terminal',
        kind: 'execute',
        rawInput: { command: 'ls' },
      },
      options: [{ optionId: 'allow-once', kind: 'allow_once' }],
    },
  });
  await interruptSession.interrupt({ turnId: 'turn-int', runtimeGeneration: 3 });
  const permissionResult = await permission;
  assert.deepEqual(permissionResult, { outcome: { outcome: 'cancelled' } });
  assertExactlyOneTurnSettlement(interruptRecorded.events, 'turn-int', { status: 'interrupted' });
  await interruptSession.close(ShutdownDeadline.fromDurationMs(0));

  const closePeer = new ControllableAcp();
  const closeAdapter = adapterWithControllable(closePeer);
  const closeRecorded = recordingSink();
  const closeSession = await closeAdapter.create(
    createInput(closeRecorded.sink, { interactionSink: hanging }),
  );
  closeSession.activate();
  await closeSession.startTurn({
    turnId: 'turn-close',
    prompt: { text: 'hi', skills: [], files: [], browserRefs: [] },
    configuration: createInput(closeRecorded.sink).configuration,
  });
  const question = closeSession.onAcpServerRequest({
    id: 2,
    method: 'x.ai/ask_user_question',
    params: {
      sessionId: 'mock-session-1',
      toolCallId: 'q1',
      mode: 'default',
      questions: [{ question: 'Go?', options: [{ label: 'Yes' }] }],
    },
  });
  await closeSession.close(ShutdownDeadline.fromDurationMs(0));
  const questionResult = await question;
  assert.deepEqual(questionResult, { outcome: 'cancelled' });
  assertExactlyOneTurnSettlement(closeRecorded.events, 'turn-close', { status: 'cancelled' });

  const crashPeer = new ControllableAcp();
  const crashAdapter = adapterWithControllable(crashPeer);
  const crashRecorded = recordingSink();
  const crashSession = await crashAdapter.create(createInput(crashRecorded.sink));
  crashSession.activate();
  await crashSession.startTurn({
    turnId: 'turn-crash',
    prompt: { text: 'hi', skills: [], files: [], browserRefs: [] },
    configuration: createInput(crashRecorded.sink).configuration,
  });
  crashPeer.failPrompt(new Error('native boom'));
  await waitForTurnSettlement(crashRecorded.events, 'turn-crash');
  const crashSettled = crashRecorded.events.find((event) => event.type === 'turn.settled');
  assert.equal(crashSettled?.type, 'turn.settled');
  if (crashSettled?.type === 'turn.settled' && crashSettled.settlement.status === 'failed') {
    assert.equal(crashSettled.settlement.error.message.includes('boom'), false);
    assert.equal(crashSettled.settlement.error.providerInstanceId, 'grok');
  }
  await crashSession.close(ShutdownDeadline.fromDurationMs(0));

  const shutdownPeer = new ControllableAcp();
  const shutdownAdapter = adapterWithControllable(shutdownPeer);
  const shutdownRecorded = recordingSink();
  const shutdownSession = await shutdownAdapter.create(
    createInput(shutdownRecorded.sink, { interactionSink: hanging }),
  );
  shutdownSession.activate();
  await shutdownSession.startTurn({
    turnId: 'turn-shut',
    prompt: { text: 'hi', skills: [], files: [], browserRefs: [] },
    configuration: createInput(shutdownRecorded.sink).configuration,
  });
  const plan = shutdownSession.onAcpServerRequest({
    id: 3,
    method: '_x.ai/exit_plan_mode',
    params: { sessionId: 'mock-session-1', toolCallId: 'p1', planContent: '# Plan' },
  });
  const planResult = await plan;
  assert.ok(isPlainObject(planResult) && planResult.outcome === 'abandoned');
  const deadline = ShutdownDeadline.fromDurationMs(0);
  await shutdownAdapter.close(deadline);
  assertSameShutdownDeadline(shutdownAdapter.receivedCloseDeadline, deadline);
  assertExactlyOneTurnSettlement(shutdownRecorded.events, 'turn-shut', { status: 'cancelled' });
});

test('steer throws unsupported_capability', async () => {
  const peer = new ControllableAcp();
  const adapter = adapterWithControllable(peer);
  const recorded = recordingSink();
  const session = await adapter.create(createInput(recorded.sink));
  session.activate();
  await assert.rejects(
    () =>
      session.steer({
        turnId: 'turn-1',
        prompt: { text: 'nudge', skills: [], files: [], browserRefs: [] },
      }),
    (error: unknown) =>
      error instanceof ProviderContractError && error.code === 'unsupported_capability',
  );
  await session.close(ShutdownDeadline.fromDurationMs(0));
});

test('activate is one-shot; close is idempotent and respects an expired deadline', async () => {
  const adapter = adapterWithPeer();
  const recorded = recordingSink();
  const session = await adapter.create(createInput(recorded.sink));
  assertActivateIsOneShot(session);
  const deadline = ShutdownDeadline.fromDurationMs(0);
  const started = performance.now();
  await session.close(deadline);
  await session.close(deadline);
  assert.ok(performance.now() - started < 2_000);
  assertSameShutdownDeadline(session.receivedCloseDeadline, deadline);
  await adapter.close(deadline);
  assertSameShutdownDeadline(adapter.receivedCloseDeadline, deadline);
});

test('pre-activation overflow discards the buffer and closes the provisional session', async () => {
  const recorded = recordingSink();
  const adapter = new GrokProviderAdapter({
    connectAcp: async (options) => {
      for (let index = 0; index < 513; index += 1) {
        options.onNotification?.({
          method: 'session/update',
          params: {
            sessionId: 'mock-session-1',
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: `flood-${String(index)}` },
            },
          },
        });
      }
      return new ControllableAcp();
    },
  });
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

test('watchdog stall uses injected time after activity', async () => {
  const timer = new ManualGrokTimer();
  const peer = new ControllableAcp();
  const adapter = adapterWithControllable(peer, { timer, inactivityMs: 100 });
  const recorded = recordingSink();
  const session = await adapter.create(createInput(recorded.sink));
  session.activate();
  await session.startTurn({
    turnId: 'turn-wd',
    prompt: { text: 'hi', skills: [], files: [], browserRefs: [] },
    configuration: createInput(recorded.sink).configuration,
  });
  session.onAcpNotification({
    method: 'session/update',
    params: {
      sessionId: 'mock-session-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'tick' },
      },
    },
  });
  timer.advance(100);
  assertExactlyOneTurnSettlement(recorded.events, 'turn-wd');
  const settled = recorded.events.find((event) => event.type === 'turn.settled');
  assert.equal(settled?.type, 'turn.settled');
  if (settled?.type === 'turn.settled') {
    assert.equal(settled.settlement.status, 'failed');
  }
  await session.close(ShutdownDeadline.fromDurationMs(0));
});

test('resume uses session/load and invalid resume state is rejected', async () => {
  let connection: AcpConnection | undefined;
  const adapter = new GrokProviderAdapter({
    spawnAcp: fakeGrokAgentSpawn(),
    connectAcp: async (options) => {
      connection = await AcpConnection.connect(options);
      return connection;
    },
  });
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
  try {
    assert.ok(connection);
    assert.equal(connection.sessionId, 'resume-1');
    const methods = await connection.request('x/received-methods');
    assert.ok(isPlainObject(methods) && Array.isArray(methods.receivedMethods));
    assert.deepEqual(methods.receivedMethods.slice(0, 3), [
      'initialize',
      'authenticate',
      'session/load',
    ]);
    assert.equal(methods.receivedMethods.includes('session/new'), false);
  } finally {
    await session.close(ShutdownDeadline.fromDurationMs(5_000));
  }
});

test('high autonomy auto-approves without asking the interaction sink', async () => {
  const interaction = answeringSink();
  const adapter = adapterWithPeer({ [GROK_FAKE_PROMPT_ENV]: 'permission' });
  const recorded = recordingSink();
  const session = await adapter.create(
    createInput(recorded.sink, { autonomy: 'high', interactionSink: interaction }),
  );
  try {
    session.activate();
    await session.startTurn({
      turnId: 'turn-high',
      prompt: { text: 'hi', skills: [], files: [], browserRefs: [] },
      configuration: createInput(recorded.sink, { autonomy: 'high' }).configuration,
    });
    await waitForTurnSettlement(recorded.events, 'turn-high');
    assert.equal(interaction.approvals, 0);
  } finally {
    await session.close(ShutdownDeadline.fromDurationMs(5_000));
  }
});

test('ACP thought chunks are not surfaced', async () => {
  const peer = new ControllableAcp();
  const adapter = adapterWithControllable(peer);
  const recorded = recordingSink();
  const session = await adapter.create(createInput(recorded.sink));
  session.activate();
  await session.startTurn({
    turnId: 'turn-thought',
    prompt: { text: 'hi', skills: [], files: [], browserRefs: [] },
    configuration: createInput(recorded.sink).configuration,
  });
  session.onAcpNotification({
    method: 'session/update',
    params: {
      sessionId: 'mock-session-1',
      update: {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'secret thought' },
      },
    },
  });
  session.onAcpNotification({
    method: 'session/update',
    params: {
      sessionId: 'mock-session-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'visible' },
      },
    },
  });
  peer.completePrompt();
  await waitForTurnSettlement(recorded.events, 'turn-thought');
  const texts = recorded.events
    .filter((event) => event.type === 'transcript')
    .map((event) => (event.type === 'transcript' ? event.event.text : undefined));
  assert.deepEqual(texts, ['visible']);
  await session.close(ShutdownDeadline.fromDurationMs(0));
});

test('probe model discovery uses the default spawn argv and sessionSetup models', async () => {
  let seenArgs: readonly string[] | undefined;
  const peer = new ControllableAcp('mock-session-1', {
    currentModelId: 'grok-build',
    availableModels: [
      { modelId: 'grok-build', name: 'Grok Build' },
      { modelId: 'grok-4.6', name: 'Grok 4.6' },
    ],
  });
  const adapter = adapterWithControllable(peer, {
    connectAcp: async (options) => {
      seenArgs = options.spawn.args;
      return peer;
    },
  });
  const snapshot = await adapter.probe(new AbortController().signal);
  assert.deepEqual(seenArgs, [...GROK_DEFAULT_SPAWN_ARGS]);
  assert.deepEqual(
    snapshot.models.map((model) => model.id),
    ['grok-build', 'grok-4.6'],
  );
});

test('malformed extension payloads fail cleanly', async () => {
  const peer = new ControllableAcp();
  const adapter = adapterWithControllable(peer);
  const recorded = recordingSink();
  const session = await adapter.create(createInput(recorded.sink));
  session.activate();
  await assert.rejects(
    () =>
      session.onAcpServerRequest({
        id: 9,
        method: 'x.ai/ask_user_question',
        params: { nope: true },
      }),
    (error: unknown) =>
      error instanceof ProviderContractError && error.code === 'incompatible_provider_protocol',
  );
  await session.close(ShutdownDeadline.fromDurationMs(0));
});
