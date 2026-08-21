import assert from 'node:assert/strict';
import test from 'node:test';

import { BridgeReplayBuffer } from './bridgeReplayBuffer.js';
import type { ServerEventBatch } from './protocol.js';

function batch(firstSeq: number, lastSeq = firstSeq): ServerEventBatch {
  return {
    type: 'events.batch',
    generation: 'generation-test',
    firstSeq,
    lastSeq,
    events: [
      {
        seq: lastSeq,
        event: { type: 'connection', status: 'connected' },
      },
    ],
  };
}

function store(replay: BridgeReplayBuffer, value: ServerEventBatch): void {
  replay.push(value, JSON.stringify(value));
}

test('serves batches after a same-generation reconnect cursor', () => {
  const replay = new BridgeReplayBuffer(10_000, 10);
  store(replay, batch(1));
  store(replay, batch(2));

  const missing = replay.replayAfter(1);
  if (missing === null) throw new Error('replay unexpectedly unavailable');
  assert.equal(missing.length, 1);
  assert.equal(missing[0]?.firstSeq, 2);
  assert.equal(missing[0]?.lastSeq, 2);
});

test('reports a replay gap after bounded batch eviction', () => {
  const replay = new BridgeReplayBuffer(10_000, 2);
  store(replay, batch(1));
  store(replay, batch(2));
  store(replay, batch(3));

  assert.equal(replay.snapshot().firstSeq, 2);
  assert.equal(replay.replayAfter(0), null);
  assert.deepEqual(replay.replayAfter(3), []);
});

test('reports a replay gap when one batch exceeds the byte budget', () => {
  const replay = new BridgeReplayBuffer(1, 10);
  store(replay, batch(1));

  assert.equal(replay.snapshot().batches, 0);
  assert.equal(replay.snapshot().lastSeq, 1);
  assert.equal(replay.replayAfter(0), null);
});

test('rejects overlapping, out-of-order, or gapped batches', () => {
  const replay = new BridgeReplayBuffer(10_000, 10);
  const first = batch(1);
  store(replay, first);
  assert.throws(() => store(replay, first), /sequence order/);
  assert.throws(() => store(replay, batch(3)), /sequence order/);
});
