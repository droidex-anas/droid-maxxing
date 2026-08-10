import test from 'node:test';
import assert from 'node:assert';
import { initialState, reducer } from './useStore';

test('workspace discovery replaces physical worktree entries with canonical repositories', () => {
  const state = reducer(
    { ...initialState, workspaceCwds: ['/repo/.worktrees/chat-1', '/other'] },
    { type: 'SET_WORKSPACE_CWDS', cwds: ['/repo', '/other'] },
  );

  assert.deepEqual(state.workspaceCwds, ['/repo', '/other']);
});

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
