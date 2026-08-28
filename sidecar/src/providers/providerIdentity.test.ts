import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseDroidAgentConfiguration,
  parseDroidMissionConfiguration,
  parseProviderSelection,
  parseSessionConfiguration,
  parseSessionTarget,
  providerDriverKindForInstance,
  providerInstanceIdSchema,
  providerSelectionsEqual,
  providerSelectionSchema,
  sessionConfigurationSchema,
  sessionTargetSchema,
} from './providerIdentity.js';

const VALID_V1_INSTANCES = ['droid', 'codex', 'claude', 'cursor', 'grok'] as const;

function validSelection(
  providerInstanceId: 'droid' | 'codex' | 'claude' | 'cursor' | 'grok' = 'droid',
) {
  return {
    providerInstanceId,
    modelId: 'model-a',
    options: { reasoningEffort: 'high' },
  };
}

function validConfiguration(overrides: Record<string, unknown> = {}) {
  return {
    providerSelection: validSelection(),
    interactionMode: 'auto',
    autonomy: 'medium',
    ...overrides,
  };
}

test('only the five exact v1 driver/instance pairs validate through providerDriverKindForInstance', () => {
  for (const providerInstanceId of VALID_V1_INSTANCES) {
    assert.equal(providerDriverKindForInstance(providerInstanceId), providerInstanceId);
    assert.equal(providerInstanceIdSchema.parse(providerInstanceId), providerInstanceId);
  }
});

test('unknown providerInstanceId values are rejected', () => {
  assert.throws(() => providerInstanceIdSchema.parse('unknown'));
  assert.throws(() => providerInstanceIdSchema.parse('opencode'));
});

test('equal modelId with different providerInstanceId are not equal selections', () => {
  const droidSelection = parseProviderSelection(validSelection('droid'));
  const codexSelection = parseProviderSelection(validSelection('codex'));
  assert.equal(droidSelection.modelId, codexSelection.modelId);
  assert.equal(providerSelectionsEqual(droidSelection, codexSelection), false);
});

test('providerSelectionsEqual compares instance before model and options', () => {
  const left = parseProviderSelection(validSelection('droid'));
  const same = parseProviderSelection(validSelection('droid'));
  const differentModel = parseProviderSelection({
    ...validSelection('droid'),
    modelId: 'model-b',
  });
  const differentOptions = parseProviderSelection({
    ...validSelection('droid'),
    options: { reasoningEffort: 'low' },
  });

  assert.equal(providerSelectionsEqual(left, same), true);
  assert.equal(providerSelectionsEqual(left, differentModel), false);
  assert.equal(providerSelectionsEqual(left, differentOptions), false);
});

test('a summary-style configuration missing required fields is rejected', () => {
  assert.throws(() => parseSessionConfiguration({ interactionMode: 'auto', autonomy: 'medium' }));
  assert.throws(() =>
    parseSessionConfiguration({ providerSelection: validSelection(), autonomy: 'medium' }),
  );
  assert.throws(() =>
    parseSessionConfiguration({ providerSelection: validSelection(), interactionMode: 'auto' }),
  );
  assert.throws(() => parseSessionConfiguration({}));
});

test('missing providerSelection is never coerced to droid', () => {
  const result = sessionConfigurationSchema.safeParse({
    interactionMode: 'auto',
    autonomy: 'medium',
  });
  assert.equal(result.success, false);
});

test('invalid interactionMode and autonomy values are rejected', () => {
  assert.throws(() =>
    parseSessionConfiguration(validConfiguration({ interactionMode: 'mission' })),
  );
  assert.throws(() => parseSessionConfiguration(validConfiguration({ autonomy: 'turbo' })));
});

test('provider option values outside string | number | boolean are rejected', () => {
  for (const invalidValue of [null, undefined, {}, [], () => undefined]) {
    assert.throws(() =>
      providerSelectionSchema.parse({
        ...validSelection(),
        options: { bad: invalidValue },
      }),
    );
  }
});

test('unknown extra keys are rejected in strict provider identity objects', () => {
  assert.throws(() =>
    parseProviderSelection({
      ...validSelection(),
      shadow: 'value',
    }),
  );
  assert.throws(() =>
    parseSessionConfiguration({
      ...validConfiguration(),
      modelId: 'legacy-top-level',
    }),
  );
  assert.throws(() =>
    parseDroidAgentConfiguration({
      modelId: 'worker-a',
      reasoningEffort: 'high',
      workerModelId: 'legacy',
    }),
  );
  assert.throws(() =>
    parseDroidMissionConfiguration({
      worker: { modelId: 'worker-a' },
      validator: { modelId: 'validator-a' },
      mission: true,
    }),
  );
});

test('SessionTarget session variant round-trips and rejects mixed child fields', () => {
  const target = parseSessionTarget({ kind: 'session', appSessionId: 'app-1' });
  assert.deepEqual(target, { kind: 'session', appSessionId: 'app-1' });
  assert.throws(() =>
    sessionTargetSchema.parse({
      kind: 'session',
      appSessionId: 'app-1',
      parentAppSessionId: 'parent-1',
    }),
  );
});

test('SessionTarget child variant round-trips and rejects mixed session fields', () => {
  const target = parseSessionTarget({
    kind: 'child',
    parentAppSessionId: 'parent-1',
    childSessionId: 'child-1',
  });
  assert.deepEqual(target, {
    kind: 'child',
    parentAppSessionId: 'parent-1',
    childSessionId: 'child-1',
  });
  assert.throws(() =>
    sessionTargetSchema.parse({
      kind: 'child',
      parentAppSessionId: 'parent-1',
    }),
  );
  assert.throws(() =>
    sessionTargetSchema.parse({
      kind: 'child',
      childSessionId: 'child-1',
    }),
  );
  assert.throws(() =>
    sessionTargetSchema.parse({
      kind: 'child',
      parentAppSessionId: 'parent-1',
      childSessionId: 'child-1',
      appSessionId: 'app-1',
    }),
  );
});

test('bounded ids and model ids reject empty, padded, and over-long values', () => {
  assert.throws(() => parseSessionTarget({ kind: 'session', appSessionId: '   ' }));
  assert.throws(() => parseSessionTarget({ kind: 'session', appSessionId: '  droid-1  ' }));
  assert.throws(() =>
    parseProviderSelection({
      ...validSelection(),
      modelId: '  model-a  ',
    }),
  );
  assert.throws(() =>
    parseProviderSelection({
      ...validSelection(),
      modelId: 'x'.repeat(257),
    }),
  );
  assert.throws(() =>
    parseSessionTarget({
      kind: 'session',
      appSessionId: 'x'.repeat(257),
    }),
  );
});

test('droid mission configuration decodes worker and validator settings', () => {
  assert.deepEqual(
    parseDroidMissionConfiguration({
      worker: { modelId: 'worker-a', reasoningEffort: 'high' },
      validator: { modelId: 'validator-a' },
    }),
    {
      worker: { modelId: 'worker-a', reasoningEffort: 'high' },
      validator: { modelId: 'validator-a' },
    },
  );
});
