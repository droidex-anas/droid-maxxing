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

test('exact child editor labels readiness and keeps per-row reasoning locked', () => {
  const opening = renderTarget('opening');
  assert.match(opening, /Sub-agent 2/);
  assert.match(opening, /Opening child…/);
  assert.match(opening, /Change the child model to adjust reasoning/);
  assert.doesNotMatch(opening, /Reasoning<\/span>/);
  assert.match(opening, /aria-disabled="true"/);

  const ready = renderTarget('ready');
  assert.match(ready, /Sub-agent 2/);
  assert.match(ready, /Validator model/);
  assert.match(ready, /Change the child model to adjust reasoning/);
  assert.doesNotMatch(ready, /aria-disabled="true"/);

  const unavailable = renderTarget('failed');
  assert.match(unavailable, /Child unavailable/);
  assert.match(unavailable, /aria-disabled="true"/);
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

  // The selected model names the popover; the search box stays a plain search box.
  assert.match(html, /placeholder="Search models"/);
  assert.match(html, /text-droid-text truncate"[^>]*>Global Model</);
  // The selected row shows the session's effort; the meter has one dot per supported effort.
  assert.match(html, /aria-selected="true"[\s\S]*?capitalize[^>]*>low<\/span>/);
  assert.equal((html.match(/aria-selected="true"/g) ?? []).length, 1);
  assert.equal((html.match(/aria-selected="false"/g) ?? []).length, 1);
  assert.equal((html.match(/w-\[9px\]/g) ?? []).length, 3);
});
