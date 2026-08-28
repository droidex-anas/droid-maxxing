import assert from 'node:assert/strict';
import test from 'node:test';

import { AcpConnection } from '../acp/AcpConnection.js';
import type { ProviderRuntimeEvent } from '../providerEvents.js';
import { ProviderContractError, START_TURN_ACCEPTANCE_ONLY } from '../providerTypes.js';
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
import { CursorProviderAdapter, type CursorAdapterOptions } from './CursorAdapter.js';
import {
  CURSOR_ABOUT_TIMEOUT_MS,
  CURSOR_ACP_CLIENT_INFO,
  CURSOR_AUTH_METHOD_ID,
  CURSOR_DEFINITION,
} from './cursorHandshake.js';
import type { CursorAcpClient } from './cursorSession.js';
import {
  CURSOR_FAKE_EXTRA_UPDATES_ENV,
  CURSOR_FAKE_MODELS_ENV,
  CURSOR_FAKE_MODES_ENV,
  CURSOR_FAKE_REPLAY_ENV,
  fakeCursorAgentSpawn,
} from './testing/fakeCursorAgent.js';

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

function createInput(
  sink: (event: ProviderRuntimeEvent) => void,
  overrides: {
    modelId?: string;
    interactionMode?: 'auto' | 'spec' | 'agi';
    expectedGeneration?: number;
  } = {},
) {
  return {
    target: { kind: 'session' as const, appSessionId: 'app-1' },
    configuration: {
      providerSelection: {
        providerInstanceId: 'cursor' as const,
        modelId: overrides.modelId ?? 'gpt-5.4-medium-fast[reasoning=medium,context=272k]',
        options: {},
      },
      interactionMode: overrides.interactionMode ?? ('auto' as const),
      autonomy: 'medium' as const,
    },
    expectedGeneration: overrides.expectedGeneration ?? 3,
    cwd: process.cwd(),
    eventSink: sink,
    interactionSink: cancelingInteractionSink(),
    ids: createTestIdSource('cursor'),
    clock: createTestClock(),
  };
}

class ControllableAcp implements CursorAcpClient {
  readonly sessionId: string;
  readonly sessionSetupResult: unknown;
  readonly requests: Array<{ method: string; params: unknown }> = [];
  cancels = 0;
  closedWith: ShutdownDeadline | undefined;
  #prompt:
    | {
        resolve: (value: unknown) => void;
        reject: (error: unknown) => void;
        promise: Promise<unknown>;
      }
    | undefined;

  constructor(
    sessionId = 'mock-session-1',
    modes: Array<{ id: string; name: string }> = [
      { id: 'code', name: 'Code' },
      { id: 'plan', name: 'Plan' },
    ],
  ) {
    this.sessionId = sessionId;
    this.sessionSetupResult = {
      sessionId,
      modes: { currentModeId: modes[0]?.id ?? 'code', availableModes: modes },
    };
  }

