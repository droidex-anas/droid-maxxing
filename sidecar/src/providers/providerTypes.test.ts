import assert from 'node:assert/strict';
import test from 'node:test';

import { parseProviderError } from './providerErrors.js';
import {
  START_TURN_ACCEPTANCE_ONLY,
  assertConfigurationMatchesAdapter,
  assertCreateInputMatchesAdapter,
  assertDefinitionConsistency,
  createProviderContractError,
  defineProviderCapabilities,
  parseProviderCapabilities,
  PRE_ACTIVATION_MAX_BYTES,
  PRE_ACTIVATION_MAX_EVENTS,
  PROVIDER_CAPABILITY_KEYS,
  ProviderContractError,
  type ProviderCapabilities,
  type ProviderDefinition,
  type ProviderSession,
  type ProviderSessionCreateInput,
  type ProviderTurnSettlement,
} from './providerTypes.js';

const DROID_DEFINITION: ProviderDefinition = {
  providerDriverKind: 'droid',
  providerInstanceId: 'droid',
  displayName: 'Droid',
};

function completeCapabilities(overrides: Partial<ProviderCapabilities> = {}): ProviderCapabilities {
  return defineProviderCapabilities({
    modes: ['auto', 'spec', 'agi'],
    autonomyLevels: ['off', 'low', 'medium', 'high'],
    modelChange: 'before_turn',
    resume: true,
    steer: true,
    interrupt: true,
    approvals: true,
    questions: true,
    planReview: true,
    context: true,
    compaction: true,
    skills: true,
    slashCommands: true,
    mcpUse: true,
    mcpManagement: true,
    rewind: true,
    fork: true,
    observationalTasks: true,
    addressableChildren: true,
    missionControl: true,
    browser: true,
    usageReporting: true,
    reasoningStream: true,
    ...overrides,
  });
}

function droidConfiguration(providerInstanceId: 'droid' | 'codex' = 'droid') {
  return {
    providerSelection: {
      providerInstanceId,
      modelId: 'model-a',
      options: {},
    },
    interactionMode: 'auto' as const,
    autonomy: 'medium' as const,
  };
}

test('START_TURN_ACCEPTANCE_ONLY is true so a settlement return type is a compile error', () => {
  assert.equal(START_TURN_ACCEPTANCE_ONLY, true);
  type StartTurnResult = Awaited<ReturnType<ProviderSession['startTurn']>>;
  const acceptance: StartTurnResult = undefined;
  assert.equal(acceptance, undefined);
  // @ts-expect-error startTurn must not return a turn settlement
  const _settlement: StartTurnResult = { status: 'completed' } satisfies ProviderTurnSettlement;
  void _settlement;
});

test('ProviderCapabilities requires every advertised field including usageReporting and reasoningStream', () => {
  const capabilities = completeCapabilities();
  assert.equal(PROVIDER_CAPABILITY_KEYS.length, 23);
  for (const key of PROVIDER_CAPABILITY_KEYS) {
    assert.notEqual(capabilities[key], undefined, key);
  }
  assert.equal(capabilities.usageReporting, true);
  assert.equal(capabilities.reasoningStream, true);
  assert.deepEqual(parseProviderCapabilities(capabilities), capabilities);
});

test('ProviderCapabilities decoder rejects a missing field and an extra field', () => {
  const capabilities = completeCapabilities();
  const { usageReporting: _usageReporting, ...missingUsage } = capabilities;
  void _usageReporting;
  assert.throws(() => parseProviderCapabilities(missingUsage));
  const { reasoningStream: _reasoningStream, ...missingReasoning } = capabilities;
  void _reasoningStream;
  assert.throws(() => parseProviderCapabilities(missingReasoning));
  assert.throws(() => parseProviderCapabilities({ ...capabilities, invented: true }));
});

