import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, reducer } from './useStore';

test('new workspace chats retain their explicit execution mode', () => {
  const state = reducer(initialState, {
    type: 'START_CHAT',
    cwd: '/repo',
    executionMode: 'worktree',
    branch: 'main',
  });

  assert.deepEqual(state.draftChat, {
    cwd: '/repo',
    executionMode: 'worktree',
    branch: 'main',
  });
});

test('a workspace-less chat drops the previous folder and leaves the pull request workspace', () => {
  const inWorkspace = reducer(
    reducer(initialState, { type: 'START_CHAT', cwd: '/repo', executionMode: 'worktree' }),
    { type: 'OPEN_PULL_REQUESTS', cwd: '/repo' },
  );

  const state = reducer(inWorkspace, { type: 'START_CHAT', cwd: '', executionMode: 'local' });

  assert.deepEqual(state.draftChat, { cwd: '', executionMode: 'local', branch: undefined });
  assert.equal(state.mainView, 'session');
});

test('REMOVE_WORKSPACE drops a listed folder and is a no-op for unknown paths', () => {
  const added = reducer(initialState, { type: 'ADD_WORKSPACE', cwd: '/repo/app' });
  const withSite = reducer(added, { type: 'ADD_WORKSPACE', cwd: '/repo/site' });
  const removed = reducer(withSite, { type: 'REMOVE_WORKSPACE', cwd: '/repo/app' });
  assert.deepEqual(removed.workspaceCwds, ['/repo/site']);
  assert.deepEqual(
    reducer(removed, { type: 'REMOVE_WORKSPACE', cwd: '/repo/gone' }).workspaceCwds,
    ['/repo/site'],
  );
});
