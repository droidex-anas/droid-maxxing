import assert from 'node:assert/strict';
import test from 'node:test';

import type { ModelInfo, ProviderWireSnapshot } from '../../types/bridge.js';
import {
  activeHarnessId,
  defaultModelId,
  modelsForHarness,
  snapshotForHarness,
} from './providerCatalog.js';
import { droidSessionConfiguration } from '../../lib/sessionConfiguration.js';

function snapshot(
  providerInstanceId: ProviderWireSnapshot['definition']['providerInstanceId'],
  models: ProviderWireSnapshot['models'],
): ProviderWireSnapshot {
  return {
    definition: {
      providerDriverKind: providerInstanceId,
      providerInstanceId,
      displayName: providerInstanceId,
    },
    revision: 1,
    readiness: 'ready',
    models,
    capabilities: {
      modes: ['auto'],
      autonomyLevels: ['off', 'low', 'medium', 'high'],
      modelChange: 'before_turn',
      resume: true,
      steer: false,
      interrupt: true,
      approvals: true,
      questions: true,
      planReview: true,
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
    },
  };
}

const droidModels: ModelInfo[] = [
  {
    id: 'droid-core',
    displayName: 'Droid Core',
    provider: 'droid-core',
    isCustom: false,
    isDefault: true,
  },
];

test('a live session owns the harness; drafts use the stored draft id', () => {
  assert.equal(
    activeHarnessId({
      activeSession: {
        configuration: droidSessionConfiguration({
          modelId: 'droid-core',
          interactionMode: 'auto',
          autonomy: 'off',
        }),
      },
      draftProviderInstanceId: 'grok',
    }),
    'droid',
  );
  assert.equal(activeHarnessId({ activeSession: null, draftProviderInstanceId: 'grok' }), 'grok');
});

test('Grok never inherits the Droid CLI catalog', () => {
  const grok = snapshot('grok', [
    {
      id: 'grok-build',
      displayName: 'Grok Build',
      isDefault: true,
      supportedReasoningEfforts: [],
    },
  ]);
  const models = modelsForHarness({
    harnessId: 'grok',
    droidModels,
    snapshots: [grok],
  });
  assert.deepEqual(
    models.map((model) => model.id),
    ['grok-build'],
  );
  assert.equal(models[0]?.supportedReasoningEfforts?.length, 0);
});

test('Droid prefers the rich CLI catalog when it has arrived', () => {
  const droid = snapshot('droid', [
    { id: 'thin', displayName: 'Thin', isDefault: true, supportedReasoningEfforts: [] },
  ]);
  const models = modelsForHarness({
    harnessId: 'droid',
    droidModels,
    snapshots: [droid],
  });
  assert.equal(models[0]?.id, 'droid-core');
});

test('defaultModelId prefers the advertised default', () => {
  assert.equal(
    defaultModelId([
      { id: 'a', displayName: 'A', isCustom: false },
      { id: 'b', displayName: 'B', isCustom: false, isDefault: true },
    ]),
    'b',
  );
  assert.equal(snapshotForHarness([], 'grok'), undefined);
});
