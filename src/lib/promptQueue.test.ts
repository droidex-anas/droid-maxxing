import assert from 'node:assert/strict';
import test from 'node:test';
import { createPromptQueueDeliveryGuard } from './promptQueue';

test('queued prompt delivery admits only one async drain at a time', async () => {
  const guard = createPromptQueueDeliveryGuard();
  let release = (): void => undefined;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let deliveries = 0;

  const first = guard.run(async () => {
    deliveries += 1;
    await pending;
  });
  assert.equal(await guard.run(async () => undefined), false);
  assert.equal(deliveries, 1);

  release();
  assert.equal(await first, true);
  assert.equal(
    await guard.run(async () => {
      deliveries += 1;
    }),
    true,
  );
  assert.equal(deliveries, 2);
});
