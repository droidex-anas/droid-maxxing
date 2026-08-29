import assert from 'node:assert/strict';
import test from 'node:test';

import { redactSensitiveText, sanitizeForLog } from '../sensitiveLogRedaction.js';
import {
  ProviderContractError,
  type ProviderAdapter,
  type ProviderDefinition,
  type ProviderSessionCreateInput,
} from './providerTypes.js';
import { ShutdownDeadline } from './shutdownDeadline.js';
import {
  FakeProviderAdapter,
  cancelingInteractionSink,
  completeFakeCapabilities,
  createTestClock,
  createTestIdSource,
} from './testing/FakeProviderAdapter.js';
import {
  PROVIDER_DEFINITION_ORDER,
  ProviderRegistry,
  builtInProviderDefinition,
  createDefaultProviderRegistry,
  type ProviderRegistration,
} from './ProviderRegistry.js';
import {
  UNAVAILABLE_PROVIDER_CAPABILITIES,
  createUnavailableProviderAdapter,
} from './unavailableProvider.js';

const SENTINEL_TOKEN = 'sk-ant-api03-SENTINEL_TOKEN_VALUE_9f3a2b1c';
const SENTINEL_API_KEY = 'fac_live_SENTINEL_API_KEY_VALUE_7e8d9c';
const SENTINEL_CREDENTIAL_HOME = '/Users/ada/.claude/credentials.json';
const SENTINEL_ACCOUNT_PAYLOAD =
  '{"accountId":"acct_SENTINEL_RAW_ACCOUNT","email":"ada@factory.example"}';
const SENTINELS = [
  SENTINEL_TOKEN,
  SENTINEL_API_KEY,
  SENTINEL_CREDENTIAL_HOME,
  SENTINEL_ACCOUNT_PAYLOAD,
] as const;

function definition(
  providerInstanceId: ProviderDefinition['providerInstanceId'],
): ProviderDefinition {
  return builtInProviderDefinition(providerInstanceId);
}

function fakeAdapter(
  providerInstanceId: ProviderDefinition['providerInstanceId'],
): FakeProviderAdapter {
  return new FakeProviderAdapter(definition(providerInstanceId));
}

function registration(
  adapter: FakeProviderAdapter,
  createAdapter: () => ProviderAdapter = () => adapter,
): ProviderRegistration {
  return { definition: adapter.definition, createAdapter };
}

function createInput(
  adapter: ProviderAdapter,
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
    expectedGeneration: 1,
    cwd: '/tmp/workspace',
    eventSink: () => undefined,
    interactionSink: cancelingInteractionSink(),
    ids: createTestIdSource(),
    clock: createTestClock(),
    ...overrides,
  };
}

function configuration(
  providerInstanceId: ProviderDefinition['providerInstanceId'],
  modelId = 'model-a',
) {
  return {
    providerSelection: { providerInstanceId, modelId, options: {} },
    interactionMode: 'auto' as const,
    autonomy: 'medium' as const,
  };
}

function isContractError(error: unknown, code: ProviderContractError['code']): boolean {
  return error instanceof ProviderContractError && error.code === code;
}

function serializedContainsNone(value: unknown): void {
  const serialized = JSON.stringify(value);
  for (const sentinel of SENTINELS) {
    assert.equal(
      serialized.includes(sentinel),
      false,
      `serialized output still contains ${sentinel}`,
    );
  }
}

test('a later successful refresh replaces the snapshot and increments only that instance revision', async () => {
  const droid = fakeAdapter('droid');
  const codex = fakeAdapter('codex');
  const registry = new ProviderRegistry([registration(droid), registration(codex)]);
  await registry.refresh('droid');
  await registry.refresh('codex');
  droid.snapshot = { ...droid.snapshot, readiness: 'unauthenticated' };
  const updated = await registry.refresh('droid');
  assert.equal(updated.revision, 2);
  assert.equal(updated.readiness, 'unauthenticated');
  assert.equal(registry.snapshot('codex')?.revision, 1);
  assert.equal(registry.snapshot('codex')?.readiness, 'ready');
});

