import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, reducer, type AppState } from './useStore';
import type { SessionSummary, TranscriptEvent } from '../types/bridge';

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

test('batched transcript actions index the retained window once', () => {
  let retainedIdReads = 0;
  const retained: TranscriptEvent[] = Array.from({ length: 2_000 }, (_, index) => {
    const event: TranscriptEvent = {
      id: `retained-${index}`,
      appSessionId: 'sess-a',
      sourceSessionId: 'primary',
      role: 'primary',
      kind: 'text',
      author: 'assistant',
      text: `retained ${index}`,
      ts: index,
    };
    Object.defineProperty(event, 'id', {
      configurable: true,
      enumerable: true,
      get: () => {
        retainedIdReads += 1;
        return `retained-${index}`;
      },
    });
    return event;
  });
  const state: AppState = {
    ...initialState,
    transcripts: { 'sess-a': retained },
    transcriptRetainedCost: { 'sess-a': 1 },
  };
  const actions = Array.from({ length: 200 }, (_, index) => ({
    type: 'SESSION_TRANSCRIPT' as const,
    event: {
      id: `incoming-${index}`,
      appSessionId: 'sess-a',
      sourceSessionId: 'primary',
      role: 'primary' as const,
      kind: 'text' as const,
      author: 'assistant' as const,
      text: `incoming ${index}`,
      ts: retained.length + index,
    },
  }));

  reducer(state, { type: 'BATCH', actions });

  assert.equal(retainedIdReads, retained.length);
});

test('non-transcript actions remain ordering barriers inside a batch', () => {
  const state: AppState = {
    ...initialState,
    sessions: { 'sess-a': session('sess-a', 3_000) },
    sessionOrder: ['sess-a'],
    listConfirmedSessionIds: ['sess-a'],
  };
  const beforeClose: TranscriptEvent = {
    id: 'before-close',
    appSessionId: 'sess-a',
    sourceSessionId: 'primary',
    role: 'primary',
    kind: 'text',
    author: 'assistant',
    text: 'before close',
    ts: 1,
  };
  const afterClose: TranscriptEvent = { ...beforeClose, id: 'after-close', text: 'after close' };
  const actions = [
    { type: 'SESSION_TRANSCRIPT' as const, event: beforeClose },
    { type: 'SESSION_LIST' as const, sessions: [] },
    { type: 'SESSION_TRANSCRIPT' as const, event: afterClose },
  ];

  const sequential = actions.reduce(reducer, state);
  const batched = reducer(state, { type: 'BATCH', actions });

  assert.deepEqual(
    { ...batched, transcriptMutations: {} },
    { ...sequential, transcriptMutations: {} },
  );
  assert.deepEqual(batched.transcripts['sess-a'], [afterClose]);
  assert.deepEqual(batched.transcriptMutations['sess-a'], {
    revision: 1,
    baseRevision: 0,
    kind: 'reset',
    previousLength: 0,
    firstChangedIndex: 0,
  });
});

test('nested batches remain ordering barriers between transcript runs', () => {
  const state: AppState = {
    ...initialState,
    sessions: { 'sess-a': session('sess-a', 3_000) },
    sessionOrder: ['sess-a'],
    listConfirmedSessionIds: ['sess-a'],
  };
  const beforePrune: TranscriptEvent = {
    id: 'before-prune',
    appSessionId: 'sess-a',
    sourceSessionId: 'primary',
    role: 'primary',
    kind: 'text',
    author: 'assistant',
    text: 'before prune',
    ts: 1,
  };
  const insideNestedBatch: TranscriptEvent = {
    ...beforePrune,
    id: 'inside-nested-batch',
    text: 'inside nested batch',
    ts: 2,
  };
  const afterNestedBatch: TranscriptEvent = {
    ...beforePrune,
    id: 'after-nested-batch',
    text: 'after nested batch',
    ts: 3,
  };
  const flattened = [
    { type: 'SESSION_TRANSCRIPT' as const, event: beforePrune },
    { type: 'SESSION_LIST' as const, sessions: [] },
    { type: 'SESSION_TRANSCRIPT' as const, event: insideNestedBatch },
    { type: 'SESSION_TRANSCRIPT' as const, event: afterNestedBatch },
  ];

  const sequential = flattened.reduce(reducer, state);
  const nested = reducer(state, {
    type: 'BATCH',
    actions: [flattened[0], { type: 'BATCH', actions: flattened.slice(1, 3) }, flattened[3]],
  });

  assert.deepEqual(
    { ...nested, transcriptMutations: {} },
    { ...sequential, transcriptMutations: {} },
  );
  assert.deepEqual(nested.transcripts['sess-a'], [insideNestedBatch, afterNestedBatch]);
  assert.deepEqual(nested.transcriptMutations['sess-a'], {
    revision: 2,
    baseRevision: 0,
    kind: 'reset',
    previousLength: 0,
    firstChangedIndex: 0,
  });
});

test('batched transcript provenance spans ordering barriers from the published revision', () => {
  const retained: TranscriptEvent = {
    id: 'retained',
    appSessionId: 'sess-a',
    sourceSessionId: 'primary',
    role: 'primary',
    kind: 'text',
    author: 'assistant',
    text: 'retained',
    ts: 1,
  };
  const state: AppState = {
    ...initialState,
    sessions: { 'sess-a': session('sess-a', 3_000) },
    sessionOrder: ['sess-a'],
    transcripts: { 'sess-a': [retained] },
    transcriptMutations: {
      'sess-a': {
        revision: 7,
        baseRevision: 6,
        kind: 'append',
        previousLength: 0,
        firstChangedIndex: 0,
      },
    },
  };
  const first = { ...retained, id: 'first', text: 'first', ts: 2 };
  const second = { ...retained, id: 'second', text: 'second', ts: 3 };

  const next = reducer(state, {
    type: 'BATCH',
    actions: [
      { type: 'SESSION_TRANSCRIPT', event: first },
      { type: 'MARK_ALL_SESSIONS_READ', seenAt: 4_000 },
      { type: 'SESSION_TRANSCRIPT', event: second },
    ],
  });

  assert.deepEqual(next.transcriptMutations['sess-a'], {
    revision: 9,
    baseRevision: 7,
    kind: 'append',
    previousLength: 1,
    firstChangedIndex: 1,
  });
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
    session: { ...session('created-session', 3_000), goal: 'hello' },
  });

  assert.deepEqual(created.lastCreatedSessionRequest, {
    clientRef: 'client-1',
    appSessionId: 'created-session',
  });
  assert.equal(created.pendingCompose['client-1'], undefined);
  assert.equal(created.transcripts['created-session'][0].text, 'hello');
  assert.deepEqual(created.transcriptMutations['created-session'], {
    revision: 1,
    baseRevision: 0,
    kind: 'append',
    previousLength: 0,
    firstChangedIndex: 0,
  });
});

test('session seeds preserve live file provenance without claiming background content', () => {
  const live = reducer(
    {
      ...initialState,
      pendingCompose: {
        'client-1': { text: 'typed prompt', skills: [], files: [] },
      },
    },
    {
      type: 'SESSION_CREATED',
      clientRef: 'client-1',
      session: { ...session('live-session', 3_000), goal: 'persisted prompt' },
    },
  );
  assert.deepEqual(live.transcripts['live-session']?.[0]?.files, []);

  const background = reducer(initialState, {
    type: 'SESSION_CREATED',
    clientRef: 'another-window',
    session: { ...session('background-session', 3_000), goal: 'persisted prompt' },
  });
  assert.equal(background.transcripts['background-session']?.[0]?.files, undefined);
});
