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
