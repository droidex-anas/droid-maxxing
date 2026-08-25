import assert from 'node:assert/strict';
import test from 'node:test';
import {
  asChunkedSequence,
  chunkedSequenceDiagnostics,
  chunkedSequenceSlice,
  insertChunkedSequence,
  replaceChunkedSequencePrefix,
  replaceChunkedSequenceSuffix,
} from './chunkedSequence';

test('chunked sequences preserve the Array read contract', () => {
  const sequence = asChunkedSequence([1, 2, 3, 4], 2);

  assert.equal(Array.isArray(sequence), true);
  assert.deepEqual(sequence, [1, 2, 3, 4]);
  assert.deepEqual([...sequence], [1, 2, 3, 4]);
  assert.deepEqual(
    sequence.map((value) => value * 2),
    [2, 4, 6, 8],
  );
  assert.deepEqual(
    sequence.filter((value) => value % 2 === 0),
    [2, 4],
  );
  assert.equal(sequence.at(-1), 4);
  assert.equal(JSON.stringify(sequence), '[1,2,3,4]');
  assert.throws(() => sequence.push(5), /immutable/);
});

test('suffix replacement retains a bounded live chunk in a long sequence', () => {
  const values = Array.from({ length: 3_001 }, (_, index) => ({ index }));
  const sequence = asChunkedSequence(values, 128);
  const replacement = { index: 9_999 };

  const next = replaceChunkedSequenceSuffix(sequence, 3_000, [replacement]);

  assert.equal(next.length, sequence.length);
  assert.equal(next[0], sequence[0]);
  assert.equal(next[2_999], sequence[2_999]);
  assert.equal(next[3_000], replacement);
  assert.equal(sequence[3_000], values[3_000]);
  assert.deepEqual(chunkedSequenceDiagnostics(next), {
    settledChunkCount: 23,
    settledEventCount: 2_944,
    liveEventCount: 57,
  });
});

test('slice, insertion, and prefix replacement retain exact ordering', () => {
  const sequence = asChunkedSequence([0, 1, 2, 3, 4, 5], 2);

  assert.deepEqual(chunkedSequenceSlice(sequence, 1, 5), [1, 2, 3, 4]);
  assert.deepEqual(insertChunkedSequence(sequence, 2, [8, 9]), [0, 1, 8, 9, 2, 3, 4, 5]);
  assert.deepEqual(replaceChunkedSequencePrefix(sequence, 2, [8, 9]), [8, 9, 2, 3, 4, 5]);
});
