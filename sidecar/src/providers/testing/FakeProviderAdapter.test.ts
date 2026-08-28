import assert from 'node:assert/strict';
import test from 'node:test';

import { serializedProviderEventBytes, type ProviderRuntimeEvent } from '../providerEvents.js';
import {
  PRE_ACTIVATION_MAX_BYTES,
  PRE_ACTIVATION_MAX_EVENTS,
  ProviderContractError,
  START_TURN_ACCEPTANCE_ONLY,
  type ProviderAdapter,
  type ProviderSessionCreateInput,
  type ProviderTurnSettlement,
} from '../providerTypes.js';
import { ShutdownDeadline } from '../shutdownDeadline.js';
import {
  FakeProviderAdapter,
  cancelingInteractionSink,
  completeFakeCapabilities,
  createTestClock,
  createTestIdSource,
} from './FakeProviderAdapter.js';
import { FakeProviderSession } from './FakeProviderSession.js';
import {
  assertActivateIsOneShot,
  assertCompleteCapabilities,
  assertExactlyOneTurnSettlement,
  assertPreActivationOverflow,
  assertSameShutdownDeadline,
  assertStartTurnDidNotSettle,
  bindProviderAdapter,
} from './ProviderContractHarness.js';

const _adapterContract: ProviderAdapter = new FakeProviderAdapter();
void _adapterContract;
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
  adapter: FakeProviderAdapter,
  sink: (event: ProviderRuntimeEvent) => void,
  overrides: Partial<ProviderSessionCreateInput> = {},
): ProviderSessionCreateInput {
  return {
    target: { kind: 'session', appSessionId: 'app-1' },
    configuration: {
      providerSelection: {
        providerInstanceId: adapter.definition.providerInstanceId,
        modelId: 'model-a',
        options: {},
      },
      interactionMode: 'auto',
      autonomy: 'medium',
    },
    expectedGeneration: 3,
    cwd: '/tmp/workspace',
    eventSink: sink,
    interactionSink: cancelingInteractionSink(),
    ids: createTestIdSource(),
    clock: createTestClock(),
    ...overrides,
  };
}

async function openPending(options: { preActivationEventCount?: number } = {}): Promise<{
  adapter: FakeProviderAdapter;
  session: FakeProviderSession;
  events: ProviderRuntimeEvent[];
}> {
  const adapter = bindProviderAdapter(new FakeProviderAdapter());
  adapter.preActivationEventCount = options.preActivationEventCount ?? 0;
  const recorded = recordingSink();
  const session = await adapter.create(createInput(adapter, recorded.sink));
  return { adapter, session, events: recorded.events };
}

function warningSizedTo(
  session: FakeProviderSession,
  targetBytes: number,
  fill: string,
): ProviderRuntimeEvent {
  const eventId = 'size-evt';
  let message = fill;
  let event = session.buildWarning(message, { eventId });
  let bytes = serializedProviderEventBytes(event);
  while (bytes < targetBytes) {
    const remaining = targetBytes - bytes;
    const fillBytes = Buffer.byteLength(fill, 'utf8');
    const chunk = Math.max(1, Math.floor(remaining / fillBytes));
    message += fill.repeat(chunk);
    event = session.buildWarning(message, { eventId });
    bytes = serializedProviderEventBytes(event);
  }
  while (bytes > targetBytes && message.length > 0) {
    message = message.slice(0, -fill.length);
    event = session.buildWarning(message, { eventId });
    bytes = serializedProviderEventBytes(event);
    if (bytes < targetBytes) {
      while (serializedProviderEventBytes(event) < targetBytes) {
        message += 'a';
        event = session.buildWarning(message, { eventId });
      }
      break;
    }
  }
  event = session.buildWarning(message, { eventId });
  assert.equal(serializedProviderEventBytes(event), targetBytes);
  return event;
}

test('FakeProviderAdapter implements ProviderAdapter and publishes exhaustive capabilities', () => {
  const adapter = bindProviderAdapter(new FakeProviderAdapter());
  assertCompleteCapabilities(adapter.snapshot.capabilities);
  assert.equal(completeFakeCapabilities().usageReporting, true);
  assert.equal(completeFakeCapabilities().reasoningStream, true);
});

