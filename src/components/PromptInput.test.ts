import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldShowTurnStarting, shouldStopTurnStarting } from './PromptInput';

test('turn-start feedback does not replace controls for an already-live target', () => {
  assert.equal(shouldShowTurnStarting(false), true);
  assert.equal(shouldShowTurnStarting(true), false);
});

test('turn-start feedback settles when creation fails or the visible target changes', () => {
  const pendingCompose = { 'client-1': {} };
  const base = {
    isLive: false,
    startingTargetKey: 'chat-draft',
    visibleTargetKey: 'chat-draft',
    pendingClientRef: 'client-1',
    pendingWasRegistered: true,
    pendingCompose,
    lastCreatedSessionRequest: null,
  };

  assert.equal(shouldStopTurnStarting(base), false);
  assert.equal(shouldStopTurnStarting({ ...base, pendingCompose: {} }), true);
  assert.equal(shouldStopTurnStarting({ ...base, visibleTargetKey: 'primary:s2' }), true);
  assert.equal(
    shouldStopTurnStarting({
      ...base,
      pendingCompose: {},
      visibleTargetKey: 'primary:created-session',
      lastCreatedSessionRequest: {
        clientRef: 'client-1',
        appSessionId: 'created-session',
      },
    }),
    false,
  );
  assert.equal(
    shouldStopTurnStarting({
      ...base,
      pendingCompose: {},
      visibleTargetKey: 'primary:unrelated-session',
      lastCreatedSessionRequest: {
        clientRef: 'client-1',
        appSessionId: 'created-session',
      },
    }),
    true,
  );
});
