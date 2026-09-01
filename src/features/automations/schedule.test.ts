import assert from 'node:assert/strict';
import test from 'node:test';
import type { ModelInfo } from '../../types/bridge';
import { defaultAutomationDraft, validateAutomationDraft } from './schedule';

const MODELS: ModelInfo[] = [
  {
    id: 'model-a',
    displayName: 'Model A',
    isCustom: false,
    isDefault: true,
    supportedReasoningEfforts: ['low', 'medium', 'high'],
    defaultReasoningEffort: 'high',
  },
];

test('draft validation rejects a past one-time schedule and keeps a catalog-missing custom model', () => {
  const draft = defaultAutomationDraft(null, 'model-a', 'medium');
  draft.title = 'Past';
  draft.prompt = 'Run something';
  draft.schedule = { kind: 'once', runAt: Date.now() - 1 };
  assert.equal(validateAutomationDraft(draft, MODELS), 'Choose a future date and time.');

  draft.schedule = { kind: 'daily', time: '09:00' };
  draft.modelId = 'custom:byok';
  assert.equal(validateAutomationDraft(draft, MODELS), null);
});
