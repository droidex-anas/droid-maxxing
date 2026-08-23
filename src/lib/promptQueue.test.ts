import assert from 'node:assert/strict';
import test from 'node:test';
import { createPromptQueueDeliveryGuard } from './promptQueue';

test('queued prompt delivery coalesces overlap into one trailing retry', async () => {
  const guard = createPromptQueueDeliveryGuard();
  let release = (): void => undefined;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let deliveries = 0;

  const first = guard.run(async () => {
    deliveries += 1;
    await pending;
    throw new Error('transient delivery failure');
  });
  const trailing = guard.run(async () => {
    deliveries += 1;
  });
  assert.equal(deliveries, 1);

  release();
  await Promise.all([first, trailing]);
  assert.equal(deliveries, 2);

  await guard.run(async () => {
    deliveries += 1;
  });
  assert.equal(deliveries, 3);
});
