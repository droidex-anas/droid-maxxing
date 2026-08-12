import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitializeSessionParams, waitForSessionInitialization } from './DroidRuntime.js';

test('passes compaction settings when initializing a session', () => {
  const params = createInitializeSessionParams({
    cwd: '/tmp/project',
    interactionMode: 'auto',
    modelId: 'main-model',
    compactionModel: 'summary-model',
    compactionTokenLimit: 400_000,
  });

  assert.equal(params.compactionModel, 'summary-model');
  assert.equal(params.compactionTokenLimit, 400_000);
});

test('passes current-model compaction sentinel when initializing a session', () => {
  const params = createInitializeSessionParams({
    cwd: '/tmp/project',
    interactionMode: 'auto',
    modelId: 'main-model',
    compactionModel: 'current-model',
  });

  assert.equal(params.compactionModel, 'current-model');
});

test('allows a healthy Droid session initialization to take 30 seconds', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = waitForSessionInitialization(
    new Promise<string>((resolve) => {
      setTimeout(() => resolve('ready'), 30_000);
    }),
    'initialize_session',
  );
  t.mock.timers.tick(30_000);

  assert.equal(await pending, 'ready');
});
