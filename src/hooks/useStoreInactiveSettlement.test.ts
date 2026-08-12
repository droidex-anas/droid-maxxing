import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChildSessionSummary, SessionSummary, TranscriptEvent } from '../types/bridge';
import { estimateTranscriptCost } from '../lib/transcriptWindow';
import { initialState, reducer, type AppState } from './useStore';

function session(
  appSessionId: string,
  streaming: boolean,
  updatedAt = streaming ? 1 : 2,
): SessionSummary {
  return {
    appSessionId,
    sessionPurpose: 'chat',
    interactionMode: 'auto',
    role: 'primary',
    title: appSessionId,
    goal: '',
    cwd: '/tmp',
    autonomy: 'off',
    phase: streaming ? 'running' : 'completed',
    streaming,
    features: [],
    tokensIn: 0,
    tokensOut: 0,
    contextTokens: 0,
    createdAt: 1,
    updatedAt,
  };
}

function childSession(
  parentAppSessionId: string,
  childSessionId: string,
  status: ChildSessionSummary['status'],
): ChildSessionSummary {
  return {
    parentAppSessionId,
    childSessionId,
    role: 'worker',
    status,
    modelId: 'model',
    transcriptAvailable: true,
  };
}

function events(
  appSessionId: string,
  sourceSessionId: string,
  role: TranscriptEvent['role'],
): TranscriptEvent[] {
  return Array.from({ length: 1_000 }, (_, index) => {
    const event: TranscriptEvent = {
      id: `${sourceSessionId}-${index}`,
      appSessionId,
      sourceSessionId,
      role,
      kind: 'text',
      text: `event ${index} ${'payload '.repeat(16)}`,
      ts: index,
    };
    if (index % 100 === 0) event.author = 'user';
    return event;
  });
}

function stateWithTranscript(
  appSessionId: string,
  transcript: TranscriptEvent[],
  overrides: Partial<AppState>,
): AppState {
  return {
    ...initialState,
    sessionOrder: [appSessionId],
    activeAppSessionId: appSessionId,
    transcripts: { [appSessionId]: transcript },
    transcriptRetainedCost: { [appSessionId]: estimateTranscriptCost(transcript) },
    transcriptViewportPinned: { [appSessionId]: true },
    historyLoaded: { [appSessionId]: true },
    sessionRestore: {
      [appSessionId]: {
        status: 'loaded',
        loadedCount: transcript.length,
        hasMore: false,
      },
    },
    ...overrides,
  };
}

test('a live primary session settling in the background receives the inactive limit', () => {
  const transcript = events('outgoing', 'primary', 'primary');
  let state = stateWithTranscript('outgoing', transcript, {
    sessions: {
      outgoing: session('outgoing', true),
      incoming: session('incoming', false),
    },
    sessionOrder: ['incoming', 'outgoing'],
  });

  state = reducer(state, { type: 'SET_ACTIVE_SESSION', id: 'incoming' });
  assert.equal(state.transcripts.outgoing.length, transcript.length);

  const next = reducer(state, {
    type: 'SESSION_UPDATED',
    session: session('outgoing', false),
  });

  assert.ok(next.transcripts.outgoing.length < transcript.length);
  assert.equal(next.transcripts.outgoing.at(-1)?.id, transcript.at(-1)?.id);
  assert.equal(next.historyLoaded.outgoing, false);
  assert.equal(next.sessionRestore.outgoing?.hasMore, true);
});

test('a stale terminal primary update cannot release a newer live transcript', () => {
  const transcript = events('outgoing', 'primary', 'primary');
  const state = stateWithTranscript('outgoing', transcript, {
    sessions: {
      outgoing: session('outgoing', true, 3),
      incoming: session('incoming', false),
    },
    sessionOrder: ['incoming', 'outgoing'],
    activeAppSessionId: 'incoming',
  });

  const next = reducer(state, {
    type: 'SESSION_UPDATED',
    session: session('outgoing', false, 2),
  });

  assert.equal(next.transcripts.outgoing.length, transcript.length);
  assert.equal(next.historyLoaded.outgoing, true);
  assert.equal(next.sessionRestore.outgoing?.hasMore, false);
});

test('an unopened running child settling in the background receives the inactive limit', () => {
  const primary: TranscriptEvent = {
    id: 'primary-0',
    appSessionId: 'parent',
    sourceSessionId: 'primary',
    role: 'primary',
    kind: 'text',
    text: 'parent',
    ts: 0,
  };
  const childTranscript = events('parent', 'child-a', 'worker');
  let state = stateWithTranscript('parent', [primary, ...childTranscript], {
    sessions: {
      parent: session('parent', false),
      incoming: session('incoming', false),
    },
    sessionOrder: ['incoming', 'parent'],
    childSessions: {
      parent: {
        'child-a': childSession('parent', 'child-a', 'running'),
      },
    },
    childRuntime: {
      parent: {
        'child-a': {
          available: true,
          runtimeGeneration: 1,
        },
      },
    },
  });

  state = reducer(state, { type: 'SET_ACTIVE_SESSION', id: 'incoming' });
  assert.equal(state.childHistory.parent, undefined);
  assert.equal(
    state.transcripts.parent.filter((event) => event.sourceSessionId === 'child-a').length,
    childTranscript.length,
  );

  const next = reducer(state, {
    type: 'SESSION_CHILD',
    child: childSession('parent', 'child-a', 'completed'),
    runtimeAvailable: false,
    runtimeGeneration: 2,
  });
  const retained = next.transcripts.parent.filter((event) => event.sourceSessionId === 'child-a');

  assert.ok(retained.length < childTranscript.length);
  assert.equal(retained.at(-1)?.id, childTranscript.at(-1)?.id);
  assert.equal(next.childHistory.parent['child-a'].isLoaded, false);
  assert.equal(next.childHistory.parent['child-a'].isViewportPinned, true);
  assert.equal(next.historyLoaded.parent, true);
});
