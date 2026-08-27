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

test('OPEN_PULL_REQUESTS preserves an omitted number only within the same repository', () => {
  const selected = reducer(initialState, {
    type: 'OPEN_PULL_REQUESTS',
    cwd: '/repo-a',
    number: 12,
  });
  const sameRepository = reducer(selected, {
    type: 'OPEN_PULL_REQUESTS',
    cwd: '/repo-a',
  });
  assert.equal(sameRepository.prWorkspaceNumber, 12);

  const differentRepository = reducer(sameRepository, {
    type: 'OPEN_PULL_REQUESTS',
    cwd: '/repo-b',
  });
  assert.equal(differentRepository.prWorkspaceCwd, '/repo-b');
  assert.equal(differentRepository.prWorkspaceNumber, null);
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

test('backlog ids move and restore without duplicating', () => {
  const moved = reducer(initialState, { type: 'MOVE_PR_TO_BACKLOG', id: 'acme/app#12' });
  assert.deepEqual(moved.prBacklogIds, ['acme/app#12']);
  const again = reducer(moved, { type: 'MOVE_PR_TO_BACKLOG', id: 'acme/app#12' });
  assert.equal(again, moved);
  const restored = reducer(moved, { type: 'RESTORE_PR_FROM_BACKLOG', id: 'acme/app#12' });
  assert.deepEqual(restored.prBacklogIds, []);
});

test('backlog additions that cannot persist are ignored', () => {
  const oversized = reducer(initialState, {
    type: 'MOVE_PR_TO_BACKLOG',
    id: `/${'a'.repeat(200)}#1`,
  });
  assert.equal(oversized, initialState);
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

test('a pull request chat draft targets its repository before composer text is seeded', () => {
  const open = reducer(
    {
      ...initialState,
      sessions: { a: session('a') },
      sessionOrder: ['a'],
      activeAppSessionId: 'a',
    },
    { type: 'OPEN_PULL_REQUESTS', cwd: '/repo' },
  );
  const started = reducer(open, {
    type: 'START_CHAT',
    cwd: '/repo',
    executionMode: 'local',
  });
  const seeded = reducer(started, {
    type: 'SEED_COMPOSER',
    text: 'Help me with PR #12',
  });

  assert.equal(seeded.activeAppSessionId, null);
  assert.deepEqual(seeded.draftChat, {
    cwd: '/repo',
    executionMode: 'local',
    branch: undefined,
  });
  assert.equal(seeded.composerSeed?.text, 'Help me with PR #12');
  assert.equal(seeded.mainView, 'session');
});
