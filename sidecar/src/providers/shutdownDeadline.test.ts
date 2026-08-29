import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createSharedShutdown,
  ShutdownDeadline,
  SIDECAR_SHUTDOWN_BUDGET_MS,
} from './shutdownDeadline.js';

test('fromDurationMs records an absolute expiry against the supplied clock', () => {
  const deadline = ShutdownDeadline.fromDurationMs(1_000, 5_000);
  assert.equal(deadline.remainingMs(5_000), 1_000);
  assert.equal(deadline.remainingMs(5_500), 500);
  assert.equal(deadline.isExpired(5_000), false);
  assert.equal(deadline.isExpired(5_999), false);
  assert.equal(deadline.isExpired(6_000), true);
});

test('remainingMs clamps at zero instead of going negative', () => {
  const deadline = ShutdownDeadline.fromDurationMs(100, 1_000);
  assert.equal(deadline.remainingMs(2_000), 0);
  assert.equal(deadline.isExpired(2_000), true);
});

test('a zero-duration deadline is already expired at the creation instant', () => {
  const deadline = ShutdownDeadline.fromDurationMs(0, 1_000);
  assert.equal(deadline.remainingMs(1_000), 0);
  assert.equal(deadline.isExpired(1_000), true);
  assert.equal(deadline.remainingMs(1_001), 0);
});

test('non-finite and negative durations collapse to an already-expired deadline', () => {
  assert.equal(ShutdownDeadline.fromDurationMs(Number.NaN, 10).isExpired(10), true);
  assert.equal(ShutdownDeadline.fromDurationMs(Number.POSITIVE_INFINITY, 10).isExpired(10), true);
  assert.equal(ShutdownDeadline.fromDurationMs(-50, 10).remainingMs(10), 0);
});

test('the same deadline instance does not create a fresh relative timeout when re-queried', () => {
  const deadline = ShutdownDeadline.fromDurationMs(800, 2_000);
  assert.equal(deadline.remainingMs(2_200), 600);
  assert.equal(deadline.remainingMs(2_700), 100);
  assert.equal(deadline.remainingMs(2_800), 0);
});

test('withClock uses the injected monotonic clock for remaining budget', () => {
  let now = 10_000;
  const deadline = ShutdownDeadline.withClock(500, () => now);
  assert.equal(deadline.remainingMs(), 500);
  now = 10_400;
  assert.equal(deadline.remainingMs(), 100);
  now = 10_500;
  assert.equal(deadline.isExpired(), true);
});

test('awaitSettled returns immediately when the deadline is already expired', async () => {
  const deadline = ShutdownDeadline.fromDurationMs(0, 1);
  let settled = false;
  const hanging = new Promise<void>(() => undefined);
  hanging.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await deadline.awaitSettled(hanging);
  assert.equal(settled, false);
});

test('awaitSettled propagates a rejection that happens within budget', async () => {
  const deadline = ShutdownDeadline.fromDurationMs(5_000);
  await assert.rejects(deadline.awaitSettled(Promise.reject(new Error('cleanup failed'))), {
    message: 'cleanup failed',
  });
});

test('createSharedShutdown reuses one promise and one deadline object', async () => {
  const received: ShutdownDeadline[] = [];
  let resolveRun: () => void = () => undefined;
  const running = new Promise<void>((resolve) => {
    resolveRun = resolve;
  });
  const trigger = createSharedShutdown(
    async (deadline) => {
      received.push(deadline);
      await running;
    },
    { durationMs: 1_000, nowMonotonicMs: () => 50 },
  );
  const first = trigger();
  const second = trigger();
  assert.equal(first, second);
  assert.equal(received.length, 1);
  assert.equal(received[0]?.remainingMs(50), 1_000);
  resolveRun();
  await first;
  await second;
});

test('the sidecar shutdown budget is the five-second inner cap', () => {
  assert.equal(SIDECAR_SHUTDOWN_BUDGET_MS, 5_000);
});
