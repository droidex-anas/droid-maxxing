import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, reducer, type AppState } from './useStore';
import type { SessionSummary } from '../types/bridge';

function session(appSessionId: string, updatedAt: number): SessionSummary {
  return {
    appSessionId,
    sessionPurpose: 'chat',
    interactionMode: 'auto',
    role: 'primary',
    title: appSessionId,
    goal: '',
    cwd: '',
    autonomy: 'off',
    phase: 'completed',
    features: [],
    tokensIn: 0,
    tokensOut: 0,
    contextTokens: 0,
    createdAt: 1_000,
    updatedAt,
  };
}

test('mark all sessions read advances every current session without changing session state', () => {
  const state: AppState = {
    ...initialState,
    sessions: {
      'sess-a': session('sess-a', 3_000),
      'sess-b': session('sess-b', 7_000),
    },
    sessionOrder: ['sess-a', 'sess-b'],
    sessionLastSeen: { 'sess-a': 1_000, 'closed-session': 2_000 },
  };

  const next = reducer(state, { type: 'MARK_ALL_SESSIONS_READ', seenAt: 5_000 });

  assert.equal(next.sessionLastSeen['sess-a'], 5_000);
  assert.equal(next.sessionLastSeen['sess-b'], 7_000);
  assert.equal(next.sessionLastSeen['closed-session'], 2_000);
  assert.equal(next.sessions, state.sessions);
  assert.equal(next.sessionOrder, state.sessionOrder);
});

test('mark all sessions read ignores stale IDs in session order', () => {
  const state: AppState = {
    ...initialState,
    sessions: { 'sess-a': session('sess-a', 3_000) },
    sessionOrder: ['removed-session', 'sess-a'],
    sessionLastSeen: {},
  };

  const next = reducer(state, { type: 'MARK_ALL_SESSIONS_READ', seenAt: 5_000 });

  assert.deepEqual(next.sessionLastSeen, { 'sess-a': 5_000 });
});

test('batched actions preserve sequential reducer ordering', () => {
  const state: AppState = {
    ...initialState,
    sessions: {
      'sess-a': session('sess-a', 3_000),
      'sess-b': session('sess-b', 7_000),
    },
    sessionOrder: ['sess-a', 'sess-b'],
    sessionLastSeen: {},
  };
  const actions = [
    {
      type: 'QUEUE_PROMPT' as const,
      appSessionId: 'sess-a',
      prompt: { id: 'prompt-1', text: 'queued', skills: [], files: [] },
    },
    { type: 'REMOVE_QUEUED_PROMPT' as const, appSessionId: 'sess-a', id: 'prompt-1' },
  ];

  const sequential = actions.reduce(reducer, state);
  const batched = reducer(state, { type: 'BATCH', actions });

  assert.deepEqual(batched, sequential);
});

test('session creation records the exact request-to-session settlement', () => {
  const state: AppState = {
    ...initialState,
    pendingCompose: {
      'client-1': { text: 'hello', skills: [], files: [] },
    },
  };

  const created = reducer(state, {
    type: 'SESSION_CREATED',
    clientRef: 'client-1',
    session: session('created-session', 3_000),
  });

  assert.deepEqual(created.lastCreatedSessionRequest, {
    clientRef: 'client-1',
    appSessionId: 'created-session',
  });
  assert.equal(created.pendingCompose['client-1'], undefined);
});
