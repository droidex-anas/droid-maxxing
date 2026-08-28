import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_BOUNDED_ID_CHARS,
  MAX_MODEL_ID_CHARS,
  parseDroidAgentConfiguration,
  parseDroidMissionConfiguration,
  parseProviderBinding,
  parseProviderSelection,
  parseSessionConfiguration,
  parseSessionTarget,
  providerBindingSchema,
  providerDriverKindForInstance,
  providerSelectionsEqual,
  providerSelectionSchema,
  sessionConfigurationSchema,
  sessionTargetSchema,
} from './providerIdentity.js';

const VALID_V1_BINDINGS = [
  { providerDriverKind: 'droid', providerInstanceId: 'droid' },
  { providerDriverKind: 'codex', providerInstanceId: 'codex' },
  { providerDriverKind: 'claude', providerInstanceId: 'claude' },
] as const;

const INVALID_BINDING_PAIRS = [
  { providerDriverKind: 'droid', providerInstanceId: 'codex' },
  { providerDriverKind: 'codex', providerInstanceId: 'claude' },
  { providerDriverKind: 'claude', providerInstanceId: 'droid' },
  { providerDriverKind: 'droid', providerInstanceId: 'claude' },
  { providerDriverKind: 'codex', providerInstanceId: 'droid' },
  { providerDriverKind: 'claude', providerInstanceId: 'codex' },
] as const;

function validSelection(providerInstanceId: 'droid' | 'codex' | 'claude' = 'droid') {
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

test('only the three exact v1 driver/instance pairs validate', () => {
  for (const binding of VALID_V1_BINDINGS) {
    assert.deepEqual(parseProviderBinding(binding), binding);
    assert.equal(
      providerDriverKindForInstance(binding.providerInstanceId),
      binding.providerDriverKind,
    );
  }
});

test('every other driver/instance combination is rejected', () => {
  for (const binding of INVALID_BINDING_PAIRS) {
    assert.throws(() => parseProviderBinding(binding));
  }
  assert.throws(() =>
    providerBindingSchema.parse({ providerDriverKind: 'unknown', providerInstanceId: 'droid' }),
  );
  assert.throws(() =>
    providerBindingSchema.parse({ providerDriverKind: 'droid', providerInstanceId: 'unknown' }),
  );
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
    parseProviderBinding({
      providerDriverKind: 'droid',
      providerInstanceId: 'droid',
      extra: true,
    }),
  );
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

test('bounded ids and model ids reject empty and over-long values', () => {
  assert.throws(() => parseSessionTarget({ kind: 'session', appSessionId: '   ' }));
  assert.throws(() =>
    parseProviderSelection({
      ...validSelection(),
      modelId: 'x'.repeat(MAX_MODEL_ID_CHARS + 1),
    }),
  );
  assert.throws(() =>
    parseSessionTarget({
      kind: 'session',
      appSessionId: 'x'.repeat(MAX_BOUNDED_ID_CHARS + 1),
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
