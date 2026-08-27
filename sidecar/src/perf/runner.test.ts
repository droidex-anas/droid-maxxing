import assert from 'node:assert/strict';
import test from 'node:test';

import { acceptReplayWireMessage, runReplay } from './runner.js';
import { resolveScenario } from './scenario.js';

// A tiny real-pipeline run: the fake provider streams through the actual
// normalize → coalesce → SQLite → WebSocket path, so this proves the harness
// wiring end to end without turning the suite into a benchmark.
test('replay run drives the real sidecar pipeline and reports measurements', async () => {
  const report = await runReplay({
    spec: resolveScenario('smoke', {
      seed: 7,
      deltasPerTurn: 25,
      eventsPerSecond: 50,
      coalesceMs: 10,
    }),
  });

  assert.ok(report.durationMs > 0);
  assert.ok(report.providerEvents >= 25);
  assert.ok(report.client.appendedReceived >= 3, 'some appended events must reach the client');
  assert.ok(report.client.markerSamples >= 2, 'tool markers must produce exact e2e samples');
  assert.ok(report.client.appendToReceiveMs.count === report.client.appendedReceived);
  assert.ok(report.client.providerToReceiveMs.p95Ms !== undefined);
  assert.ok(report.client.bytesReceived > 0);

  const sidecar = report.sidecar;
  assert.ok(sidecar.counters.normalized >= report.providerEvents);
  assert.ok(sidecar.counters.persisted >= report.client.appendedReceived);
  assert.ok(sidecar.histograms.persistMs.count > 0);
  assert.ok(sidecar.histograms.persistMs.count <= sidecar.counters.persisted);
  assert.ok(sidecar.histograms.transportMs.count > 0);
  assert.ok(sidecar.eventLoop !== null);
  assert.ok(sidecar.resources !== null);
  assert.ok(sidecar.resources.livePrimarySessions >= 1);

  assert.ok(report.budgets.results.length > 0);
  assert.ok(report.gates.results.length > 0);
  for (const result of report.budgets.results) {
    assert.ok(['pass', 'fail', 'unmeasured'].includes(result.status));
    assert.ok(result.budgetMs > 0);
  }
});

test('long-history runs include first/second half drift comparison', async () => {
  const report = await runReplay({
    spec: resolveScenario('smoke', {
      seed: 13,
      name: 'long-history',
      deltasPerTurn: 40,
      eventsPerSecond: 80,
      coalesceMs: 10,
    }),
  });

  assert.ok(report.drift);
  assert.ok(report.drift.firstHalfToReceiveMs.count > 0);
  assert.ok(report.drift.secondHalfToReceiveMs.count > 0);
});

test('replay client rejects generation changes and non-contiguous batches', () => {
  const cursor = { generation: null, lastSeq: 0 };
  const first = acceptReplayWireMessage(
    {
      type: 'events.batch',
      generation: 'generation-1',
      firstSeq: 1,
      lastSeq: 2,
      events: [
        { seq: 1, event: { type: 'connection', status: 'connected' } },
        { seq: 2, event: { type: 'connection', status: 'connected' } },
      ],
    },
    cursor,
  );

  assert.equal(first.length, 2);
  assert.deepEqual(cursor, { generation: 'generation-1', lastSeq: 2 });
  assert.throws(
    () =>
      acceptReplayWireMessage(
        {
          type: 'events.batch',
          generation: 'generation-1',
          firstSeq: 4,
          lastSeq: 4,
          events: [{ seq: 4, event: { type: 'connection', status: 'connected' } }],
        },
        cursor,
      ),
    /sequence gap/,
  );
  assert.throws(
    () =>
      acceptReplayWireMessage(
        {
          type: 'events.batch',
          generation: 'generation-2',
          firstSeq: 3,
          lastSeq: 3,
          events: [{ seq: 3, event: { type: 'connection', status: 'connected' } }],
        },
        cursor,
      ),
    /generation changed/,
  );
});

test('replay client rejects reordered entries inside a batch', () => {
  assert.throws(
    () =>
      acceptReplayWireMessage(
        {
          type: 'events.batch',
          generation: 'generation-1',
          firstSeq: 1,
          lastSeq: 2,
          events: [
            { seq: 2, event: { type: 'connection', status: 'connected' } },
            { seq: 1, event: { type: 'connection', status: 'connected' } },
          ],
        },
        { generation: null, lastSeq: 0 },
      ),
    /entry order/,
  );
});

test('the first replay batch establishes the live sequence baseline', () => {
  const cursor = { generation: null, lastSeq: 0 };

  const events = acceptReplayWireMessage(
    {
      type: 'events.batch',
      generation: 'generation-1',
      firstSeq: 7,
      lastSeq: 7,
      events: [{ seq: 7, event: { type: 'connection', status: 'connected' } }],
    },
    cursor,
  );

  assert.equal(events.length, 1);
  assert.deepEqual(cursor, { generation: 'generation-1', lastSeq: 7 });
});