test('definitions() return Droid, Codex, Claude, Cursor, then Grok regardless of construction order', () => {
  const registry = new ProviderRegistry([
    registration(fakeAdapter('grok')),
    registration(fakeAdapter('claude')),
    registration(fakeAdapter('droid')),
    registration(fakeAdapter('cursor')),
    registration(fakeAdapter('codex')),
  ]);
  assert.deepEqual(
    registry.definitions().map((entry) => entry.providerInstanceId),
    [...PROVIDER_DEFINITION_ORDER],
  );
});

test('duplicate instance ids are rejected at construction', () => {
  assert.throws(
    () =>
      new ProviderRegistry([
        registration(fakeAdapter('droid')),
        registration(fakeAdapter('droid')),
      ]),
    (error: unknown) => isContractError(error, 'invalid_provider_configuration'),
  );
});

test('an instance bound to the wrong driver is rejected at construction', () => {
  assert.throws(
    () =>
      new ProviderRegistry([
        {
          definition: {
            providerDriverKind: 'droid',
            providerInstanceId: 'codex',
            displayName: 'broken',
          },
          createAdapter: () => fakeAdapter('codex'),
        },
      ]),
    (error: unknown) => isContractError(error, 'invalid_provider_configuration'),
  );
});

test('an adapter constructed with the wrong driver for its instance is rejected', () => {
  const registry = new ProviderRegistry([
    {
      definition: definition('codex'),
      createAdapter: () => fakeAdapter('droid'),
    },
  ]);
  assert.throws(
    () => registry.resolve('codex'),
    (error: unknown) => isContractError(error, 'invalid_provider_configuration'),
  );
});

test('adapters are not constructed until first resolve or refresh', async () => {
  let constructed = 0;
  const adapter = fakeAdapter('droid');
  const registry = new ProviderRegistry([
    {
      definition: definition('droid'),
      createAdapter: () => {
        constructed += 1;
        return adapter;
      },
    },
  ]);
  assert.equal(constructed, 0);
  registry.definitions();
  assert.equal(constructed, 0);
  assert.equal(registry.snapshot('droid'), undefined);
  registry.resolve('droid');
  assert.equal(constructed, 1);
  registry.resolve('droid');
  assert.equal(constructed, 1);
  await registry.refresh('droid');
  assert.equal(constructed, 1);
});

test('two concurrent refreshes of the same instance coalesce into one probe', async () => {
  const adapter = fakeAdapter('droid');
  adapter.gates.block('probe');
  const registry = new ProviderRegistry([registration(adapter)]);
  const first = registry.refresh('droid');
  await adapter.gates.waitUntilBlocked('probe');
  const second = registry.refresh('droid');
  assert.equal(adapter.calls.filter((call) => call.op === 'probe').length, 1);
  adapter.gates.release('probe');
  const [left, right] = await Promise.all([first, second]);
  assert.equal(left, right);
  assert.equal(left.revision, 1);
  assert.equal(registry.snapshot('droid')?.revision, 1);
});

test("a refresh of one instance does not disturb another instance's snapshot or revision", async () => {
  const droid = fakeAdapter('droid');
  const codex = fakeAdapter('codex');
  droid.gates.block('probe');
  codex.gates.block('probe');
  const registry = new ProviderRegistry([registration(droid), registration(codex)]);
  const droidRefresh = registry.refresh('droid');
  await droid.gates.waitUntilBlocked('probe');
  const codexRefresh = registry.refresh('codex');
  await codex.gates.waitUntilBlocked('probe');
  droid.snapshot = { ...droid.snapshot, readiness: 'ready' };
  droid.gates.release('probe');
  const droidSnapshot = await droidRefresh;
  assert.equal(droidSnapshot.revision, 1);
  assert.equal(registry.snapshot('codex'), undefined);
  assert.equal(registry.snapshot('droid')?.revision, 1);
  codex.gates.release('probe');
  const codexSnapshot = await codexRefresh;
  assert.equal(codexSnapshot.revision, 1);
  assert.equal(registry.snapshot('droid')?.revision, 1);
  assert.equal(registry.snapshot('codex')?.revision, 1);
});

