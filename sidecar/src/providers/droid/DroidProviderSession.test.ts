import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FakeFactoryRuntime,
  FakeFactorySession,
  assistantTextDelta,
  type RecordedCall,
} from '../../testing/fakeFactoryRuntime.js';
import {
  PRE_ACTIVATION_MAX_BYTES,
  PRE_ACTIVATION_MAX_EVENTS,
  ProviderContractError,
  START_TURN_ACCEPTANCE_ONLY,
  type ProviderSessionCreateInput,
} from '../providerTypes.js';
import { serializedProviderEventBytes, type ProviderRuntimeEvent } from '../providerEvents.js';
import { ShutdownDeadline } from '../shutdownDeadline.js';
import {
  cancelingInteractionSink,
  createTestClock,
  createTestIdSource,
} from '../testing/FakeProviderAdapter.js';
import {
  assertActivateIsOneShot,
  assertExactlyOneTurnSettlement,
  assertPreActivationOverflow,
  assertSameShutdownDeadline,
  assertStartTurnDidNotSettle,
} from '../testing/ProviderContractHarness.js';
import { DroidProviderAdapter } from './DroidProviderAdapter.js';
import { encodeDroidResumeState } from './DroidModeMapping.js';

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
  overrides: { expectedGeneration?: number } = {},
): ProviderSessionCreateInput {
  return {
    target: { kind: 'session', appSessionId: 'app-1' },
    configuration: {
      providerSelection: {
        providerInstanceId: 'droid',
        modelId: 'gpt-5.4',
        options: {},
      },
      interactionMode: 'auto',
      autonomy: 'medium',
    },
    expectedGeneration: overrides.expectedGeneration ?? 3,
    cwd: '/tmp/project',
    eventSink: sink,
    interactionSink: cancelingInteractionSink(),
    ids: createTestIdSource('droid'),
    clock: createTestClock(),
  };
}

