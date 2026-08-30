import assert from 'node:assert/strict';
import test from 'node:test';

import { adaptEvent, initialState, reducer } from '../../hooks/useStore.js';
import type { ProviderWireSnapshot } from '../../types/bridge.js';

const grok: ProviderWireSnapshot = {
  definition: { providerDriverKind: 'grok', providerInstanceId: 'grok', displayName: 'Grok' },
  revision: 1,
  readiness: 'ready',
  models: [
    {
      id: 'grok-build',
      displayName: 'Grok Build',
      isDefault: true,
      supportedReasoningEfforts: [],
    },
  ],
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

test('providers.updated replaces the snapshot list and draft harness restores its model', () => {
  const fromEvent = adaptEvent({ type: 'providers.updated', snapshots: [grok] });
  assert.deepEqual(fromEvent, { type: 'PROVIDERS_UPDATED', snapshots: [grok] });
  const withSnapshots = reducer(initialState, {
    type: 'PROVIDERS_UPDATED',
    snapshots: [grok],
  });
  assert.equal(withSnapshots.providerSnapshots[0]?.definition.providerInstanceId, 'grok');
  const switched = reducer(withSnapshots, {
    type: 'SET_DRAFT_PROVIDER',
    providerInstanceId: 'grok',
    modelId: 'grok-build',
  });
  assert.equal(switched.draftProviderInstanceId, 'grok');
  assert.equal(switched.agentConfig.primary.modelId, 'grok-build');
});
