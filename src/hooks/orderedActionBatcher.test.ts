import assert from 'node:assert/strict';
import test from 'node:test';
import { createOrderedActionBatcher } from './orderedActionBatcher';

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
