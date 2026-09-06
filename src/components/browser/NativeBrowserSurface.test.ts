import test from 'node:test';
import assert from 'node:assert/strict';
import { retryNativeBrowserAttach } from './NativeBrowserSurface';

test('native surface attachment retries twice before surfacing the failure', async () => {
  const scheduled: { callback: () => void; delayMs: number }[] = [];
  const failures: unknown[] = [];
  let attempts = 0;

  retryNativeBrowserAttach({
    attach: async () => {
      attempts += 1;
      throw new Error('attach unavailable');
    },
    onAttached: () => assert.fail('attach must not succeed'),
    onFailed: (error) => failures.push(error),
    schedule: (callback, delayMs) => {
      scheduled.push({ callback, delayMs });
      return scheduled.length as unknown as ReturnType<typeof setTimeout>;
    },
  });

  await Promise.resolve();
  assert.equal(attempts, 1);
  assert.deepEqual(
    scheduled.map(({ delayMs }) => delayMs),
    [100],
  );
  scheduled.shift()?.callback();
  await Promise.resolve();
  assert.equal(attempts, 2);
  assert.deepEqual(
    scheduled.map(({ delayMs }) => delayMs),
    [300],
  );
  scheduled.shift()?.callback();
  await Promise.resolve();

  assert.equal(attempts, 3);
  assert.equal(failures.length, 1);
  assert.match(String(failures[0]), /attach unavailable/);
});

test('native surface attachment cleanup cancels a scheduled retry', async () => {
  let scheduledCallback: (() => void) | undefined;
  let cancelled = false;
  let attempts = 0;
  const stop = retryNativeBrowserAttach({
    attach: async () => {
      attempts += 1;
      throw new Error('attach unavailable');
    },
    onAttached: () => assert.fail('attach must not succeed'),
    onFailed: () => assert.fail('disposed retries must not surface failures'),
    schedule: (callback) => {
      scheduledCallback = callback;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    },
    cancel: () => {
      cancelled = true;
    },
  });

  await Promise.resolve();
  stop();
  scheduledCallback?.();
  await Promise.resolve();

  assert.equal(cancelled, true);
  assert.equal(attempts, 1);
});
