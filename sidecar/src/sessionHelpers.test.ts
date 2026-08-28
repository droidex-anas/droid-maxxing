import assert from 'node:assert/strict';
import test from 'node:test';

import type { ClientCommand, FactoryDefaultSettings, SessionSummary } from './protocol.js';
import {
  buildResumedSession,
  createMissionConfigurationForMode,
  createModelDefaultsForMode,
  defaultsModeForSummary,
  requireCreateConfiguration,
} from './sessionHelpers.js';
import { droidSessionConfiguration } from './providers/providerIdentity.js';

type SessionCreateCommand = Extract<ClientCommand, { type: 'session.create' }>;

function createCommand(
  configuration: SessionCreateCommand['configuration'],
  extras: Partial<Omit<SessionCreateCommand, 'type' | 'configuration'>> = {},
): SessionCreateCommand {
  return {
    type: 'session.create',
    clientRef: 'ref',
    title: 'title',
    goal: 'goal',
    sessionPurpose: extras.sessionPurpose ?? 'chat',
    configuration,
    ...extras,
  };
}

test('create requires a complete configuration and never falls back', () => {
  const configuration = droidSessionConfiguration({
    modelId: 'model-a',
    interactionMode: 'auto',
    autonomy: 'low',
  });
  assert.deepEqual(requireCreateConfiguration(createCommand(configuration)), configuration);
  assert.throws(() =>
    requireCreateConfiguration(
      createCommand({ interactionMode: 'auto', autonomy: 'low' } as never),
    ),
  );
  assert.throws(() =>
    requireCreateConfiguration(
      createCommand({
        ...configuration,
        autonomy: 'invalid' as never,
      }),
    ),
  );

  const defaults: Pick<
    FactoryDefaultSettings,
    | 'modelId'
    | 'reasoningEffort'
    | 'missionOrchestratorModelId'
    | 'missionOrchestratorReasoningEffort'
  > = {
    modelId: 'default-model',
    reasoningEffort: 'medium',
    missionOrchestratorModelId: 'mission-model',
    missionOrchestratorReasoningEffort: 'high',
  };
  assert.deepEqual(createModelDefaultsForMode('auto', {}, defaults), {
    modelId: 'default-model',
    reasoningEffort: 'medium',
  });
  assert.deepEqual(createModelDefaultsForMode('agi', {}, defaults), {
    modelId: 'mission-model',
    reasoningEffort: 'high',
  });
});

test('worker and validator defaults apply only to Mission Control sessions', () => {
  const defaults: Pick<
    FactoryDefaultSettings,
    'workerModelId' | 'workerReasoningEffort' | 'validatorModelId' | 'validatorReasoningEffort'
  > = {
    workerModelId: 'worker-default',
    workerReasoningEffort: 'medium',
    validatorModelId: 'validator-default',
    validatorReasoningEffort: 'high',
  };
  const agi = droidSessionConfiguration({
    modelId: 'model-a',
    interactionMode: 'agi',
    autonomy: 'high',
  });
  const custom = {
    worker: { modelId: 'worker-custom', reasoningEffort: 'low' as const },
    validator: { modelId: 'validator-default', reasoningEffort: 'high' as const },
  };

  assert.deepEqual(
    createMissionConfigurationForMode(
      'agi',
      createCommand(agi, {
        sessionPurpose: 'mission-control',
        droidMissionConfiguration: custom,
      }),
      defaults,
    ),
    custom,
  );
  assert.deepEqual(
    createMissionConfigurationForMode(
      'agi',
      createCommand(agi, { sessionPurpose: 'mission-control' }),
      defaults,
    ),
    {
      worker: { modelId: 'worker-default', reasoningEffort: 'medium' },
      validator: { modelId: 'validator-default', reasoningEffort: 'high' },
    },
  );
  assert.equal(
    createMissionConfigurationForMode(
      'auto',
      createCommand(
        droidSessionConfiguration({
          modelId: 'model-a',
          interactionMode: 'auto',
          autonomy: 'low',
        }),
      ),
      defaults,
    ),
    undefined,
  );
  assert.equal(
    createMissionConfigurationForMode(
      'spec',
      createCommand(
        droidSessionConfiguration({
          modelId: 'model-a',
          interactionMode: 'spec',
          autonomy: 'low',
        }),
      ),
      defaults,
    ),
    undefined,
  );
});

