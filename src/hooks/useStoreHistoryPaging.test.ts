import test from 'node:test';
import assert from 'node:assert/strict';
import { reducer, initialState } from './useStore';
import type { AppState } from './useStore';
import type { TranscriptEvent } from '../types/bridge';

function ev(id: string, ts: number, text = id): TranscriptEvent {
  return {
    id,
    appSessionId: 'm1',
    sourceSessionId: 'primary',
    role: 'primary',
    kind: 'text',
    text,
    ts,
  };
}

test('SESSION_HISTORY replace seeds the transcript and the older cursor', () => {
  const next = reducer(initialState as unknown as AppState, {
    type: 'SESSION_HISTORY',
    appSessionId: 'm1',
    progress: [],
    transcripts: [ev('c', 3), ev('d', 4)],
    mode: 'replace',
    olderCursor: '1:end',
  });

  assert.deepEqual(
    next.transcripts.m1.map((e) => e.id),
    ['c', 'd'],
  );
  assert.equal(next.historyCursor.m1, '1:end');
  assert.equal(next.historyLoadingOlder.m1, false);
  assert.equal(next.historyLoaded.m1, true);
});

test('SESSION_HISTORY prepend prepends older events ahead of the existing scrollback', () => {
  const seeded = {
    ...initialState,
    transcripts: { m1: [ev('c', 3), ev('d', 4)] },
    historyCursor: { m1: '1:end' },
    historyLoadingOlder: { m1: true },
  } as unknown as AppState;

  const next = reducer(seeded, {
    type: 'SESSION_HISTORY',
    appSessionId: 'm1',
    progress: [],
    transcripts: [ev('a', 1), ev('b', 2)],
    mode: 'prepend',
    olderCursor: '0:end',
  });

  assert.deepEqual(
    next.transcripts.m1.map((e) => e.id),
    ['a', 'b', 'c', 'd'],
  );
  assert.equal(next.historyCursor.m1, '0:end');
  assert.equal(next.historyLoadingOlder.m1, false);
  assert.deepEqual(next.transcriptMutations.m1, {
    revision: 1,
    baseRevision: 0,
    kind: 'prepend',
    previousLength: 2,
    firstChangedIndex: 0,
    insertedCount: 2,
  });
});

test('SESSION_HISTORY prepend dedups events already present at the boundary', () => {
  const seeded = {
    ...initialState,
    transcripts: { m1: [ev('b', 2), ev('c', 3)] },
    historyLoadingOlder: { m1: true },
  } as unknown as AppState;

  const next = reducer(seeded, {
    type: 'SESSION_HISTORY',
    appSessionId: 'm1',
    progress: [],
    transcripts: [ev('a', 1), ev('b', 2)],
    mode: 'prepend',
    olderCursor: undefined,
  });

  // 'b' overlaps the existing head and must not be duplicated.
  assert.deepEqual(
    next.transcripts.m1.map((e) => e.id),
    ['a', 'b', 'c'],
  );
  assert.equal(next.historyCursor.m1, undefined);
  assert.equal(next.historyLoadingOlder.m1, false);
  assert.equal(next.transcriptMutations.m1.kind, 'prepend');
  assert.equal(next.transcriptMutations.m1.insertedCount, 1);
});

test('SESSION_HISTORY prepend with a fully-duplicate page only clears the loading flag', () => {
  const existing = [ev('a', 1), ev('b', 2)];
  const seeded = {
    ...initialState,
    transcripts: { m1: existing },
    historyLoadingOlder: { m1: true },
  } as unknown as AppState;

  const next = reducer(seeded, {
    type: 'SESSION_HISTORY',
    appSessionId: 'm1',
    progress: [],
    transcripts: [ev('a', 1)],
    mode: 'prepend',
    olderCursor: undefined,
  });

  assert.equal(next.transcripts.m1, existing);
  assert.equal(next.historyLoadingOlder.m1, false);
});

test('SESSION_HISTORY_LOADING_OLDER marks the in-flight prefetch', () => {
  const next = reducer(initialState as unknown as AppState, {
    type: 'SESSION_HISTORY_LOADING_OLDER',
    appSessionId: 'm1',
  });
  assert.equal(next.historyLoadingOlder.m1, true);
});

test('child history failures preserve the retry cursor and settle only that child', () => {
  const seeded = {
    ...initialState,
    childHistory: {
      m1: {
        'child-1': {
          status: 'paged',
          loadedCount: 120,
          hasMore: true,
          isLoaded: true,
          isLoadingOlder: true,
          olderCursor: 'child-older',
          isViewportPinned: false,
        },
      },
    },
  } as unknown as AppState;

  const next = reducer(seeded, {
    type: 'SESSION_HISTORY_FAILED',
    appSessionId: 'm1',
    childSessionId: 'child-1',
    message: 'history unavailable',
  });

  assert.deepEqual(next.childHistory.m1['child-1'], {
    status: 'failed',
    loadedCount: 120,
    hasMore: true,
    error: 'history unavailable',
    isLoaded: true,
    isLoadingOlder: false,
    olderCursor: 'child-older',
    isViewportPinned: false,
  });
  assert.equal(next.sessionRestore.m1, undefined);
});
