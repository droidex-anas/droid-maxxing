import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeSessionContext, SessionContextCache } from './sessionContexts.js';

test('observed session updates preserve omitted fields and apply explicit clears', () => {
  const contexts = new SessionContextCache();
  contexts.observe({
    appSessionId: 'session-1',
    cwd: '/repo with spaces ',
    modelId: 'model-a',
    reasoningEffort: 'high',
    autonomy: 'medium',
  });
  contexts.observe({
    appSessionId: 'session-1',
    modelId: null,
    reasoningEffort: null,
  });

  assert.deepEqual(contexts.get('session-1'), {
    cwd: '/repo with spaces ',
    modelId: null,
    reasoningEffort: null,
    autonomy: 'medium',
  });
});

test('resolved session context is authoritative even when fields are null', () => {
  assert.deepEqual(
    mergeSessionContext(
      {
        cwd: '/observed',
        modelId: 'model-a',
        reasoningEffort: 'high',
        autonomy: 'medium',
      },
      {
        cwd: null,
        modelId: null,
        reasoningEffort: null,
        autonomy: 'low',
      },
    ),
    {
      cwd: null,
      modelId: null,
      reasoningEffort: null,
      autonomy: 'low',
    },
  );
});
