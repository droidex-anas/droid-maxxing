import assert from 'node:assert/strict';
import test from 'node:test';
import { buildThreadInput, selectionCatalog, type ThreadSelection } from './useThreadSelection';
import { projectSession } from './sessions';
import type { ProviderStatus } from '../../types/bridge';

const selection: ThreadSelection = {
  provider: 'codex',
  modelId: '',
  reasoning: 'high',
  autonomy: 'low',
};
const status: ProviderStatus = {
  provider: 'codex',
  readiness: 'ready',
  defaultModelId: 'code',
  models: [
    {
      id: 'code',
      displayName: 'Code',
      isCustom: false,
      supportedReasoningEfforts: ['low', 'high'],
    },
  ],
};

test('draft input follows this harness catalog and includes only a supported reasoning choice', () => {
  const catalog = selectionCatalog(selection, [status]);
  const input = buildThreadInput(
    { title: ' ', prompt: '  Build the parser\nCheck it. ', workspace: ' /workspace ' },
    selection,
    catalog,
  );
  assert.deepEqual(input, {
    title: 'Build the parser',
    prompt: 'Build the parser\nCheck it.',
    provider: 'codex',
    autonomy: 'low',
    cwd: '/workspace',
    modelId: 'code',
    reasoningEffort: 'high',
  });
});

test('a missing model never inherits a different model’s reasoning capabilities', () => {
  const value = { ...selection, modelId: 'custom' };
  const input = buildThreadInput(
    { title: 'Task', prompt: 'Work', workspace: '' },
    value,
    selectionCatalog(value, [status]),
  );
  assert.equal(input.modelId, 'custom');
  assert.equal(Object.hasOwn(input, 'reasoningEffort'), false);
  assert.equal(Object.hasOwn(input, 'cwd'), false);
});

test('missing saved session IDs stay explicit rather than claiming a live conversation', () => {
  assert.equal(projectSession({}, 'missing'), undefined);
  assert.equal(projectSession({}, null), undefined);
});
