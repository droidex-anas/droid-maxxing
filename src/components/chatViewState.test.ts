import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, type AppState } from '../hooks/useStore';
import type { SessionSummary } from '../types/bridge';
import { equalVisibleChatState, selectChatViewState } from './chatViewState';

function session(appSessionId: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    appSessionId,
    sessionPurpose: 'chat',
    interactionMode: 'auto',
    role: 'primary',
    title: appSessionId,
    goal: '',
    cwd: '/tmp/project',
    autonomy: 'off',
    phase: 'completed',
    features: [],
    tokensIn: 0,
    tokensOut: 0,
    contextTokens: 0,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

function activeState(): AppState {
  return {
    ...initialState,
    activeAppSessionId: 'active',
    sessions: {
      active: session('active'),
      background: session('background'),
    },
    transcripts: {
      active: [],
      background: [],
    },
  };
}

test('chat selector ignores background session stream updates', () => {
  const previous = activeState();
  const next: AppState = {
    ...previous,
    transcripts: {
      ...previous.transcripts,
      background: [...previous.transcripts.background],
    },
    transcriptRetainedCost: {
      ...previous.transcriptRetainedCost,
      background: 10,
    },
    transcriptMutations: {
      background: {
        revision: 1,
        baseRevision: 0,
        kind: 'append',
        previousLength: 0,
        firstChangedIndex: 0,
      },
    },
  };

  assert.equal(
    equalVisibleChatState(selectChatViewState(previous), selectChatViewState(next)),
    true,
  );
});

test('chat selector observes active transcript provenance updates', () => {
  const previous = activeState();
  const next: AppState = {
    ...previous,
    transcriptMutations: {
      active: {
        revision: 1,
        baseRevision: 0,
        kind: 'append',
        previousLength: 0,
        firstChangedIndex: 0,
      },
    },
  };

  assert.equal(
    equalVisibleChatState(selectChatViewState(previous), selectChatViewState(next)),
    false,
  );
});

test('chat selector observes active transcript updates', () => {
  const previous = activeState();
  const next: AppState = {
    ...previous,
    transcripts: {
      ...previous.transcripts,
      active: [...previous.transcripts.active],
    },
  };

  assert.equal(
    equalVisibleChatState(selectChatViewState(previous), selectChatViewState(next)),
    false,
  );
});

test('chat selector ignores telemetry-only session summary updates', () => {
  const previous = activeState();
  const next: AppState = {
    ...previous,
    sessions: {
      ...previous.sessions,
      active: session('active', { tokensOut: 10, updatedAt: 2_000 }),
    },
  };

  assert.equal(
    equalVisibleChatState(selectChatViewState(previous), selectChatViewState(next)),
    true,
  );
});

test('chat selector observes visible session title updates', () => {
  const previous = activeState();
  const next: AppState = {
    ...previous,
    sessions: {
      ...previous.sessions,
      active: session('active', { title: 'Renamed' }),
    },
  };

  assert.equal(
    equalVisibleChatState(selectChatViewState(previous), selectChatViewState(next)),
    false,
  );
});
