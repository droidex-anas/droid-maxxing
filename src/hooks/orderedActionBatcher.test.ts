import assert from 'node:assert/strict';
import test from 'node:test';

import { createOrderedActionBatcher } from './orderedActionBatcher';

test('an idle server batch commits once in order', () => {
  const dispatched: string[] = [];
  const batcher = createOrderedActionBatcher<string, number>({
    dispatchOne: (action) => dispatched.push(`one:${action}`),
    dispatchBatch: (actions) => dispatched.push(`batch:${actions.join(',')}`),
    schedule: () => 1,
    cancel: () => undefined,
    delayMs: 16,
  });

  batcher.pushBridgeBatch(['a', 'b', 'c']);

  assert.deepEqual(dispatched, ['batch:a,b,c']);
});

test('later server batches in the same frame join the follower queue', () => {
  const dispatched: string[] = [];
  let flush: (() => void) | undefined;
  const batcher = createOrderedActionBatcher<string, number>({
    dispatchOne: (action) => dispatched.push(`one:${action}`),
    dispatchBatch: (actions) => dispatched.push(`batch:${actions.join(',')}`),
    schedule: (callback) => {
      flush = callback;
      return 1;
    },
    cancel: () => undefined,
    delayMs: 16,
  });

  batcher.pushBridgeBatch(['leading-a', 'leading-b']);
  batcher.pushBridgeBatch(['follower-a', 'follower-b']);
  flush?.();

  assert.deepEqual(dispatched, ['batch:leading-a,leading-b', 'batch:follower-a,follower-b']);
});

test('local actions flush already-received bridge followers first', () => {
  const dispatched: string[] = [];
  const cancelled: number[] = [];
  let nextTimer = 1;
  const batcher = createOrderedActionBatcher<string, number>({
    dispatchOne: (action) => dispatched.push(action),
    dispatchBatch: (actions) => dispatched.push(`batch:${actions.join(',')}`),
    schedule: () => nextTimer++,
    cancel: (timer) => cancelled.push(timer),
    delayMs: 16,
  });

  batcher.pushBridge('bridge-leading');
  batcher.pushBridge('bridge-follower');
  batcher.dispatchLocal('local');

  assert.deepEqual(dispatched, ['bridge-leading', 'batch:bridge-follower', 'local']);
  assert.deepEqual(cancelled, [1]);
});

test('empty batches and post-dispose batches are ignored', () => {
  const dispatched: string[] = [];
  const batcher = createOrderedActionBatcher<string, number>({
    dispatchOne: (action) => dispatched.push(action),
    dispatchBatch: (actions) => dispatched.push(actions.join(',')),
    schedule: () => 1,
    cancel: () => undefined,
    delayMs: 16,
  });

  batcher.pushBridgeBatch([]);
  batcher.dispose();
  batcher.pushBridgeBatch(['late']);

  assert.deepEqual(dispatched, []);
});
