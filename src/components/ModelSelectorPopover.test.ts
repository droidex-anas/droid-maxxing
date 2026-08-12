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
import type { ModelInfo } from '../types/bridge.js';
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
  assert.equal((html.match(/aria-pressed="true"/g) ?? []).length, 1);
  assert.equal((html.match(/aria-pressed="false"/g) ?? []).length, 1);
});