test('create rejects a selection that does not match the adapter instance', async () => {
  const adapter = new FakeProviderAdapter();
  const recorded = recordingSink();
  const input = createInput(adapter, recorded.sink, {
    configuration: {
      providerSelection: { providerInstanceId: 'codex', modelId: 'model-a', options: {} },
      interactionMode: 'auto',
      autonomy: 'medium',
    },
  });
  await assert.rejects(
    () => adapter.create(input),
    (error: unknown) =>
      error instanceof ProviderContractError && error.code === 'invalid_provider_configuration',
  );
});

test('events emitted before create resolves stay buffered until activate', async () => {
  const adapter = bindProviderAdapter(new FakeProviderAdapter());
  adapter.preActivationEventCount = 2;
  adapter.gates.block('create');
  const recorded = recordingSink();
  const pending = adapter.create(createInput(adapter, recorded.sink));
  await adapter.gates.waitUntilBlocked('create');
  const inFlight = adapter.sessions[0];
  assert.ok(inFlight);
  assert.equal(recorded.events.length, 0);
  assert.equal(inFlight.bufferedEventCount, 2);
  adapter.gates.release('create');
  const session = await pending;
  assert.equal(recorded.events.length, 0);
  session.activate();
  assert.equal(recorded.events.length, 2);
  assert.deepEqual(
    recorded.events.map((event) => event.type),
    ['warning', 'warning'],
  );
});

test('activate is one-shot and flushes the pre-activation buffer in order', async () => {
  const { session, events } = await openPending({ preActivationEventCount: 3 });
  assert.equal(events.length, 0);
  assertActivateIsOneShot(session);
  assert.equal(events.length, 3);
  assert.deepEqual(
    events.map((event) => (event.type === 'warning' ? event.message : event.type)),
    ['preactivation-1', 'preactivation-2', 'preactivation-3'],
  );
});