test('omitting usageReporting or adding an unknown capability is a compile error', () => {
  const required: ProviderCapabilities = {
    modes: ['auto'],
    autonomyLevels: ['off'],
    modelChange: 'unsupported',
    resume: false,
    steer: false,
    interrupt: false,
    approvals: false,
    questions: false,
    planReview: false,
    context: false,
    compaction: false,
    skills: false,
    slashCommands: false,
    mcpUse: false,
    mcpManagement: false,
    rewind: false,
    fork: false,
    observationalTasks: false,
    addressableChildren: false,
    missionControl: false,
    browser: false,
    usageReporting: false,
    reasoningStream: false,
  };
  assert.throws(() =>
    defineProviderCapabilities({
      ...required,
      // @ts-expect-error unknown capability fields are not part of the contract
      invented: true,
    }),
  );
  assert.throws(() =>
    // @ts-expect-error usageReporting is required
    defineProviderCapabilities({
      modes: ['auto'],
      autonomyLevels: ['off'],
      modelChange: 'unsupported',
      resume: false,
      steer: false,
      interrupt: false,
      approvals: false,
      questions: false,
      planReview: false,
      context: false,
      compaction: false,
      skills: false,
      slashCommands: false,
      mcpUse: false,
      mcpManagement: false,
      rewind: false,
      fork: false,
      observationalTasks: false,
      addressableChildren: false,
      missionControl: false,
      browser: false,
      reasoningStream: false,
    }),
  );
});

test('mismatched providerDriverKind and providerInstanceId fail closed', () => {
  assert.throws(
    () =>
      assertDefinitionConsistency({
        providerDriverKind: 'droid',
        providerInstanceId: 'codex',
        displayName: 'broken',
      }),
    (error: unknown) =>
      error instanceof ProviderContractError && error.code === 'invalid_provider_configuration',
  );
});

test('a provider selection that does not match the adapter instance is rejected', () => {
  assert.throws(
    () => assertConfigurationMatchesAdapter(DROID_DEFINITION, droidConfiguration('codex')),
    (error: unknown) =>
      error instanceof ProviderContractError && error.code === 'invalid_provider_configuration',
  );
  assert.doesNotThrow(() =>
    assertConfigurationMatchesAdapter(DROID_DEFINITION, droidConfiguration('droid')),
  );
});

test('create input rejects a malformed target before adapter work', () => {
  const sink = {
    requestApproval: async () => ({ decision: 'cancel' as const }),
    requestQuestion: async () => ({ status: 'cancelled' as const }),
    requestPlanReview: async () => ({ decision: 'cancel' as const }),
  };
  const input = {
    target: { kind: 'session', appSessionId: 'app-1', parentAppSessionId: 'parent-1' },
    configuration: droidConfiguration(),
    expectedGeneration: 1,
    cwd: '/tmp',
    eventSink: () => undefined,
    interactionSink: sink,
    ids: { nextEventId: () => 'evt-1', nextProviderSessionId: () => 'prov-1' },
    clock: { now: () => 1 },
  } as unknown as ProviderSessionCreateInput;
  assert.throws(() => assertCreateInputMatchesAdapter(DROID_DEFINITION, input));
});

test('create input rejects a missing or fractional generation', () => {
  const sink = {
    requestApproval: async () => ({ decision: 'cancel' as const }),
    requestQuestion: async () => ({ status: 'cancelled' as const }),
    requestPlanReview: async () => ({ decision: 'cancel' as const }),
  };
  const base = {
    target: { kind: 'session' as const, appSessionId: 'app-1' },
    configuration: droidConfiguration(),
    cwd: '/tmp',
    eventSink: () => undefined,
    interactionSink: sink,
    ids: { nextEventId: () => 'evt-1', nextProviderSessionId: () => 'prov-1' },
    clock: { now: () => 1 },
  };
  assert.throws(() =>
    assertCreateInputMatchesAdapter(DROID_DEFINITION, { ...base, expectedGeneration: 1.5 }),
  );
  assert.throws(() =>
    assertCreateInputMatchesAdapter(DROID_DEFINITION, { ...base, expectedGeneration: -1 }),
  );
});

test('ProviderContractError round-trips a sanitized ProviderError', () => {
  const error = createProviderContractError(
    'droid',
    'missing_executable',
    '  needs\x07setup  ',
    'open_droid_setup',
  );
  assert.equal(error.message, 'needssetup');
  assert.deepEqual(error.toProviderError(), parseProviderError(error.toProviderError()));
});

test('pre-activation bounds are 512 events and 1,048,576 UTF-8 bytes', () => {
  assert.equal(PRE_ACTIVATION_MAX_EVENTS, 512);
  assert.equal(PRE_ACTIVATION_MAX_BYTES, 1_048_576);
});
