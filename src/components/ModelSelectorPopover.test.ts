import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  initialState,
  StaticStoreProvider,
  StoreProvider,
  type AppState,
} from '../hooks/useStore.js';
import type { ExactChildSettingsTarget } from '../lib/exactChildSettings.js';
import type { ModelInfo, ProviderWireSnapshot, SessionSummary } from '../types/bridge.js';
import { droidSessionConfiguration } from '../lib/sessionConfiguration.js';
import ModelSelectorPopover from './ModelSelectorPopover.js';

function renderTarget(readiness: ExactChildSettingsTarget['readiness']): string {
  const target: ExactChildSettingsTarget = {
    parentAppSessionId: 'parent-a',
    childSessionId: 'validator-logical',
    role: 'validator',
    label: 'Sub-agent 2',
    modelId: 'validator-model',
    reasoningEffort: 'high',
    readiness,
  };
  return renderToStaticMarkup(
    createElement(
      StoreProvider,
      null,
      createElement(ModelSelectorPopover, {
        childTarget: target,
        onClose: () => undefined,
      }),
    ),
  );
}

test('exact child editor labels readiness and keeps standalone reasoning disabled', () => {
  const opening = renderTarget('opening');
  assert.match(opening, /Sub-agent 2/);
  assert.match(opening, /Opening child…/);
  assert.match(opening, /Change the child model to adjust reasoning/);

  const ready = renderTarget('ready');
  assert.match(ready, /Sub-agent 2/);
  assert.match(ready, /Validator model/);
  assert.match(ready, /Change the child model to adjust reasoning/);
  assert.equal(
    (opening.match(/disabled=""/g) ?? []).length,
    (ready.match(/disabled=""/g) ?? []).length + 1,
  );

  const unavailable = renderTarget('failed');
  assert.match(unavailable, /Child unavailable/);
  assert.equal(
    (unavailable.match(/disabled=""/g) ?? []).length,
    (opening.match(/disabled=""/g) ?? []).length,
  );
});

test('a dangling active session id keeps using the visible global defaults', () => {
  const model: ModelInfo = {
    id: 'global-model',
    displayName: 'Global Model',
    provider: 'factory',
    supportedReasoningEfforts: ['low', 'high'],
    defaultReasoningEffort: 'high',
  };
  const state: AppState = {
    ...initialState,
    activeAppSessionId: 'missing-session',
    sessions: {},
    models: [model],
    agentConfig: {
      ...initialState.agentConfig,
      primary: { modelId: model.id, reasoning: 'low' },
    },
  };
  const html = renderToStaticMarkup(
    createElement(
      StaticStoreProvider,
      { state, dispatch: () => undefined },
      createElement(ModelSelectorPopover, {
        singleAgent: true,
        onClose: () => undefined,
      }),
    ),
  );

  assert.match(html, /Search models · Global Model/);
  assert.match(html, /Reasoning<\/span><span[^>]*>low<\/span>/);
  assert.equal((html.match(/aria-pressed="true"/g) ?? []).length, 2);
  assert.equal((html.match(/aria-pressed="false"/g) ?? []).length, 5);
  assert.match(html, /data-testid="harness-strip"/);
});

function grokSnapshot(): ProviderWireSnapshot {
  return {
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
}

test('a Grok draft lists Grok models and hides Droid reasoning and Factory default', () => {
  const droidModel: ModelInfo = {
    id: 'droid-core',
    displayName: 'Droid Core',
    provider: 'droid-core',
    isCustom: false,
    supportedReasoningEfforts: ['low', 'high'],
    defaultReasoningEffort: 'high',
  };
  const state: AppState = {
    ...initialState,
    draftProviderInstanceId: 'grok',
    models: [droidModel],
    providerSnapshots: [grokSnapshot()],
    agentConfig: {
      ...initialState.agentConfig,
      primary: { modelId: 'grok-build', reasoning: 'high' },
    },
  };
  const html = renderToStaticMarkup(
    createElement(
      StaticStoreProvider,
      { state, dispatch: () => undefined },
      createElement(ModelSelectorPopover, {
        singleAgent: true,
        onClose: () => undefined,
      }),
    ),
  );
  assert.match(html, /Grok Build/);
  assert.doesNotMatch(html, /Droid Core/);
  assert.doesNotMatch(html, /Use Factory CLI default/);
  assert.doesNotMatch(html, />Reasoning</);
  assert.match(html, /data-harness="grok"[^>]*aria-pressed="true"/);
});

test('a live session locks the harness strip', () => {
  const session: SessionSummary = {
    appSessionId: 'sess-live',
    sessionPurpose: 'chat',
    role: 'primary',
    title: 'Live',
    goal: '',
    cwd: '',
    configuration: droidSessionConfiguration({
      modelId: 'droid-core',
      interactionMode: 'auto',
      autonomy: 'off',
    }),
    phase: 'running',
    features: [],
    tokensIn: 0,
    tokensOut: 0,
    contextTokens: 0,
    createdAt: 1,
    updatedAt: 1,
  };
  const state: AppState = {
    ...initialState,
    activeAppSessionId: session.appSessionId,
    sessions: { [session.appSessionId]: session },
    models: [
      {
        id: 'droid-core',
        displayName: 'Droid Core',
        isCustom: false,
        supportedReasoningEfforts: ['low', 'high'],
        defaultReasoningEffort: 'high',
      },
    ],
  };
  const html = renderToStaticMarkup(
    createElement(
      StaticStoreProvider,
      { state, dispatch: () => undefined },
      createElement(ModelSelectorPopover, {
        singleAgent: true,
        onClose: () => undefined,
      }),
    ),
  );
  assert.match(html, /Harness is locked after the first prompt/);
});
