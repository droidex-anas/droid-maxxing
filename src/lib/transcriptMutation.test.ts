import assert from 'node:assert/strict';
import test from 'node:test';
import {
  aggregateTranscriptMutationBatch,
  aggregateTranscriptMutations,
  detectPureTranscriptPrepend,
  nextTranscriptMutation,
  observeTranscriptMutationChanges,
  type TranscriptMutation,
} from './transcriptMutation';

const reference = (id: string) => ({ id });

test('the first transcript mutation starts revision tracking at one', () => {
  const first = nextTranscriptMutation(undefined, {
    kind: 'append',
    previousLength: 0,
    firstChangedIndex: 0,
  });

  assert.deepEqual(first, {
    revision: 1,
    baseRevision: 0,
    kind: 'append',
    previousLength: 0,
    firstChangedIndex: 0,
  });
  assert.deepEqual(
    nextTranscriptMutation(first, {
      kind: 'append',
      previousLength: 1,
      firstChangedIndex: 1,
    }),
    {
      revision: 2,
      baseRevision: 1,
      kind: 'append',
      previousLength: 1,
      firstChangedIndex: 1,
    },
  );
});

test('pure prepend detection records one exact insertion without scanning semantics', () => {
  const retained = [reference('b'), reference('c')];
  const older = [reference('a')];

  assert.deepEqual(detectPureTranscriptPrepend(retained, [...older, ...retained]), {
    kind: 'prepend',
    previousLength: 2,
    firstChangedIndex: 0,
    insertedCount: 1,
  });

  const prefix = reference('prefix');
  assert.deepEqual(
    detectPureTranscriptPrepend([prefix, ...retained], [prefix, ...older, ...retained]),
    {
      kind: 'prepend',
      previousLength: 3,
      firstChangedIndex: 1,
      insertedCount: 1,
    },
  );
});

test('prepend detection rejects replacement, removal, and cloned retained entries', () => {
  const first = reference('a');
  const second = reference('b');

  assert.equal(detectPureTranscriptPrepend([first, second], [reference('x'), second]), undefined);
  assert.equal(detectPureTranscriptPrepend([first, second], [first]), undefined);
  assert.equal(
    detectPureTranscriptPrepend([first, second], [reference('older'), { ...first }, second]),
    undefined,
  );
});

test('aggregation preserves one linked prepend and resets mixed mutation chains', () => {
  const prepend: TranscriptMutation = {
    revision: 11,
    baseRevision: 10,
    kind: 'prepend',
    previousLength: 100,
    firstChangedIndex: 0,
    insertedCount: 40,
  };

  assert.deepEqual(aggregateTranscriptMutations(10, [prepend]), prepend);
  const mixed = aggregateTranscriptMutations(10, [
    prepend,
    {
      revision: 12,
      baseRevision: 11,
      kind: 'append',
      previousLength: 140,
      firstChangedIndex: 140,
    },
  ]);
  assert.ok(mixed);
  assert.equal(mixed.kind, 'reset');
});

test('aggregation combines a contiguous append chain from the batch boundary', () => {
  const records: TranscriptMutation[] = [
    {
      revision: 11,
      baseRevision: 10,
      kind: 'append',
      previousLength: 5,
      firstChangedIndex: 5,
    },
    {
      revision: 12,
      baseRevision: 11,
      kind: 'append',
      previousLength: 6,
      firstChangedIndex: 4,
    },
    {
      revision: 13,
      baseRevision: 12,
      kind: 'append',
      previousLength: 6,
      firstChangedIndex: 6,
    },
  ];

  assert.deepEqual(aggregateTranscriptMutations(10, records), {
    revision: 13,
    baseRevision: 10,
    kind: 'append',
    previousLength: 5,
    firstChangedIndex: 4,
  });
  assert.equal(aggregateTranscriptMutations(13, []), undefined);
});