test('a probe that completes after its refresh was superseded or aborted is discarded, and the newer snapshot survives', async () => {
  const adapter = fakeAdapter('droid');
  const registry = new ProviderRegistry([registration(adapter)]);
  const committed = await registry.refresh('droid');
  assert.equal(committed.revision, 1);

  adapter.gates.block('probe');
  const stale = registry.refresh('droid');
  await adapter.gates.waitUntilBlocked('probe');
  adapter.snapshot = {
    ...adapter.snapshot,
    readiness: 'error',
    error: {
      code: 'missing_executable',
      providerInstanceId: 'droid',
      message: 'stale-probe-should-not-land',
      recoveryAction: 'open_droid_setup',
    },
  };
  const deadline = ShutdownDeadline.fromDurationMs(1_000, 10);
  const closing = registry.close(deadline);
  adapter.gates.release('probe');
  await assert.rejects(stale, (error: unknown) =>
    isContractError(error, 'stale_provider_operation'),
  );
  await closing;
  const surviving = registry.snapshot('droid');
  assert.ok(surviving);
  assert.equal(surviving.revision, committed.revision);
  assert.equal(surviving.readiness, 'ready');
  assert.equal(surviving.error, undefined);
});

test('a probe that completes after shutdown began is discarded', async () => {
  const adapter = fakeAdapter('droid');
  adapter.gates.block('probe');
  const registry = new ProviderRegistry([registration(adapter)]);
  const pending = registry.refresh('droid');
  await adapter.gates.waitUntilBlocked('probe');
  const deadline = ShutdownDeadline.fromDurationMs(1_000, 20);
  const closing = registry.close(deadline);
  adapter.snapshot = { ...adapter.snapshot, readiness: 'unauthenticated' };
  adapter.gates.release('probe');
  await assert.rejects(pending, (error: unknown) =>
    isContractError(error, 'stale_provider_operation'),
  );
  await closing;
  assert.equal(registry.snapshot('droid'), undefined);
  assert.equal(registry.isClosed, true);
});

test('abortDiscovery discards late refresh before adapters close with the same deadline', async () => {
  const adapter = fakeAdapter('droid');
  adapter.gates.block('probe');
  const registry = new ProviderRegistry([registration(adapter)]);
  registry.resolve('droid');
  const pending = registry.refresh('droid');
  await adapter.gates.waitUntilBlocked('probe');
  registry.abortDiscovery();
  adapter.snapshot = { ...adapter.snapshot, readiness: 'error' };
  adapter.gates.release('probe');
  await assert.rejects(pending, (error: unknown) =>
    isContractError(error, 'stale_provider_operation'),
  );
  const deadline = ShutdownDeadline.fromDurationMs(2_000, 30);
  await registry.close(deadline);
  assert.equal(adapter.receivedCloseDeadline, deadline);
});

test('reverse close order follows construction order and passes the same deadline through unchanged', async () => {
  const closeOrder: string[] = [];
  const droid = fakeAdapter('droid');
  const codex = fakeAdapter('codex');
  const claude = fakeAdapter('claude');
  const deadline = ShutdownDeadline.fromDurationMs(5_000, 100);
  for (const adapter of [droid, codex, claude]) {
    const inner = adapter.close.bind(adapter);
    adapter.close = async (received) => {
      closeOrder.push(adapter.definition.providerInstanceId);
      await inner(received);
    };
  }
  const registry = new ProviderRegistry([
    registration(claude),
    registration(droid),
    registration(codex),
  ]);
  registry.resolve('codex');
  registry.resolve('droid');
  registry.resolve('claude');
  await registry.close(deadline);
  assert.deepEqual(closeOrder, ['claude', 'droid', 'codex']);
  assert.equal(droid.receivedCloseDeadline, deadline);
  assert.equal(codex.receivedCloseDeadline, deadline);
  assert.equal(claude.receivedCloseDeadline, deadline);
});

test('one adapter close failure is reported and does not prevent remaining adapters from closing', async () => {
  const closeOrder: string[] = [];
  const droid = fakeAdapter('droid');
  const codex = fakeAdapter('codex');
  const claude = fakeAdapter('claude');
  for (const adapter of [droid, codex, claude]) {
    const inner = adapter.close.bind(adapter);
    adapter.close = async (deadline) => {
      closeOrder.push(adapter.definition.providerInstanceId);
      await inner(deadline);
    };
  }
  claude.gates.fail('adapter.close', new Error('claude-close-failed'));
  const registry = new ProviderRegistry([
    registration(droid),
    registration(codex),
    registration(claude),
  ]);
  registry.resolve('droid');
  registry.resolve('codex');
  registry.resolve('claude');
  await assert.rejects(registry.close(ShutdownDeadline.fromDurationMs(1_000, 2)), {
    message: 'claude-close-failed',
  });
  assert.deepEqual(closeOrder, ['claude', 'codex', 'droid']);
});

