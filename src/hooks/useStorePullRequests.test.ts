import assert from 'node:assert/strict';
import test from 'node:test';
import { initialState, reducer } from './useStore';
import type { SessionSummary } from '../types/bridge';

function session(appSessionId: string): SessionSummary {
  return {
    appSessionId,
    providerSessionId: `provider-${appSessionId}`,
    sessionPurpose: 'chat',
    interactionMode: 'auto',
    role: 'primary',
    title: appSessionId,
    goal: appSessionId,
    cwd: '/workspace',
    autonomy: 'low',
    phase: 'paused',
    features: [],
    tokensIn: 0,
    tokensOut: 0,
    contextTokens: 0,
    createdAt: 1,
    updatedAt: 1,
  };
}

test('OPEN_PULL_REQUESTS binds the view and optional number', () => {
  const state = reducer(initialState, {
    type: 'OPEN_PULL_REQUESTS',
    cwd: '/repo',
    number: 12,
  });
  assert.equal(state.mainView, 'pull-requests');
  assert.equal(state.prWorkspaceCwd, '/repo');
  assert.equal(state.prWorkspaceNumber, 12);
});

test('CLOSE_PULL_REQUESTS leaves the bind in place', () => {
  const open = reducer(initialState, {
    type: 'OPEN_PULL_REQUESTS',
    cwd: '/repo',
    number: 12,
  });
  const closed = reducer(open, { type: 'CLOSE_PULL_REQUESTS' });
  assert.equal(closed.mainView, 'session');
  assert.equal(closed.prWorkspaceCwd, '/repo');
  assert.equal(closed.prWorkspaceNumber, 12);
});

test('selecting a session or starting a chat leaves the workspace', () => {
  const open = reducer(
    { ...initialState, sessions: { a: session('a') }, sessionOrder: ['a'] },
    { type: 'OPEN_PULL_REQUESTS', cwd: '/repo' },
  );
  const selected = reducer(open, { type: 'SET_ACTIVE_SESSION', id: 'a' });
  assert.equal(selected.mainView, 'session');
  assert.equal(selected.prWorkspaceCwd, '/repo');
  const started = reducer(open, {
    type: 'START_CHAT',
    cwd: '/repo',
    executionMode: 'local',
  });
  assert.equal(started.mainView, 'session');
});
