import assert from 'node:assert/strict';
import test from 'node:test';

import { GROK_VERSION_TIMEOUT_MS } from './grokHandshake.js';
import {
  fallbackGrokModel,
  parseGenericCliVersion,
  parseGrokModelsFromSessionSetup,
  runGrokVersion,
} from './grokDiscovery.js';

test('parseGenericCliVersion reads the first semver from grok --version output', () => {
  assert.equal(parseGenericCliVersion('grok 1.2.3\n'), '1.2.3');
  assert.equal(parseGenericCliVersion('no version here'), null);
});

test('models come from sessionSetupResult and fall back to grok-build', () => {
  const models = parseGrokModelsFromSessionSetup({
    sessionId: 's1',
    models: {
      currentModelId: 'grok-4.6',
      availableModels: [
        { modelId: 'grok-build', name: 'Grok Build' },
        { modelId: 'grok-4.6', name: 'Grok 4.6' },
        { modelId: 'not a token', name: 'Bad' },
      ],
    },
  });
  assert.deepEqual(
    models.map((model) => model.id),
    ['grok-build', 'grok-4.6'],
  );
  assert.equal(models.find((model) => model.id === 'grok-4.6')?.isDefault, true);
  assert.deepEqual(parseGrokModelsFromSessionSetup({}), [fallbackGrokModel()]);
  assert.equal(
    parseGrokModelsFromSessionSetup({ models: { availableModels: [] } })[0]?.id,
    'grok-build',
  );
});

test('runGrokVersion uses --version and the 4000 ms budget', async () => {
  const calls: Array<{ args: readonly string[]; timeoutMs: number }> = [];
  await runGrokVersion({
    command: 'grok',
    timeoutMs: GROK_VERSION_TIMEOUT_MS,
    signal: new AbortController().signal,
    runCommand: async (input) => {
      calls.push({ args: input.args, timeoutMs: input.timeoutMs });
      return { stdout: 'grok 1.2.3\n', stderr: '', code: 0, timedOut: false };
    },
  });
  assert.deepEqual(calls, [{ args: ['--version'], timeoutMs: 4000 }]);
});