test('pre-activation accepts 511 and 512 events and fails open on 513', async () => {
  const accepted511 = await openPending({ preActivationEventCount: 511 });
  accepted511.session.activate();
  assert.equal(accepted511.events.length, 511);

  const accepted512 = await openPending({ preActivationEventCount: 512 });
  assert.equal(accepted512.session.bufferedEventCount, PRE_ACTIVATION_MAX_EVENTS);
  accepted512.session.activate();
  assert.equal(accepted512.events.length, 512);

  const adapter = new FakeProviderAdapter();
  adapter.preActivationEventCount = 513;
  const recorded = recordingSink();
  await assert.rejects(
    () => adapter.create(createInput(adapter, recorded.sink)),
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

test('pre-activation byte bound uses UTF-8 bytes and overflows on a multibyte payload', async () => {
  const exact = await openPending();
  const atLimit = warningSizedTo(exact.session, PRE_ACTIVATION_MAX_BYTES, 'a');
  assert.equal(JSON.stringify(atLimit).length, PRE_ACTIVATION_MAX_BYTES);
  assert.equal(exact.session.tryEmit(atLimit), true);
  exact.session.activate();
  assert.equal(exact.events.length, 1);

  const overflow = await openPending();
  const overLimit = warningSizedTo(overflow.session, PRE_ACTIVATION_MAX_BYTES + 1, 'é');
  assert.ok(JSON.stringify(overLimit).length <= PRE_ACTIVATION_MAX_BYTES);
  assert.equal(serializedProviderEventBytes(overLimit), PRE_ACTIVATION_MAX_BYTES + 1);
  const pendingCallback = overflow.session.registerNativeCallback();
  assert.equal(overflow.session.tryEmit(overLimit), false);
  await pendingCallback;
  assertPreActivationOverflow({
    emittedToSink: overflow.events.length,
    discarded: overflow.session.discardedCount === 0,
    closed: overflow.session.isClosed,
    laterEventsAccepted: overflow.session.laterEventsAccepted,
    nativeCallbacksSettled: overflow.session.nativeCallbacksSettled,
  });
  assert.equal(overflow.session.tryEmit(overflow.session.buildWarning('after-overflow')), false);
});

test('close before activate discards the buffer, settles callbacks, and is idempotent', async () => {
  const { adapter, session, events } = await openPending({ preActivationEventCount: 4 });
  const pendingCallback = session.registerNativeCallback();
  const deadline = ShutdownDeadline.fromDurationMs(5_000, 10_000);
  await session.close(deadline);
  await pendingCallback;
  assert.equal(events.length, 0);
  assert.equal(session.discardedCount, 4);
  assert.equal(session.nativeCallbacksSettled, true);
  assert.equal(session.cleanedUp, true);
  assertSameShutdownDeadline(session.receivedCloseDeadline, deadline);
  await session.close(deadline);
  assert.throws(() => session.activate());
  await adapter.close(deadline);
  assertSameShutdownDeadline(adapter.receivedCloseDeadline, deadline);
  assert.deepEqual(
    adapter.calls.map((call) => call.op),
    ['create', 'session.close', 'session.close', 'activate', 'adapter.close', 'session.close'],
  );
});

test('startTurn resolves without settling; only turn.settled is terminal', async () => {
  const { adapter, session, events } = await openPending();
  session.activate();
  const returned = await session.startTurn({
    turnId: 'turn-1',
    prompt: session.prompt('hello'),
    configuration: createInput(adapter, () => undefined).configuration,
  });
  assertStartTurnDidNotSettle(returned, events, 'turn-1');
  assert.equal(session.settlements.length, 0);
  assert.equal(session.nativeTurnIds.get('turn-1'), 'native-turn-turn-1');
  assert.equal(session.nativeSessionId, `native-${session.providerSessionId}`);
  const settlement: ProviderTurnSettlement = { status: 'completed' };
  assert.equal(session.emitTurnSettled('turn-1', settlement), true);
  assertExactlyOneTurnSettlement(events, 'turn-1', settlement);
  assert.equal(session.emitTurnSettled('turn-1', { status: 'cancelled' }), false);
});

test('stale generation, wrong instance, wrong session, and post-settlement events are rejected', async () => {
  const { session, events } = await openPending();
  session.activate();
  assert.equal(session.tryEmit(session.buildWarning('stale', { runtimeGeneration: 1 })), false);
  assert.equal(
    session.tryEmit(session.buildWarning('wrong-instance', { providerInstanceId: 'codex' })),
    false,
  );
  assert.equal(
    session.tryEmit(
      session.buildWarning('wrong-session', { target: { kind: 'session', appSessionId: 'app-2' } }),
    ),
    false,
  );
  assert.equal(session.emitTurnSettled('turn-2', { status: 'interrupted' }), true);
  assert.equal(session.tryEmit(session.buildWarning('after', { turnId: 'turn-2' })), false);
  assert.equal(events.length, 1);
  assert.equal(session.rejectedEvents.length, 4);
});

test('individual awaits can be blocked or failed on demand', async () => {
  const { adapter, session } = await openPending();
  session.activate();
  const turn = {
    turnId: 'turn-block',
    prompt: session.prompt('block'),
    configuration: createInput(adapter, () => undefined).configuration,
  };
  adapter.gates.block('startTurn');
  const pending = session.startTurn(turn);
  await adapter.gates.waitUntilBlocked('startTurn');
  assert.equal(session.acceptedTurns.length, 0);
  adapter.gates.release('startTurn');
  await pending;
  assert.deepEqual(session.acceptedTurns, ['turn-block']);
  adapter.gates.fail('steer', new Error('steer-failed'));
  await assert.rejects(
    () => session.steer({ turnId: 'turn-block', prompt: session.prompt('nudge') }),
    {
      message: 'steer-failed',
    },
  );
});

test('resume exposes opaque resume state and records calls in order', async () => {
  const adapter = new FakeProviderAdapter();
  adapter.preActivationEventCount = 0;
  const recorded = recordingSink();
  const resumeState = { cursor: 'opaque-native' };
  const session = await adapter.resume({
    ...createInput(adapter, recorded.sink),
    resumeState,
  });
  assert.equal(session.initialResumeState, resumeState);
  assert.equal(session.resumeState, resumeState);
  session.activate();
  await session.startTurn({
    turnId: 'turn-resume',
    prompt: session.prompt('continue'),
    configuration: createInput(adapter, recorded.sink).configuration,
  });
  await session.steer({ turnId: 'turn-resume', prompt: session.prompt('nudge') });
  await session.interrupt({ turnId: 'turn-resume', runtimeGeneration: 3 });
  const deadline = ShutdownDeadline.fromDurationMs(1_000, 50);
  await session.close(deadline);
  assert.deepEqual(
    adapter.calls.map((call) => call.op),
    ['resume', 'activate', 'startTurn', 'steer', 'interrupt', 'session.close'],
  );
});