async function openSession(
  factory: FakeFactorySession,
  recorded = recordingSink(),
): Promise<{
  runtime: FakeFactoryRuntime;
  adapter: DroidProviderAdapter;
  session: Awaited<ReturnType<DroidProviderAdapter['create']>>;
  recorded: ReturnType<typeof recordingSink>;
  factory: FakeFactorySession;
}> {
  const runtime = new FakeFactoryRuntime([]);
  runtime.createQueue.push(factory);
  const adapter = new DroidProviderAdapter({ runtime });
  const session = await adapter.create(createInput(recorded.sink));
  return { runtime, adapter, session, recorded, factory };
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

function compactionNote(): Record<string, unknown> {
  return {
    type: 'droid_working_state_changed',
    newState: 'compacting_conversation',
  };
}

function textDeltaNote(text: string): Record<string, unknown> {
  return {
    type: 'assistant_text_delta',
    messageId: 'message-1',
    blockIndex: 0,
    textDelta: text,
  };
}

test('early notifications stay buffered until one-shot activate flushes them in order', async () => {
  const factory = new FakeFactorySession('provider-1', {}, []);
  const { session, recorded } = await openSession(factory);
  factory.emitNotification(textDeltaNote('one'));
  factory.emitNotification(textDeltaNote('two'));
  factory.emitNotification(textDeltaNote('three'));
  assert.equal(recorded.events.filter((event) => event.type === 'transcript').length, 0);
  assert.equal(session.bufferedEventCount > 1, true);
  assertActivateIsOneShot(session);
  const texts = recorded.events
    .filter((event) => event.type === 'transcript')
    .map((event) => (event.type === 'transcript' ? event.event.text : undefined));
  assert.deepEqual(texts, ['one', 'two', 'three']);
  await session.close(ShutdownDeadline.fromDurationMs(0));
});

test('binding.updated for native replacement includes providerSessionId and resume state', async () => {
  const factory = new FakeFactorySession('native-a', {}, []);
  const { session, recorded } = await openSession(factory);
  session.activate();
  const binding = recorded.events.find((event) => event.type === 'binding.updated');
  assert.equal(binding?.type, 'binding.updated');
  if (binding?.type === 'binding.updated') {
    assert.deepEqual(binding.binding, {
      providerSessionId: session.providerSessionId,
      resumeState: encodeDroidResumeState('native-a'),
    });
  }
  await session.close(ShutdownDeadline.fromDurationMs(0));
});

test('replaceNativeSession resume-state-only omits providerSessionId', async () => {
  const factory = new FakeFactorySession('native-a', {}, []);
  const { session, recorded } = await openSession(factory);
  session.activate();
  const replacement = new FakeFactorySession('native-b', {}, []);
  session.droid.replaceNativeSession(replacement, 'resume_state');
  const bindings = recorded.events.filter((event) => event.type === 'binding.updated');
  const latest = bindings.at(-1);
  assert.equal(latest?.type, 'binding.updated');
  if (latest?.type === 'binding.updated') {
    assert.deepEqual(latest.binding, {
      resumeState: encodeDroidResumeState('native-b'),
    });
    assert.equal('providerSessionId' in latest.binding, false);
  }
  const nativeReplacement = new FakeFactorySession('native-c', {}, []);
  session.droid.replaceNativeSession(nativeReplacement, 'native_replacement');
  const after = recorded.events.filter((event) => event.type === 'binding.updated').at(-1);
  assert.equal(after?.type, 'binding.updated');
  if (after?.type === 'binding.updated') {
    assert.deepEqual(after.binding, {
      providerSessionId: session.providerSessionId,
      resumeState: encodeDroidResumeState('native-c'),
    });
  }
  await session.close(ShutdownDeadline.fromDurationMs(0));
});

test('interrupt targets the captured turn and generation and dedupes settlement', async () => {
  const factory = new FakeFactorySession('provider-1', {}, []);
  const gate = factory.deferNextStream();
  const { session, recorded } = await openSession(factory);
  const input = createInput(recorded.sink);
  session.activate();
  await session.startTurn({
    turnId: 'turn-int',
    prompt: { text: 'hi', skills: [], files: [], browserRefs: [] },
    configuration: input.configuration,
  });
  await assert.rejects(
    () => session.interrupt({ turnId: 'turn-int', runtimeGeneration: 99 }),
    (error: unknown) =>
      error instanceof ProviderContractError && error.code === 'stale_provider_operation',
  );
  await session.interrupt({ turnId: 'turn-int', runtimeGeneration: session.runtimeGeneration });
  assertExactlyOneTurnSettlement(recorded.events, 'turn-int', { status: 'interrupted' });
  gate.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assertExactlyOneTurnSettlement(recorded.events, 'turn-int', { status: 'interrupted' });
  await session.close(ShutdownDeadline.fromDurationMs(0));
});

test('steer throws unsupported_capability and does not interrupt', async () => {
  const calls: RecordedCall[] = [];
  const factory = new FakeFactorySession('provider-1', {}, calls);
  factory.deferNextStream();
  const { session, recorded } = await openSession(factory);
  const input = createInput(recorded.sink);
  session.activate();
  const returned = await session.startTurn({
    turnId: 'turn-steer',
    prompt: { text: 'hi', skills: [], files: [], browserRefs: [] },
    configuration: input.configuration,
  });
  assertStartTurnDidNotSettle(returned, recorded.events, 'turn-steer');
  await assert.rejects(
    () =>
      session.steer({
        turnId: 'turn-steer',
        prompt: { text: 'nudge', skills: [], files: [], browserRefs: [] },
      }),
    (error: unknown) =>
      error instanceof ProviderContractError &&
      error.code === 'unsupported_capability' &&
      error.providerInstanceId === 'droid' &&
      error.message.includes('steer'),
  );
  assert.equal(
    calls.some((call) => call.method === 'interrupt'),
    false,
  );
  assert.equal(
    recorded.events.some((event) => event.type === 'turn.settled'),
    false,
  );
  await session.close(ShutdownDeadline.fromDurationMs(0));
});

test('close cancels an in-flight turn, is idempotent, and keeps the same deadline', async () => {
  const factory = new FakeFactorySession('provider-1', {}, []);
  factory.deferNextStream();
  const { session, recorded, adapter } = await openSession(factory);
  const input = createInput(recorded.sink);
  session.activate();
  await session.startTurn({
    turnId: 'turn-close',
    prompt: { text: 'hi', skills: [], files: [], browserRefs: [] },
    configuration: input.configuration,
  });
  const deadline = ShutdownDeadline.fromDurationMs(0);
  const started = performance.now();
  await session.close(deadline);
  await session.close(deadline);
  assert.ok(performance.now() - started < 2_000);
  assertSameShutdownDeadline(session.receivedCloseDeadline, deadline);
  assertExactlyOneTurnSettlement(recorded.events, 'turn-close', { status: 'cancelled' });
  await adapter.close(deadline);
  assertSameShutdownDeadline(adapter.receivedCloseDeadline, deadline);
});

test('pending native callbacks settle when the session closes', async () => {
  const factory = new FakeFactorySession('provider-1', {}, []);
  const { session } = await openSession(factory);
  session.activate();
  const pending = session.runNativeCallback(() => new Promise(() => undefined));
  await session.close(ShutdownDeadline.fromDurationMs(0));
  await assert.rejects(
    pending,
    (error: unknown) =>
      error instanceof ProviderContractError && error.code === 'interaction_cancelled',
  );
  assert.equal(session.nativeCallbacksSettled, true);
});

test('pre-activation accepts 512 events and overflows on the 513th', async () => {
  const factory = new FakeFactorySession('provider-1', {}, []);
  const { session, recorded } = await openSession(factory);
  for (let index = 0; index < PRE_ACTIVATION_MAX_EVENTS - 1; index += 1) {
    factory.emitNotification(compactionNote());
  }
  assert.equal(session.bufferedEventCount, PRE_ACTIVATION_MAX_EVENTS);
  assert.equal(session.failedOpen, false);
  session.activate();
  assert.equal(
    recorded.events.filter((event) => event.type === 'session.effect').length,
    PRE_ACTIVATION_MAX_EVENTS - 1,
  );
  await session.close(ShutdownDeadline.fromDurationMs(0));

  const overflowing = new FakeFactorySession('overflow-1', {}, []);
  const second = recordingSink();
  const opened = await openSession(overflowing, second);
  for (let index = 0; index < PRE_ACTIVATION_MAX_EVENTS - 1; index += 1) {
    overflowing.emitNotification(compactionNote());
  }
  overflowing.emitNotification(compactionNote());
  assertPreActivationOverflow({
    emittedToSink: second.events.length,
    discarded: opened.session.discardedCount === PRE_ACTIVATION_MAX_EVENTS,
    closed: opened.session.isClosed,
    laterEventsAccepted: opened.session.laterEventsAccepted,
    nativeCallbacksSettled: opened.session.nativeCallbacksSettled,
  });
  overflowing.emitNotification(compactionNote());
  assert.equal(opened.session.laterEventsAccepted, false);
});

test('pre-activation byte bound uses UTF-8 bytes and overflows on a multibyte payload', async () => {
  const factory = new FakeFactorySession('provider-1', {}, []);
  const { session, recorded } = await openSession(factory);
  const bindingEvent: ProviderRuntimeEvent = {
    eventId: 'droid-evt-1',
    target: { kind: 'session', appSessionId: 'app-1' },
    providerDriverKind: 'droid',
    providerInstanceId: 'droid',
    runtimeGeneration: 3,
    createdAt: 1_000,
    type: 'binding.updated',
    binding: {
      providerSessionId: session.providerSessionId,
      resumeState: encodeDroidResumeState('provider-1'),
    },
  };
  const remaining = PRE_ACTIVATION_MAX_BYTES - serializedProviderEventBytes(bindingEvent);
  const makeTranscript = (text: string): ProviderRuntimeEvent => ({
    eventId: 'droid-evt-2',
    target: { kind: 'session', appSessionId: 'app-1' },
    providerDriverKind: 'droid',
    providerInstanceId: 'droid',
    runtimeGeneration: 3,
    createdAt: 1_000,
    type: 'transcript',
    event: { role: 'primary', kind: 'text', text },
  });
  const fillChar = 'é';
  let text = fillChar;
  let candidate = makeTranscript(text);
  let bytes = serializedProviderEventBytes(candidate);
  while (bytes < remaining + 1) {
    const gap = remaining + 1 - bytes;
    const fillBytes = Buffer.byteLength(fillChar, 'utf8');
    text += fillChar.repeat(Math.max(1, Math.floor(gap / fillBytes)));
    candidate = makeTranscript(text);
    bytes = serializedProviderEventBytes(candidate);
  }
  while (bytes > remaining + 1 && text.length > 0) {
    text = text.slice(0, -fillChar.length);
    candidate = makeTranscript(text);
    bytes = serializedProviderEventBytes(candidate);
    if (bytes < remaining + 1) {
      while (serializedProviderEventBytes(candidate) < remaining + 1) {
        text += 'a';
        candidate = makeTranscript(text);
      }
      break;
    }
  }
  assert.ok(JSON.stringify(candidate).length <= remaining + 1);
  assert.equal(serializedProviderEventBytes(candidate), remaining + 1);
  const pending = session.runNativeCallback(() => new Promise(() => undefined));
  factory.emitNotification(textDeltaNote(text));
  assert.equal(session.failedOpen, true);
  await assert.rejects(pending);
  assertPreActivationOverflow({
    emittedToSink: recorded.events.length,
    discarded: session.discardedCount === 1,
    closed: session.isClosed,
    laterEventsAccepted: session.laterEventsAccepted,
    nativeCallbacksSettled: session.nativeCallbacksSettled,
  });
});

test('Droid extension forwards Factory-only operations', async () => {
  const factory = new FakeFactorySession('provider-1', {}, []);
  const { session } = await openSession(factory);
  session.activate();
  const compacted = await session.droid.compactSession({});
  assert.equal(compacted.newSessionId, 'provider-1');
  const stats = await session.droid.getContextStats();
  assert.equal(typeof stats.used, 'number');
  await session.droid.updateSettings({ modelId: 'other' });
  assert.equal(factory.settings.at(-1)?.modelId, 'other');
  await session.droid.listMcpServers();
  const breakdown = await session.droid.readContextBreakdown();
  assert.equal(breakdown, undefined);
  await session.close(ShutdownDeadline.fromDurationMs(0));
});

test('stream thinking and usage normalize without a second terminal settlement', async () => {
  const factory = new FakeFactorySession('provider-1', {}, []);
  factory.queueStreamEvents([
    { type: 'thinking_text_delta', messageId: 'm1', blockIndex: 0, text: 'hmm' },
    assistantTextDelta('answer'),
    {
      type: 'token_usage_update',
      inclusiveTokenUsage: {
        inputTokens: 10,
        outputTokens: 4,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
      lastCallTokenUsage: {
        inputTokens: 10,
        outputTokens: 4,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
    } as never,
  ]);
  const { session, recorded } = await openSession(factory);
  const input = createInput(recorded.sink);
  session.activate();
  await session.startTurn({
    turnId: 'turn-stream',
    prompt: { text: 'hi', skills: [], files: [], browserRefs: [] },
    configuration: input.configuration,
  });
  await waitForTurnSettlement(recorded.events, 'turn-stream');
  assertExactlyOneTurnSettlement(recorded.events, 'turn-stream', { status: 'completed' });
  assert.equal(
    recorded.events.some((event) => event.type === 'transcript' && event.event.kind === 'thinking'),
    true,
  );
  assert.equal(
    recorded.events.some((event) => event.type === 'usage' && event.inputTokens === 10),
    true,
  );
  await session.close(ShutdownDeadline.fromDurationMs(0));
});
