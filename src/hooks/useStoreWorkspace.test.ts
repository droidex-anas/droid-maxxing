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
