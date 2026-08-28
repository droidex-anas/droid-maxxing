import assert from 'node:assert/strict';
import test from 'node:test';

import { ShutdownDeadline } from './shutdownDeadline.js';

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