test('shutdown is idempotent and does not close adapters twice', async () => {
  const droid = fakeAdapter('droid');
  const registry = new ProviderRegistry([registration(droid)]);
  registry.resolve('droid');
  const deadline = ShutdownDeadline.fromDurationMs(1_000, 3);
  await registry.close(deadline);
  await registry.close(deadline);
  assert.equal(droid.calls.filter((call) => call.op === 'adapter.close').length, 1);
});

test('an adapter that was never constructed is never closed', async () => {
  let grokConstructed = 0;
  const droid = fakeAdapter('droid');
  const grok = fakeAdapter('grok');
  const registry = new ProviderRegistry([
    registration(droid),
    {
      definition: definition('grok'),
      createAdapter: () => {
        grokConstructed += 1;
        return grok;
      },
    },
  ]);
  registry.resolve('droid');
  await registry.close(ShutdownDeadline.fromDurationMs(1_000, 4));
  assert.equal(grokConstructed, 0);
  assert.equal(grok.calls.filter((call) => call.op === 'adapter.close').length, 0);
});

test('equal model ids are scoped by provider instance', async () => {
  const droid = fakeAdapter('droid');
  const codex = fakeAdapter('codex');
  droid.snapshot = {
    ...droid.snapshot,
    models: [
      {
        id: 'shared-model',
        displayName: 'Droid Shared',
        isDefault: true,
        supportedReasoningEfforts: [],
        serviceTiers: [],
      },
      {
        id: 'droid-only',
        displayName: 'Droid Only',
        isDefault: false,
        supportedReasoningEfforts: [],
        serviceTiers: [],
      },
    ],
  };
  codex.snapshot = {
    ...codex.snapshot,
    models: [
      {
        id: 'shared-model',
        displayName: 'Codex Shared',
        isDefault: true,
        supportedReasoningEfforts: [],
        serviceTiers: [],
      },
    ],
  };
  const registry = new ProviderRegistry([registration(droid), registration(codex)]);
  await registry.refresh('droid');
  await registry.refresh('codex');
  const droidSnapshot = registry.assertSelection(configuration('droid', 'shared-model'));
  const codexSnapshot = registry.assertSelection(configuration('codex', 'shared-model'));
  assert.equal(droidSnapshot.definition.providerInstanceId, 'droid');
  assert.equal(codexSnapshot.definition.providerInstanceId, 'codex');
  assert.equal(droidSnapshot.models[0]?.displayName, 'Droid Shared');
  assert.equal(codexSnapshot.models[0]?.displayName, 'Codex Shared');
  registry.assertSelection(configuration('droid', 'droid-only'));
  assert.throws(
    () => registry.assertSelection(configuration('codex', 'droid-only')),
    (error: unknown) => isContractError(error, 'invalid_provider_configuration'),
  );
});

test('an unsupported operation fails before the adapter is called', async () => {
  const adapter = fakeAdapter('droid');
  adapter.snapshot = {
    ...adapter.snapshot,
    capabilities: completeFakeCapabilities({
      steer: false,
      missionControl: false,
      modes: ['auto'],
    }),
  };
  const registry = new ProviderRegistry([registration(adapter)]);
  await registry.refresh('droid');
  assert.throws(
    () => registry.assertCapability('droid', 'steer'),
    (error: unknown) => isContractError(error, 'unsupported_capability'),
  );
  assert.throws(
    () => registry.assertCapability('droid', 'missionControl'),
    (error: unknown) => isContractError(error, 'unsupported_capability'),
  );
  assert.throws(
    () =>
      registry.assertSelection({
        providerSelection: { providerInstanceId: 'droid', modelId: 'model-a', options: {} },
        interactionMode: 'spec',
        autonomy: 'medium',
      }),
    (error: unknown) => isContractError(error, 'unsupported_capability'),
  );
  assert.deepEqual(
    adapter.calls.map((call) => call.op),
    ['probe'],
  );
});