test('aggregation conservatively resets for an explicit reset or revision gap', () => {
  const explicitReset: TranscriptMutation[] = [
    {
      revision: 5,
      baseRevision: 4,
      kind: 'append',
      previousLength: 8,
      firstChangedIndex: 8,
    },
    {
      revision: 6,
      baseRevision: 5,
      kind: 'reset',
      previousLength: 9,
      firstChangedIndex: 3,
    },
  ];
  const lateAppend: TranscriptMutation = {
    revision: 8,
    baseRevision: 7,
    kind: 'append',
    previousLength: 3,
    firstChangedIndex: 3,
  };
  const revisionGap: TranscriptMutation[] = [
    lateAppend,
    {
      revision: 10,
      baseRevision: 9,
      kind: 'append',
      previousLength: 4,
      firstChangedIndex: 4,
    },
  ];

  assert.deepEqual(aggregateTranscriptMutations(4, explicitReset), {
    revision: 6,
    baseRevision: 4,
    kind: 'reset',
    previousLength: 8,
    firstChangedIndex: 0,
  });
  assert.deepEqual(aggregateTranscriptMutations(7, revisionGap), {
    revision: 10,
    baseRevision: 7,
    kind: 'reset',
    previousLength: 3,
    firstChangedIndex: 0,
  });
  const gapped = aggregateTranscriptMutations(6, [lateAppend]);
  assert.ok(gapped);
  assert.equal(gapped.kind, 'reset');
});

test('aggregation preserves a restarted revision lineage after the batch record was pruned', () => {
  const restarted: TranscriptMutation = {
    revision: 1,
    baseRevision: 0,
    kind: 'append',
    previousLength: 0,
    firstChangedIndex: 0,
  };

  assert.deepEqual(aggregateTranscriptMutations(9, [restarted]), {
    revision: 1,
    baseRevision: 0,
    kind: 'reset',
    previousLength: 0,
    firstChangedIndex: 0,
  });
});

test('mutation helpers reject invalid transcript indices', () => {
  assert.throws(
    () =>
      nextTranscriptMutation(undefined, {
        kind: 'append',
        previousLength: -1,
        firstChangedIndex: 0,
      }),
    RangeError,
  );
  assert.throws(
    () =>
      nextTranscriptMutation(undefined, {
        kind: 'append',
        previousLength: 2,
        firstChangedIndex: 3,
      }),
    RangeError,
  );
  assert.throws(
    () =>
      aggregateTranscriptMutations(0, [
        {
          revision: 1,
          baseRevision: 0,
          kind: 'append',
          previousLength: 1,
          firstChangedIndex: 0.5,
        },
      ]),
    RangeError,
  );
});

test('mutation observation records only new and changed sessions', () => {
  const sessionA: TranscriptMutation = {
    revision: 3,
    baseRevision: 2,
    kind: 'append',
    previousLength: 2,
    firstChangedIndex: 2,
  };
  const sessionB: TranscriptMutation = {
    revision: 8,
    baseRevision: 7,
    kind: 'append',
    previousLength: 5,
    firstChangedIndex: 5,
  };
  const changedSessionA: TranscriptMutation = {
    revision: 4,
    baseRevision: 3,
    kind: 'append',
    previousLength: 3,
    firstChangedIndex: 3,
  };
  const newSession: TranscriptMutation = {
    revision: 1,
    baseRevision: 0,
    kind: 'append',
    previousLength: 0,
    firstChangedIndex: 0,
  };
  const before = { 'session-a': sessionA, 'session-b': sessionB };
  const after = {
    'session-a': changedSessionA,
    'session-b': sessionB,
    'session-c': newSession,
  };
  const records = new Map<string, TranscriptMutation[]>();

  observeTranscriptMutationChanges(records, before, after);
  observeTranscriptMutationChanges(records, after, after);

  assert.deepEqual(
    records,
    new Map([
      ['session-a', [changedSessionA]],
      ['session-c', [newSession]],
    ]),
  );
});

