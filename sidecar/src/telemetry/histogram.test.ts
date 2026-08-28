import assert from 'node:assert/strict';
import test from 'node:test';

import { ReservoirHistogram } from './histogram.js';

test('empty histogram reports no percentiles', () => {
  assert.deepEqual(new ReservoirHistogram().stats(), { count: 0 });
});

test('histogram reports exact rank percentiles', () => {
  const histogram = new ReservoirHistogram();
  for (let index = 1; index <= 100; index += 1) histogram.add(index);

  const stats = histogram.stats();
  assert.equal(stats.count, 100);
  assert.equal(stats.p50Ms, 50);
  assert.equal(stats.p95Ms, 95);
  assert.equal(stats.p99Ms, 99);
  assert.equal(stats.maxMs, 100);
  assert.ok(stats.meanMs !== undefined && Math.abs(stats.meanMs - 50.5) < 0.001);
});

test('histogram ignores non-finite and negative samples', () => {
  const histogram = new ReservoirHistogram();
  histogram.add(Number.NaN);
  histogram.add(-1);
  histogram.add(Number.POSITIVE_INFINITY);
  histogram.add(4);

  assert.deepEqual(histogram.stats(), {
    count: 1,
    meanMs: 4,
    p50Ms: 4,
    p95Ms: 4,
    p99Ms: 4,
    maxMs: 4,
  });
});

test('histogram reservoir keeps only the most recent samples', () => {
  const histogram = new ReservoirHistogram();
  // Default capacity is 8192; fill it with low samples, then overwrite more
  // than half the ring with a newer, higher range.
  for (let index = 0; index < 8192; index += 1) histogram.add(1);
  for (let index = 0; index < 5000; index += 1) histogram.add(1000 + index);

  const stats = histogram.stats();
  assert.equal(stats.count, 8192);
  assert.equal(stats.p50Ms, 1903);
  assert.equal(stats.maxMs, 5999);
});

test('reset empties the histogram', () => {
  const histogram = new ReservoirHistogram();
  histogram.add(5);
  histogram.reset();

  assert.deepEqual(histogram.stats(), { count: 0 });
});
