import assert from 'node:assert/strict';
import test from 'node:test';
import type { ModelInfo } from '../../types/bridge';
import {
  automationModelSelectionIssue,
  reasoningForModel,
  validateAutomationModelSelection,
} from './modelSelection';

const catalogModel = (overrides: Partial<ModelInfo> = {}): ModelInfo => ({
  id: 'glm-5',
  displayName: 'GLM-5',
  isCustom: false,
  supportedReasoningEfforts: ['low', 'medium', 'high'],
  defaultReasoningEffort: 'medium',
  ...overrides,
});

test('a catalog-missing custom model is a real selection, not a save blocker', () => {
  const catalog = [catalogModel()];
  assert.equal(validateAutomationModelSelection(catalog, 'custom:byok', 'high'), null);
  assert.equal(automationModelSelectionIssue(catalog, 'custom:byok', 'high'), null);
});

test('an empty catalog does not block a concrete custom selection while models load', () => {
  assert.equal(validateAutomationModelSelection([], 'custom:byok', 'high'), null);
});

test('a catalog model still rejects a reasoning level it does not support', () => {
  const catalog = [catalogModel()];
  assert.match(
    validateAutomationModelSelection(catalog, 'glm-5', 'xhigh') ?? '',
    /does not support xhigh/,
  );
});

test('missing model or reasoning is still incomplete', () => {
  assert.equal(
    validateAutomationModelSelection([catalogModel()], null, 'high'),
    'Choose a model from your DROIDEX model catalog.',
  );
  assert.equal(
    validateAutomationModelSelection([catalogModel()], 'glm-5', null),
    'Choose a reasoning level for the model.',
  );
});

test('reasoningForModel keeps a supported level and falls back to the catalog default', () => {
  const model = catalogModel();
  assert.equal(reasoningForModel(model, 'high'), 'high');
  assert.equal(reasoningForModel(model, 'xhigh'), 'medium');
});

test('reasoningForModel ignores a catalog default the model does not support', () => {
  const model = catalogModel({
    supportedReasoningEfforts: ['low', 'high'],
    defaultReasoningEffort: 'medium',
  });
  assert.equal(reasoningForModel(model, null), 'high');
});
