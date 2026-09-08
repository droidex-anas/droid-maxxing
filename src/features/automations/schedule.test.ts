import assert from 'node:assert/strict';
import test from 'node:test';
import type { ModelInfo } from '../../types/bridge';
import {
  defaultAutomationDraft,
  epochFromZonedInput,
  supportedTimeZones,
  validateAutomationDraft,
} from './schedule';

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

test('zoned input rejects a nonexistent DST-gap time and preserves the first fallback occurrence', () => {
  assert.equal(
    epochFromZonedInput({ year: 2025, month: 3, day: 9, hour: 2, minute: 30 }, 'America/New_York'),
    null,
  );
  assert.equal(
    epochFromZonedInput({ year: 2025, month: 11, day: 2, hour: 1, minute: 30 }, 'America/New_York'),
    Date.UTC(2025, 10, 2, 5, 30),
  );
});

test('timezone options always include UTC', () => {
  assert.ok(supportedTimeZones().includes('UTC'));
});