test('summary defaults depend on purpose and spec mode, not AGI interaction alone', () => {
  const ordinary: SessionSummary = {
    appSessionId: 'chat-app',
    providerSessionId: 'chat-provider',
    sessionPurpose: 'chat',
    role: 'primary',
    title: 'Chat',
    goal: 'Test defaults',
    cwd: '/workspace',
    workspaceKind: 'folder',
    configuration: droidSessionConfiguration({
      modelId: 'model-default',
      interactionMode: 'auto',
      autonomy: 'low',
    }),
    phase: 'paused',
    features: [],
    tokensIn: 0,
    tokensOut: 0,
    contextTokens: 0,
    createdAt: 1,
    updatedAt: 1,
  };

  assert.equal(
    defaultsModeForSummary({
      ...ordinary,
      configuration: { ...ordinary.configuration, interactionMode: 'agi' },
    }),
    'auto',
  );
  assert.equal(
    defaultsModeForSummary({
      ...ordinary,
      configuration: { ...ordinary.configuration, interactionMode: 'spec' },
    }),
    'spec',
  );
  assert.equal(
    defaultsModeForSummary({
      ...ordinary,
      sessionPurpose: 'mission-control',
      configuration: droidSessionConfiguration({
        modelId: 'model-default',
        interactionMode: 'agi',
        autonomy: 'low',
      }),
    }),
    'agi',
  );
});

test('cold resume preserves a persisted Mission Control proposal', () => {
  const historical: SessionSummary = {
    appSessionId: 'mission-app',
    providerSessionId: 'mission-provider',
    missionId: 'mission-id',
    sessionPurpose: 'mission-control',
    role: 'primary',
    title: 'Mission',
    goal: 'Complete the mission',
    cwd: '/workspace',
    workspaceKind: 'folder',
    configuration: droidSessionConfiguration({
      modelId: 'model-default',
      interactionMode: 'agi',
      autonomy: 'low',
    }),
    phase: 'paused',
    proposal: '# Persisted plan',
    features: [],
    tokensIn: 0,
    tokensOut: 0,
    contextTokens: 0,
    createdAt: 1,
    updatedAt: 1,
  };

  const resumed = buildResumedSession({
    init: { settings: { interactionMode: 'agi' } },
    historical,
    appSessionId: historical.appSessionId,
    providerSessionId: historical.providerSessionId ?? historical.appSessionId,
    defaults: {},
    maxContextTokensForModel: () => undefined,
    now: 2,
  });

  assert.equal(resumed.summary.proposal, '# Persisted plan');
});

test('resume keeps the historical updatedAt so reading never reorders the sidebar', () => {
  // Opening an old session resumes it in the background; that resume must not
  // stamp "now" into updatedAt or the session would jump to the top of the
  // list and read as unread in other windows.
  const historical: SessionSummary = {
    appSessionId: 'chat-app',
    providerSessionId: 'chat-provider',
    sessionPurpose: 'chat',
    role: 'primary',
    title: 'Chat',
    goal: 'Old conversation',
    cwd: '/workspace',
    workspaceKind: 'folder',
    configuration: droidSessionConfiguration({
      modelId: 'model-default',
      interactionMode: 'auto',
      autonomy: 'low',
    }),
    phase: 'paused',
    features: [],
    tokensIn: 0,
    tokensOut: 0,
    contextTokens: 0,
    createdAt: 100,
    updatedAt: 200,
  };

  const resumed = buildResumedSession({
    init: { settings: {} },
    historical,
    appSessionId: historical.appSessionId,
    providerSessionId: historical.providerSessionId ?? historical.appSessionId,
    defaults: {},
    maxContextTokensForModel: () => undefined,
    now: 999_999,
  });

  assert.equal(resumed.summary.updatedAt, 200);
  assert.equal(resumed.summary.createdAt, 100);
});

test('resume keeps an app-reanchored cwd instead of restoring stale provider metadata', () => {
  const historical: SessionSummary = {
    appSessionId: 'app-session',
    providerSessionId: 'provider-session',
    sessionPurpose: 'chat',
    role: 'primary',
    title: 'Recovered chat',
    goal: '',
    cwd: '/repo',
    workspaceKind: 'folder',
    configuration: droidSessionConfiguration({
      modelId: 'model-default',
      interactionMode: 'auto',
      autonomy: 'low',
    }),
    phase: 'paused',
    features: [],
    tokensIn: 0,
    tokensOut: 0,
    contextTokens: 0,
    createdAt: 1,
    updatedAt: 1,
  };

  const resumed = buildResumedSession({
    init: {
      cwd: '/repo/.worktrees/deleted',
      session: { cwd: '/repo/.worktrees/deleted' },
    },
    historical,
    appSessionId: historical.appSessionId,
    providerSessionId: historical.providerSessionId ?? historical.appSessionId,
    defaults: {},
    maxContextTokensForModel: () => undefined,
    now: 2,
  });

  assert.equal(resumed.summary.cwd, '/repo');
});

test('a child provider cannot be resumed as a top-level session', () => {
  assert.throws(
    () =>
      buildResumedSession({
        init: { session: { decompSessionType: 'worker' } },
        appSessionId: 'child-provider',
        providerSessionId: 'child-provider',
        defaults: {},
        maxContextTokensForModel: () => undefined,
        now: 1,
      }),
    /cannot be resumed as top-level/i,
  );
});
