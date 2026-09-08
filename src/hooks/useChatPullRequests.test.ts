import assert from 'node:assert/strict';
import test from 'node:test';
import { initialState, reducer } from './useStore';
import { createTargetKeySelector } from './useChatPullRequests';
import type { SessionSummary } from '../types/bridge';

test('discovery target keys ignore token changes and change for cwd, visibility, and active chat', () => {
  const session: SessionSummary = {
    appSessionId: 'chat',
    title: 'Chat',
    goal: '',
    cwd: '/worktree',
    sessionPurpose: 'chat',
    interactionMode: 'auto',
    role: 'primary',
    autonomy: 'off',
    phase: 'completed',
    createdAt: 1,
    updatedAt: 1,
    features: [],
    tokensIn: 0,
    tokensOut: 0,
    contextTokens: 0,
  };
  const state = { ...initialState, sessions: { chat: session }, chatMetadata: {} };
  const select = createTargetKeySelector();
  const key = select(state);
  assert.equal(select({ ...state, sessions: { chat: { ...session, tokensIn: 100 } } }), key);
  assert.notEqual(select({ ...state, sessions: { chat: { ...session, cwd: '/other' } } }), key);
  assert.notEqual(select(reducer(state, { type: 'ARCHIVE_CHAT', appSessionId: 'chat' })), key);
  assert.notEqual(select({ ...state, activeAppSessionId: 'chat' }), key);
});
