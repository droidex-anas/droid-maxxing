import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AutonomyLevel,
  DroidInteractionMode,
  ReasoningEffort as SdkReasoningEffort,
} from '@factory/droid-sdk';

import {
  APPROVAL_DECISION_TO_OUTCOME,
  DROID_AUTONOMY_TABLE,
  DROID_DEFINITION,
  DROID_INTERACTION_MODE_TABLE,
  DROID_REASONING_EFFORT_TABLE,
  createInitializeSessionParams,
  droidCapabilities,
  encodeDroidResumeState,
  factoryReasoningEffort,
  mapAutonomy,
  mapInteractionMode,
  parseDroidResumeState,
} from './DroidModeMapping.js';
import { assertCompleteCapabilities } from '../testing/ProviderContractHarness.js';

test('Droid definition is the static droid instance', () => {
  assert.deepEqual(DROID_DEFINITION, {
    providerDriverKind: 'droid',
    providerInstanceId: 'droid',
    displayName: 'Droid',
  });
});

test('interaction mode table is exhaustive for DROIDEX modes', () => {
  assert.deepEqual(
    DROID_INTERACTION_MODE_TABLE.map((row) => row.droidex),
    ['auto', 'spec', 'agi'],
  );
  assert.equal(mapInteractionMode('auto'), DroidInteractionMode.Auto);
  assert.equal(mapInteractionMode('spec'), DroidInteractionMode.Spec);
  assert.equal(mapInteractionMode('agi'), DroidInteractionMode.AGI);
});

test('autonomy table is exhaustive for DROIDEX autonomy levels', () => {
  assert.deepEqual(
    DROID_AUTONOMY_TABLE.map((row) => row.droidex),
    ['off', 'low', 'medium', 'high'],
  );
  assert.equal(mapAutonomy('off'), AutonomyLevel.Off);
  assert.equal(mapAutonomy('low'), AutonomyLevel.Low);
  assert.equal(mapAutonomy('medium'), AutonomyLevel.Medium);
  assert.equal(mapAutonomy('high'), AutonomyLevel.High);
});

test('reasoning effort table maps every DROIDEX effort', () => {
  assert.equal(factoryReasoningEffort('none'), SdkReasoningEffort.None);
  assert.equal(factoryReasoningEffort('dynamic'), SdkReasoningEffort.Dynamic);
  assert.equal(factoryReasoningEffort('off'), SdkReasoningEffort.Off);
  assert.equal(factoryReasoningEffort('minimal'), SdkReasoningEffort.Minimal);
  assert.equal(factoryReasoningEffort('low'), SdkReasoningEffort.Low);
  assert.equal(factoryReasoningEffort('medium'), SdkReasoningEffort.Medium);
  assert.equal(factoryReasoningEffort('high'), SdkReasoningEffort.High);
  assert.equal(factoryReasoningEffort('xhigh'), SdkReasoningEffort.ExtraHigh);
  assert.equal(factoryReasoningEffort('max'), SdkReasoningEffort.Max);
  assert.equal(DROID_REASONING_EFFORT_TABLE.length, 9);
});

test('approval decision table maps closed decisions to Factory outcomes', () => {
  assert.deepEqual(
    APPROVAL_DECISION_TO_OUTCOME.map((row) => row.decision),
    ['allow_once', 'allow_session', 'deny', 'cancel'],
  );
});

test('Droid capabilities are complete and truthful', () => {
  const capabilities = droidCapabilities();
  assertCompleteCapabilities(capabilities);
  assert.deepEqual(capabilities.modes, ['auto', 'spec', 'agi']);
  assert.deepEqual(capabilities.autonomyLevels, ['off', 'low', 'medium', 'high']);
  assert.equal(capabilities.modelChange, 'before_turn');
  assert.equal(capabilities.resume, true);
  assert.equal(capabilities.steer, false);
  assert.equal(capabilities.interrupt, true);
  assert.equal(capabilities.approvals, true);
  assert.equal(capabilities.questions, true);
  assert.equal(capabilities.planReview, true);
  assert.equal(capabilities.context, true);
  assert.equal(capabilities.compaction, true);
  assert.equal(capabilities.skills, true);
  assert.equal(capabilities.slashCommands, true);
  assert.equal(capabilities.mcpUse, true);
  assert.equal(capabilities.mcpManagement, true);
  assert.equal(capabilities.rewind, true);
  assert.equal(capabilities.fork, true);
  assert.equal(capabilities.observationalTasks, true);
  assert.equal(capabilities.addressableChildren, true);
  assert.equal(capabilities.missionControl, true);
  assert.equal(capabilities.browser, true);
  assert.equal(capabilities.usageReporting, true);
  assert.equal(capabilities.reasoningStream, true);
});

test('passes compaction settings when initializing a session', () => {
  const params = createInitializeSessionParams({
    cwd: '/tmp/project',
    interactionMode: 'auto',
    modelId: 'main-model',
    compactionModel: 'summary-model',
    compactionTokenLimit: 400_000,
  });
  assert.equal(params.compactionModel, 'summary-model');
  assert.equal(params.compactionTokenLimit, 400_000);
});

test('passes current-model compaction sentinel when initializing a session', () => {
  const params = createInitializeSessionParams({
    cwd: '/tmp/project',
    interactionMode: 'auto',
    modelId: 'main-model',
    compactionModel: 'current-model',
  });
  assert.equal(params.compactionModel, 'current-model');
});

test('resume state encode/parse is exact and rejects malformed values', () => {
  const encoded = encodeDroidResumeState('factory-1');
  assert.deepEqual(encoded, { schemaVersion: 1, sessionId: 'factory-1' });
  assert.deepEqual(parseDroidResumeState(encoded), encoded);
  assert.equal(parseDroidResumeState({ schemaVersion: 1, sessionId: '' }), undefined);
  assert.equal(parseDroidResumeState({ schemaVersion: 2, sessionId: 'factory-1' }), undefined);
  assert.equal(parseDroidResumeState('factory-1'), undefined);
});
