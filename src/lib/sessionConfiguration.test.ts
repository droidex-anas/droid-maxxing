import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildSessionConfiguration,
  configurationForComposer,
  droidSessionConfiguration,
} from './sessionConfiguration.js';

test('droidSessionConfiguration is the Droid wrapper around the canonical builder', () => {
  assert.deepEqual(
    droidSessionConfiguration({
      modelId: 'model-a',
      reasoningEffort: 'high',
      interactionMode: 'spec',
      autonomy: 'medium',
    }),
    buildSessionConfiguration({
      providerInstanceId: 'droid',
      modelId: 'model-a',
      reasoningEffort: 'high',
      interactionMode: 'spec',
      autonomy: 'medium',
    }),
  );
});

test('configurationForComposer clamps spec and reasoning to the harness snapshot', () => {
  const configuration = configurationForComposer({
    providerInstanceId: 'grok',
    modelId: 'grok-build',
    reasoningEffort: 'high',
    interactionMode: 'spec',
    autonomy: 'medium',
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
  });
  assert.equal(configuration.providerSelection.providerInstanceId, 'grok');
  assert.equal(configuration.interactionMode, 'auto');
  assert.deepEqual(configuration.providerSelection.options, {});
});