  request(method: string, params?: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    if (method === 'cursor/list_available_models') {
      return Promise.resolve({
        models: [
          { value: 'gpt-5.4-medium-fast[reasoning=medium,context=272k]', name: 'GPT-5.4' },
          { value: 'default', name: 'Auto' },
        ],
      });
    }
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
    this.#prompt = { resolve, reject, promise };
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

function adapterWithPeer(env: NodeJS.ProcessEnv = {}, extras: CursorAdapterOptions = {}) {
  const spawn = fakeCursorAgentSpawn(env);
  return new CursorProviderAdapter({
    spawnAcp: spawn,
    env: spawn.env,
    runCommand: async () => ({
      stdout: JSON.stringify({
        cliVersion: '2026.04.09-f2b0fcd',
        userEmail: 'cursor@example.com',
        subscriptionTier: 'Pro',
      }),
      stderr: '',
      code: 0,
      timedOut: false,
    }),
    ...extras,
  });
}

function adapterWithControllable(peer: ControllableAcp, extras: CursorAdapterOptions = {}) {
  return new CursorProviderAdapter({
    connectAcp: async (options) => {
      void options;
      return peer;
    },
    runCommand: async () => ({
      stdout: JSON.stringify({
        cliVersion: '2026.04.09-f2b0fcd',
        userEmail: 'cursor@example.com',
        subscriptionTier: 'Pro',
      }),
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

test('CursorProviderAdapter binds as a cursor adapter with complete capabilities', () => {
  const adapter = bindProviderAdapter(new CursorProviderAdapter());
  assert.deepEqual(adapter.definition, CURSOR_DEFINITION);
});

test('probe JSON path, unauthenticated markers, missing executable, and 8s budget', async () => {
  const aboutCalls: Array<{ args: readonly string[]; timeoutMs: number }> = [];
  const peer = new ControllableAcp();
  const adapter = adapterWithControllable(peer, {
    runCommand: async (input) => {
      aboutCalls.push({ args: input.args, timeoutMs: input.timeoutMs });
      return {
        stdout: JSON.stringify({
          cliVersion: '2026.04.09-f2b0fcd',
          userEmail: 'cursor@example.com',
          subscriptionTier: 'Pro',
        }),
        stderr: '',
        code: 0,
        timedOut: false,
      };
    },
  });
  const snapshot = await adapter.probe(new AbortController().signal);
  assert.equal(snapshot.readiness, 'ready');
  assert.equal(snapshot.auth?.accountLabel, 'cursor@example.com');
  assert.equal(snapshot.auth?.billingLabel, 'Cursor Pro');
  assert.equal(snapshot.models[0]?.id, 'gpt-5.4-medium-fast[reasoning=medium,context=272k]');
  assertCompleteCapabilities(snapshot.capabilities);
  assert.equal(snapshot.capabilities.usageReporting, false);
  assert.equal(snapshot.capabilities.reasoningStream, false);
  assert.equal(snapshot.capabilities.steer, false);
  assert.equal(snapshot.capabilities.interrupt, true);
  assert.deepEqual(aboutCalls[0], {
    args: ['about', '--format', 'json'],
    timeoutMs: CURSOR_ABOUT_TIMEOUT_MS,
  });

  for (const marker of ['Not logged in', 'login required', 'authentication required'] as const) {
    const unauth = adapterWithControllable(peer, {
      runCommand: async () => ({
        stdout: JSON.stringify({ cliVersion: '1.0', userEmail: marker }),
        stderr: '',
        code: 0,
        timedOut: false,
      }),
    });
    const result = await unauth.probe(new AbortController().signal);
    assert.equal(result.readiness, 'unauthenticated', marker);
    assert.equal(result.error?.recoveryAction, 'open_cursor_setup');
  }

  const missing = new CursorProviderAdapter({
    binaryPath: '/definitely/not-a-cursor-agent-binary',
  });
  const missingSnapshot = await missing.probe(new AbortController().signal);
  assert.equal(missingSnapshot.readiness, 'missing');
  assert.equal(missingSnapshot.error?.code, 'missing_executable');
  assert.equal(missingSnapshot.error?.message.includes('ENOENT'), false);
});

test('probe text fallback when --format is unsupported', async () => {
  const adapter = adapterWithControllable(new ControllableAcp(), {
    runCommand: async (input) => {
      if (input.args.includes('--format')) {
        return { stdout: '', stderr: "unknown option '--format'", code: 1, timedOut: false };
      }
      return {
        stdout: 'CLI Version         2026.04.09-f2b0fcd\nUser Email          cursor@example.com\n',
        stderr: '',
        code: 0,
        timedOut: false,
      };
    },
  });
  const snapshot = await adapter.probe(new AbortController().signal);
  assert.equal(snapshot.readiness, 'ready');
  assert.equal(snapshot.executable?.version, '2026.04.09-f2b0fcd');
});

test('create handshake is initialize, authenticate, session/new with DROIDEX client info', async () => {
  let connection: AcpConnection | undefined;
  const adapter = new CursorProviderAdapter({
    spawnAcp: fakeCursorAgentSpawn(),
    connectAcp: async (options) => {
      connection = await AcpConnection.connect(options);
      return connection;
    },
  });
  const recorded = recordingSink();
  const session = await adapter.create(createInput(recorded.sink));
  try {
    assert.ok(connection);
    const methods = await connection.request('x/received-methods');
    assert.ok(isPlainObject(methods) && Array.isArray(methods.receivedMethods));
    assert.deepEqual(methods.receivedMethods.slice(0, 3), [
      'initialize',
      'authenticate',
      'session/new',
    ]);
    const handshake = await connection.request('x/handshake');
    assert.ok(isPlainObject(handshake) && isPlainObject(handshake.initializeParams));
    assert.deepEqual(handshake.initializeParams.clientInfo, CURSOR_ACP_CLIENT_INFO);
    assert.equal(
      isPlainObject(handshake.initializeParams.clientCapabilities) &&
        isPlainObject(handshake.initializeParams.clientCapabilities._meta) &&
        handshake.initializeParams.clientCapabilities._meta.parameterizedModelPicker,
      true,
    );
    const auth = connection;
    void auth;
    void CURSOR_AUTH_METHOD_ID;
    session.activate();
    assert.equal(
      recorded.events.some((event) => event.type === 'binding.updated'),
      true,
    );
  } finally {
    await session.close(ShutdownDeadline.fromDurationMs(5_000));
  }
});

test('resume uses session/load and suppresses replayed transcript', async () => {
  let connection: AcpConnection | undefined;
  const adapter = new CursorProviderAdapter({
    spawnAcp: fakeCursorAgentSpawn({ [CURSOR_FAKE_REPLAY_ENV]: '1' }),
    connectAcp: async (options) => {
      connection = await AcpConnection.connect(options);
      return connection;
    },
  });
  const recorded = recordingSink();
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
    session.activate();
    assert.equal(
      recorded.events.some(
        (event) => event.type === 'transcript' && event.event.text === 'replayed assistant text',
      ),
      false,
    );
    assert.equal(
      recorded.events.some(
        (event) => event.type === 'transcript' && event.event.text === 'live after replay',
      ),
      true,
    );
  } finally {
    await session.close(ShutdownDeadline.fromDurationMs(5_000));
  }
});

test('startTurn resolves on acceptance; assistant text streams; other updates are ignored', async () => {
  const adapter = adapterWithPeer({ [CURSOR_FAKE_EXTRA_UPDATES_ENV]: '1' });
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
    const texts = recorded.events
      .filter((event) => event.type === 'transcript')
      .map((event) => (event.type === 'transcript' ? event.event.text : undefined));
    assert.deepEqual(texts, ['hello from cursor']);
    assert.equal(texts.includes('secret thought'), false);
    const liveEvent = recorded.events.find((event) => event.type === 'transcript');
    assert.ok(liveEvent);
    assertEventAdmissibleForSession(liveEvent, {
      target: { kind: 'session', appSessionId: 'app-1' },
      providerDriverKind: 'cursor',
      providerInstanceId: 'cursor',
      runtimeGeneration: 3,
      settledTurnIds: new Set(),
    });
  } finally {
    await session.close(ShutdownDeadline.fromDurationMs(5_000));
  }
});

test('session/set_model receives the stripped base id', async () => {
  let connection: AcpConnection | undefined;
  const adapter = new CursorProviderAdapter({
    spawnAcp: fakeCursorAgentSpawn(),
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
      configuration: createInput(recorded.sink).configuration,
    });
    await waitForTurnSettlement(recorded.events, 'turn-model');
    assert.ok(connection);
    const handshake = await connection.request('x/handshake');
    assert.ok(isPlainObject(handshake) && Array.isArray(handshake.setModelCalls));
    const first = handshake.setModelCalls[0];
    assert.ok(isPlainObject(first));
    assert.equal(first.modelId, 'gpt-5.4-medium-fast');
  } finally {
    await session.close(ShutdownDeadline.fromDurationMs(5_000));
  }
});

test('unsupported advertised-mode mismatch throws rather than silently falling back', async () => {
  const adapter = adapterWithPeer({ [CURSOR_FAKE_MODES_ENV]: 'code' });
  const recorded = recordingSink();
  const session = await adapter.create(createInput(recorded.sink, { interactionMode: 'spec' }));
  try {
    session.activate();
    await assert.rejects(
      () =>
        session.startTurn({
          turnId: 'turn-mode',
          prompt: { text: 'hi', skills: [], files: [], browserRefs: [] },
          configuration: createInput(recorded.sink, { interactionMode: 'spec' }).configuration,
        }),
      (error: unknown) =>
        error instanceof ProviderContractError && error.code === 'unsupported_capability',
    );
  } finally {
    await session.close(ShutdownDeadline.fromDurationMs(5_000));
  }
});

test('a prompt rejecting after acceptance still yields exactly one settlement', async () => {
  const peer = new ControllableAcp();
  const adapter = adapterWithControllable(peer);
  const recorded = recordingSink();
  const session = await adapter.create(createInput(recorded.sink));
  session.activate();
  const returned = await session.startTurn({
    turnId: 'turn-reject',
    prompt: { text: 'hi', skills: [], files: [], browserRefs: [] },
    configuration: createInput(recorded.sink).configuration,
  });
  assertStartTurnDidNotSettle(returned, recorded.events, 'turn-reject');
  peer.failPrompt(new Error('boom'));
  await waitForTurnSettlement(recorded.events, 'turn-reject');
  assertExactlyOneTurnSettlement(recorded.events, 'turn-reject');
  const settled = recorded.events.find((event) => event.type === 'turn.settled');
  assert.equal(settled?.type, 'turn.settled');
  if (settled?.type === 'turn.settled') {
    assert.equal(settled.settlement.status, 'failed');
    if (settled.settlement.status === 'failed') {
      assert.equal(settled.settlement.error.message.includes('boom'), false);
      assert.equal(settled.settlement.error.providerInstanceId, 'cursor');
    }
  }
  await session.close(ShutdownDeadline.fromDurationMs(0));
});

test('a completion for a stale generation settles nothing extra', async () => {
  const peer = new ControllableAcp();
  const adapter = adapterWithControllable(peer);
  const recorded = recordingSink();
  const session = await adapter.create(createInput(recorded.sink));
  session.activate();
  await session.startTurn({
    turnId: 'turn-stale',
    prompt: { text: 'hi', skills: [], files: [], browserRefs: [] },
    configuration: createInput(recorded.sink).configuration,
  });
  await session.close(ShutdownDeadline.fromDurationMs(0));
  assertExactlyOneTurnSettlement(recorded.events, 'turn-stale', { status: 'cancelled' });
  peer.completePrompt({ stopReason: 'end_turn' });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assertExactlyOneTurnSettlement(recorded.events, 'turn-stale', { status: 'cancelled' });
});

test('interrupt sends session/cancel and settles the turn once', async () => {
  const peer = new ControllableAcp();
  const adapter = adapterWithControllable(peer);
  const recorded = recordingSink();
  const session = await adapter.create(createInput(recorded.sink));
  session.activate();
  await session.startTurn({
    turnId: 'turn-int',
    prompt: { text: 'hi', skills: [], files: [], browserRefs: [] },
    configuration: createInput(recorded.sink).configuration,
  });
  await session.interrupt({ turnId: 'turn-int', runtimeGeneration: 3 });
  assert.equal(peer.cancels, 1);
  assertExactlyOneTurnSettlement(recorded.events, 'turn-int', { status: 'interrupted' });
  peer.completePrompt({ stopReason: 'cancelled' });
  await new Promise((resolve) => setImmediate(resolve));
  assertExactlyOneTurnSettlement(recorded.events, 'turn-int', { status: 'interrupted' });
  await session.close(ShutdownDeadline.fromDurationMs(0));
});

test('interrupt with a mismatched generation is rejected', async () => {
  const peer = new ControllableAcp();
  const adapter = adapterWithControllable(peer);
  const recorded = recordingSink();
  const session = await adapter.create(createInput(recorded.sink));
  session.activate();
  await session.startTurn({
    turnId: 'turn-gen',
    prompt: { text: 'hi', skills: [], files: [], browserRefs: [] },
    configuration: createInput(recorded.sink).configuration,
  });
  await assert.rejects(
    () => session.interrupt({ turnId: 'turn-gen', runtimeGeneration: 99 }),
    (error: unknown) =>
      error instanceof ProviderContractError && error.code === 'stale_provider_operation',
  );
  assert.equal(peer.cancels, 0);
  peer.completePrompt({ stopReason: 'end_turn' });
  await waitForTurnSettlement(recorded.events, 'turn-gen');
  assertExactlyOneTurnSettlement(recorded.events, 'turn-gen', { status: 'completed' });
  await session.close(ShutdownDeadline.fromDurationMs(0));
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
  const adapter = new CursorProviderAdapter({
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

test('empty model catalog over ACP falls back to default', async () => {
  const adapter = adapterWithPeer({ [CURSOR_FAKE_MODELS_ENV]: '' });
  const snapshot = await adapter.probe(new AbortController().signal);
  assert.equal(snapshot.models.length, 1);
  assert.equal(snapshot.models[0]?.id, 'default');
  assert.equal(snapshot.models[0]?.isDefault, true);
});

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
