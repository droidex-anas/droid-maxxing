import assert from 'node:assert/strict';
import test from 'node:test';

import { HotPathMetrics } from './hotPathMetrics.js';

function freshMetrics(): HotPathMetrics {
  return new HotPathMetrics();
}

test('snapshot before enable reports no event-loop monitor and no resources', () => {
  const metrics = freshMetrics();

  const snapshot = metrics.snapshot();
  assert.equal(snapshot.eventLoop, null);
  assert.equal(snapshot.resources, null);
  assert.equal(snapshot.uptimeMs, 0);
});

test('stage records feed counters, histograms, and snapshot gauges', async () => {
  const metrics = freshMetrics();
  metrics.enable();
  metrics.recordNormalize(0.5);
  metrics.recordNormalize(1.5);
  metrics.recordPersist(2);
  metrics.recordEmit(3);
  metrics.recordTransport(0.25, 1_000, 1);
  metrics.recordCoalesce(4);

  // The event-loop monitor needs at least one timer tick before its first
  // sample; until then the snapshot legitimately reports no event-loop stats.
  let snapshot = metrics.snapshot();
  const deadline = Date.now() + 500;
  while (snapshot.eventLoop === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    snapshot = metrics.snapshot();
  }

  assert.equal(snapshot.counters.normalized, 2);
  assert.equal(snapshot.counters.persisted, 1);
  assert.equal(snapshot.counters.emitted, 1);
  assert.equal(snapshot.counters.transportSends, 1);
  assert.equal(snapshot.counters.coalesceFlushes, 1);
  assert.equal(snapshot.histograms.normalizeMs.p50Ms, 0.5);
  assert.equal(snapshot.histograms.persistMs.maxMs, 2);
  assert.equal(snapshot.histograms.coalesceMerged.maxMs, 4);
  assert.equal(snapshot.transport.bytesTotal, 1_000);
  assert.ok(snapshot.transport.bytesPerSecondAvg > 0);
  assert.ok(snapshot.eventLoop !== null);
  assert.ok(Number.isFinite(snapshot.eventLoop.meanMs));
  assert.ok(snapshot.process.rssBytes > 0);
  assert.ok(snapshot.process.cpuUserMs >= 0);
});

test('transport bytes multiply across connected clients', () => {
  const metrics = freshMetrics();
  metrics.enable();
  metrics.recordTransport(1, 100, 3);

  assert.equal(metrics.snapshot().transport.bytesTotal, 300);
});

test('gauge provider supplies resource counts and failures degrade to null', () => {
  const metrics = freshMetrics();
  metrics.enable();
  const counts = { livePrimarySessions: 2, childAgentsTotal: 7, childAgentsActive: 3 };
  metrics.setGaugeProvider(() => counts);
  assert.deepEqual(metrics.snapshot().resources, counts);

  metrics.setGaugeProvider(() => {
    throw new Error('gauge blew up');
  });
  assert.equal(metrics.snapshot().resources, null);

  metrics.clearGaugeProvider();
  assert.equal(metrics.snapshot().resources, null);
});

test('reset clears samples so consecutive runs stay independent', () => {
  const metrics = freshMetrics();
  metrics.enable();
  metrics.recordNormalize(1);
  metrics.recordTransport(1, 10, 1);
  metrics.reset();

  const snapshot = metrics.snapshot();
  assert.deepEqual(snapshot.counters, {
    normalized: 0,
    persisted: 0,
    emitted: 0,
    transportSends: 0,
    coalesceFlushes: 0,
  });
  assert.equal(snapshot.transport.bytesTotal, 0);
  assert.equal(snapshot.eventLoop, null);
  assert.equal(snapshot.uptimeMs, 0);
});

test('enable is idempotent and keeps a stable start baseline', async () => {
  const metrics = freshMetrics();
  metrics.enable();
  const firstStartedAt = metrics.snapshot().startedAt;
  await new Promise((resolve) => setTimeout(resolve, 15));
  metrics.enable();

  assert.equal(metrics.snapshot().startedAt, firstStartedAt);
  assert.ok(metrics.snapshot().uptimeMs >= 5);
});

test('transport byte samples wrap the ring without losing totals', () => {
  const metrics = freshMetrics();
  metrics.enable();
  // More sends than the ring holds, so the cursor wraps while the counters
  // and byte totals keep accumulating unaffected.
  const sends = 10_500;
  for (let index = 0; index < sends; index += 1) metrics.recordTransport(0.1, 2, 1);

  const snapshot = metrics.snapshot();
  assert.equal(snapshot.counters.transportSends, sends);
  assert.equal(snapshot.transport.bytesTotal, sends * 2);
  assert.ok(
    Number.isFinite(snapshot.transport.bytesPerSecondRecent) &&
      snapshot.transport.bytesPerSecondRecent > 0,
  );
});
