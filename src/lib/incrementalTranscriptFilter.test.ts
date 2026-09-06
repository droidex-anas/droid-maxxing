import assert from 'node:assert/strict';
import test from 'node:test';
import type { TranscriptEvent } from '../types/bridge';
import { createIncrementalTranscriptFilter } from './incrementalTranscriptFilter';
import type { TranscriptMutation } from './transcriptMutation';

function event(id: string, sourceSessionId: string): TranscriptEvent {
  return {
    id,
    appSessionId: 'session-a',
    sourceSessionId,
    role: sourceSessionId === 'primary' ? 'primary' : 'worker',
    kind: 'text',
    text: id,
    ts: 1,
  };
}

function appendMutation(previousLength: number): TranscriptMutation {
  return {
    revision: 1,
    baseRevision: 0,
    kind: 'append',
    previousLength,
    firstChangedIndex: previousLength,
  };
}

test('long transcript appends evaluate only the changed suffix', () => {
  let sourceReads = 0;
  const source = Array.from({ length: 4_000 }, (_, index) => {
    const item = event(`event-${String(index)}`, index % 2 === 0 ? 'primary' : 'child');
    Object.defineProperty(item, 'sourceSessionId', {
      configurable: true,
      enumerable: true,
      get: () => {
        sourceReads += 1;
        return index % 2 === 0 ? 'primary' : 'child';
      },
    });
    return item;
  });
  const project = createIncrementalTranscriptFilter();
  const includes = (item: TranscriptEvent) => item.sourceSessionId === 'primary';
  const initial = project({ conversationKey: 'primary', source, mutation: undefined, includes });
  sourceReads = 0;
  const appended = event('tail', 'primary');

  const next = project({
    conversationKey: 'primary',
    source: [...source, appended],
    mutation: appendMutation(source.length),
    includes,
  });

  assert.equal(sourceReads, 0);
  assert.equal(next.length, initial.length + 1);
  assert.equal(next[0], initial[0]);
  assert.equal(next.at(-1), appended);
});

test('older page insertion retains the existing filtered suffix', () => {
  const project = createIncrementalTranscriptFilter();
  const recent = [event('recent-primary', 'primary'), event('recent-child', 'child')];
  const includes = (item: TranscriptEvent) => item.sourceSessionId === 'primary';
  const initial = project({
    conversationKey: 'primary',
    source: recent,
    mutation: undefined,
    includes,
  });
  const older = [event('older-child', 'child'), event('older-primary', 'primary')];
  const next = project({
    conversationKey: 'primary',
    source: [...older, ...recent],
    mutation: {
      revision: 1,
      baseRevision: 0,
      kind: 'prepend',
      previousLength: recent.length,
      firstChangedIndex: 0,
      insertedCount: older.length,
    },
    includes,
  });

  assert.deepEqual(
    next.map((item) => item.id),
    ['older-primary', 'recent-primary'],
  );
  assert.equal(next[1], initial[0]);
});

test('a changed includes predicate rebuilds in full instead of corrupting the suffix count', () => {
  const project = createIncrementalTranscriptFilter();
  const primaryOnly = (item: TranscriptEvent) => item.sourceSessionId === 'primary';
  const source = [event('a', 'primary'), event('b', 'child'), event('c', 'primary')];
  project({ conversationKey: 'mission', source, mutation: undefined, includes: primaryOnly });

  const broader = (item: TranscriptEvent) => item.sourceSessionId !== 'elsewhere';
  const next = project({
    conversationKey: 'mission',
    source: [...source, event('tail', 'child')],
    mutation: appendMutation(source.length),
    includes: broader,
  });

  assert.deepEqual(
    next.map((item) => item.id),
    ['a', 'b', 'c', 'tail'],
  );
});

test('a mutable predicate falls back to a full rebuild instead of a negative prefix', () => {
  const project = createIncrementalTranscriptFilter();
  let includeEveryEvent = false;
  const predicate = (item: TranscriptEvent) =>
    includeEveryEvent || item.sourceSessionId === 'primary';
  const first = event('a', 'primary');
  const source = [first, event('b', 'child'), event('c', 'primary')];
  project({ conversationKey: 'mission', source, mutation: undefined, includes: predicate });

  includeEveryEvent = true;
  const replacedChild = event('b', 'child');
  const replacedTail = event('c', 'primary');
  const next = project({
    conversationKey: 'mission',
    source: [first, replacedChild, replacedTail, event('tail', 'child')],
    mutation: {
      revision: 1,
      baseRevision: 0,
      kind: 'append',
      previousLength: source.length,
      firstChangedIndex: 0,
    },
    includes: predicate,
  });

  assert.deepEqual(
    next.map((item) => item.id),
    ['a', 'b', 'c', 'tail'],
  );
});
