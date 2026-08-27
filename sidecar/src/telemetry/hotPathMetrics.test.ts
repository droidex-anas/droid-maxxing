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
  metrics.recordPersistenceStartup(4);
  metrics.recordPersist(2);
  metrics.recordPersistenceBoundary(7);
  metrics.recordPersistenceFailure();
  metrics.recordPersistenceRecovery();
  metrics.recordEmit(3);
  metrics.recordTransport(0.25, 1_000, 1);
  metrics.recordCoalesce(4);

  let snapshot = metrics.snapshot();
  const deadline = Date.now() + 500;
  while (snapshot.eventLoop === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    snapshot = metrics.snapshot();
  }

  assert.equal(snapshot.counters.normalized, 2);
  assert.equal(snapshot.counters.persisted, 1);
  assert.equal(snapshot.counters.persistenceFailures, 1);
  assert.equal(snapshot.counters.persistenceRecoveries, 1);
  assert.equal(snapshot.counters.emitted, 1);
  assert.equal(snapshot.counters.transportSends, 1);
  assert.equal(snapshot.counters.coalesceFlushes, 1);
  assert.equal(snapshot.histograms.normalizeMs.p50Ms, 0.5);
  assert.equal(snapshot.histograms.persistenceStartupMs.maxMs, 4);
  assert.equal(snapshot.histograms.persistMs.maxMs, 2);
  assert.equal(snapshot.histograms.persistenceBoundaryMs.maxMs, 7);
  assert.equal(snapshot.histograms.coalesceMerged.maxMs, 4);
  assert.equal(snapshot.transport.bytesTotal, 1_000);
  assert.ok(snapshot.transport.bytesPerSecondAvg > 0);
  assert.ok(snapshot.eventLoop !== null);
  assert.ok(Number.isFinite(snapshot.eventLoop.meanMs));
  assert.ok(snapshot.process.rssBytes > 0);
  assert.ok(snapshot.process.cpuUserMs >= 0);
});

test('transport records explicit aggregate bytes and send operations', () => {
  const metrics = freshMetrics();
  metrics.enable();
  metrics.recordTransport(1, 300, 3);

  const snapshot = metrics.snapshot();
  assert.equal(snapshot.transport.bytesTotal, 300);
  assert.equal(snapshot.counters.transportSends, 3);
});

test('phase 1 metrics expose reduction, queue peaks, replay and backpressure', () => {
  const metrics = freshMetrics();
  metrics.enable();
  metrics.recordTransportBatch({
    logicalEvents: 10,
    deliveredEvents: 7,
    bytes: 1_200,
    queueDelayMs: 16,
    immediate: false,
  });
  metrics.recordTransportBatch({
    logicalEvents: 1,
    deliveredEvents: 1,
    bytes: 200,
    queueDelayMs: 0,
    immediate: true,
  });
  metrics.recordTransportQueue({
    pendingEvents: 12,
    pendingEstimatedBytes: 4_096,
    oldestPendingAgeMs: 8,
  });
  metrics.recordTransportQueue({
    pendingEvents: 0,
    pendingEstimatedBytes: 0,
    oldestPendingAgeMs: 0,
  });
  metrics.recordClientBufferedAmount(10_000);
  metrics.recordBackpressureDisconnect(20_000);
  metrics.recordReplay(2, 7, 1_400);
  metrics.recordReplayBuffer(4, 2_048);

  const snapshot = metrics.snapshot();
  assert.equal(snapshot.counters.transportBatches, 2);
  assert.equal(snapshot.counters.transportLogicalEvents, 11);
  assert.equal(snapshot.counters.transportDeliveredEvents, 8);
  assert.equal(snapshot.counters.transportImmediateBatches, 1);
  assert.equal(snapshot.counters.transportReplayedBatches, 2);
  assert.equal(snapshot.counters.transportReplayedEvents, 7);
  assert.equal(snapshot.counters.transportBackpressureDisconnects, 1);
  assert.equal(snapshot.transport.eventReductionRatio, 0.273);
  assert.equal(snapshot.transport.queue.pendingEvents, 0);
  assert.equal(snapshot.transport.queue.pendingEventsMax, 12);
  assert.equal(snapshot.transport.queue.pendingEstimatedBytesMax, 4_096);
  assert.equal(snapshot.transport.clientBufferedBytesMax, 20_000);
  assert.equal(snapshot.transport.replayBytesTotal, 1_400);
  assert.equal(snapshot.transport.replayBuffer.batches, 4);
  assert.equal(snapshot.histograms.transportBatchEvents.p50Ms, 1);
  assert.equal(snapshot.histograms.transportBatchEvents.maxMs, 7);
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
  metrics.recordTransportBatch({
    logicalEvents: 2,
    deliveredEvents: 1,
    bytes: 100,
    queueDelayMs: 4,
    immediate: false,
  });
  metrics.recordReplayBuffer(1, 100);
  metrics.reset();

  const snapshot = metrics.snapshot();
  assert.deepEqual(snapshot.counters, {
    normalized: 0,
    persisted: 0,
    persistenceFailures: 0,
    persistenceRecoveries: 0,
    emitted: 0,
    transportSends: 0,
    coalesceFlushes: 0,
    transportBatches: 0,
    transportLogicalEvents: 0,
    transportDeliveredEvents: 0,
    transportImmediateBatches: 0,
    transportReplayedBatches: 0,
    transportReplayedEvents: 0,
    transportBackpressureDisconnects: 0,
  });
  assert.equal(snapshot.transport.bytesTotal, 0);
  assert.equal(snapshot.transport.eventReductionRatio, 0);
  assert.deepEqual(snapshot.transport.queue, {
    pendingEvents: 0,
    pendingEstimatedBytes: 0,
    oldestPendingAgeMs: 0,
    pendingEventsMax: 0,
    pendingEstimatedBytesMax: 0,
    oldestPendingAgeMsMax: 0,
  });
  assert.deepEqual(snapshot.transport.replayBuffer, {
    batches: 0,
    bytes: 0,
    batchesMax: 0,
    bytesMax: 0,
  });
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