test('serialized snapshots and log lines omit sentinel token, API key, credential home, and raw account values', async () => {
  const adapter = fakeAdapter('droid');
  adapter.snapshot = {
    ...adapter.snapshot,
    executable: { name: SENTINEL_CREDENTIAL_HOME, version: '1.0.0' },
    auth: {
      accountLabel: SENTINEL_ACCOUNT_PAYLOAD,
      apiProviderLabel: `key ${SENTINEL_API_KEY}`,
      billingLabel: `Bearer ${SENTINEL_TOKEN}`,
    },
    error: {
      code: 'missing_executable',
      providerInstanceId: 'droid',
      message: `ENOENT ${SENTINEL_CREDENTIAL_HOME} token=${SENTINEL_TOKEN} FACTORY_API_KEY=${SENTINEL_API_KEY} account=${SENTINEL_ACCOUNT_PAYLOAD}`,
      recoveryAction: 'open_droid_setup',
    },
  };
  const registry = new ProviderRegistry([registration(adapter)]);
  const snapshot = await registry.refresh('droid');
  serializedContainsNone(snapshot);
  serializedContainsNone(registry.snapshots());
  serializedContainsNone(
    sanitizeForLog(
      `probe ${SENTINEL_TOKEN} FACTORY_API_KEY=${SENTINEL_API_KEY} home=${SENTINEL_CREDENTIAL_HOME} account=${SENTINEL_ACCOUNT_PAYLOAD}`,
    ),
  );
  assert.equal(snapshot.executable?.name.includes(SENTINEL_CREDENTIAL_HOME), false);
  assert.equal(redactSensitiveText(snapshot.error?.message ?? '').includes(SENTINEL_TOKEN), false);
});

test('the registry does not own live sessions', () => {
  const methodNames = Object.getOwnPropertyNames(ProviderRegistry.prototype);
  assert.equal(
    methodNames.some((name) => /session/i.test(name)),
    false,
  );
  const registry = new ProviderRegistry([registration(fakeAdapter('droid'))]);
  assert.equal('sessions' in registry, false);
});

test('unavailable Codex, Claude, Cursor, and Grok report a truthful missing setup snapshot', async () => {
  const registry = createDefaultProviderRegistry({
    droid: () => fakeAdapter('droid'),
  });
  assert.deepEqual(
    registry.definitions().map((entry) => entry.providerInstanceId),
    [...PROVIDER_DEFINITION_ORDER],
  );
  for (const providerInstanceId of ['codex', 'claude', 'cursor', 'grok'] as const) {
    const snapshot = await registry.refresh(providerInstanceId);
    assert.equal(snapshot.readiness, 'missing');
    assert.deepEqual(snapshot.capabilities, UNAVAILABLE_PROVIDER_CAPABILITIES);
    assert.equal(snapshot.models.length, 0);
    assert.ok(snapshot.error);
    assert.equal(snapshot.error.code, 'unavailable_provider_instance');
    assert.equal(snapshot.error.recoveryAction, `open_${providerInstanceId}_setup`);
    const adapter = registry.resolve(providerInstanceId);
    await assert.rejects(
      () => adapter.create(createInput(adapter)),
      (error: unknown) => isContractError(error, 'unavailable_provider_instance'),
    );
    await assert.rejects(
      () => adapter.resume({ ...createInput(adapter), resumeState: { cursor: 'opaque' } }),
      (error: unknown) => isContractError(error, 'unavailable_provider_instance'),
    );
  }
});

test('a real adapter replaces an unavailable placeholder at the registration site', async () => {
  const cursor = fakeAdapter('cursor');
  const registry = createDefaultProviderRegistry({
    droid: () => fakeAdapter('droid'),
    cursor: () => cursor,
  });
  const snapshot = await registry.refresh('cursor');
  assert.equal(snapshot.readiness, 'ready');
  assert.equal(registry.resolve('cursor'), cursor);
  const stillUnavailable = createUnavailableProviderAdapter('grok');
  assert.equal((await stillUnavailable.probe(new AbortController().signal)).readiness, 'missing');
});

test('refresh after shutdown is rejected', async () => {
  const registry = new ProviderRegistry([registration(fakeAdapter('droid'))]);
  await registry.close(ShutdownDeadline.fromDurationMs(1_000, 5));
  assert.throws(
    () => {
      void registry.refresh('droid');
    },
    (error: unknown) => isContractError(error, 'stale_provider_operation'),
  );
});