test('batch aggregation combines multiple sessions and preserves no-op map identity', () => {
  const sessionAStart: TranscriptMutation = {
    revision: 10,
    baseRevision: 9,
    kind: 'append',
    previousLength: 4,
    firstChangedIndex: 4,
  };
  const sessionAFirst: TranscriptMutation = {
    revision: 11,
    baseRevision: 10,
    kind: 'append',
    previousLength: 5,
    firstChangedIndex: 5,
  };
  const sessionAFinal: TranscriptMutation = {
    revision: 12,
    baseRevision: 11,
    kind: 'append',
    previousLength: 6,
    firstChangedIndex: 4,
  };
  const sessionBStart: TranscriptMutation = {
    revision: 20,
    baseRevision: 19,
    kind: 'append',
    previousLength: 2,
    firstChangedIndex: 2,
  };
  const sessionBFinal: TranscriptMutation = {
    revision: 21,
    baseRevision: 20,
    kind: 'reset',
    previousLength: 2,
    firstChangedIndex: 0,
  };
  const unchanged: TranscriptMutation = {
    revision: 2,
    baseRevision: 1,
    kind: 'append',
    previousLength: 1,
    firstChangedIndex: 1,
  };
  const batchStart = {
    'session-a': sessionAStart,
    'session-b': sessionBStart,
    unchanged,
  };
  const final = {
    'session-a': sessionAFinal,
    'session-b': sessionBFinal,
    unchanged,
  };
  const records = new Map([
    ['session-a', [sessionAFirst, sessionAFinal]],
    ['session-b', [sessionBFinal]],
  ]);

  const result = aggregateTranscriptMutationBatch(batchStart, final, records);

  assert.notEqual(result, final);
  assert.equal(result.unchanged, unchanged);
  assert.deepEqual(result['session-a'], {
    revision: 12,
    baseRevision: 10,
    kind: 'append',
    previousLength: 5,
    firstChangedIndex: 4,
  });
  assert.deepEqual(result['session-b'], {
    revision: 21,
    baseRevision: 20,
    kind: 'reset',
    previousLength: 2,
    firstChangedIndex: 0,
  });
  assert.equal(aggregateTranscriptMutationBatch(batchStart, final, new Map()), final);
});

test('deletion-only batches keep the final mutation map unchanged', () => {
  const mutation: TranscriptMutation = {
    revision: 4,
    baseRevision: 3,
    kind: 'append',
    previousLength: 3,
    firstChangedIndex: 3,
  };
  const batchStart = { 'session-a': mutation };
  const final: Record<string, TranscriptMutation> = {};
  const records = new Map<string, TranscriptMutation[]>();

  observeTranscriptMutationChanges(records, batchStart, final);

  assert.equal(records.size, 0);
  assert.equal(aggregateTranscriptMutationBatch(batchStart, final, records), final);
});

test('batch aggregation keeps recreated sessions on their restarted revision lineage', () => {
  const previous: TranscriptMutation = {
    revision: 9,
    baseRevision: 8,
    kind: 'append',
    previousLength: 7,
    firstChangedIndex: 7,
  };
  const restarted: TranscriptMutation = {
    revision: 1,
    baseRevision: 0,
    kind: 'append',
    previousLength: 0,
    firstChangedIndex: 0,
  };
  const batchStart = { 'session-a': previous };
  const recreated = { 'session-a': restarted };
  const records = new Map<string, TranscriptMutation[]>();

  observeTranscriptMutationChanges(records, batchStart, {});
  observeTranscriptMutationChanges(records, {}, recreated);

  assert.deepEqual(aggregateTranscriptMutationBatch(batchStart, recreated, records), {
    'session-a': {
      revision: 1,
      baseRevision: 0,
      kind: 'reset',
      previousLength: 0,
      firstChangedIndex: 0,
    },
  });
});
