import assert from 'node:assert/strict';
import test from 'node:test';

import { runReplay } from './runner.js';
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
  assert.ok(sidecar.histograms.persistMs.count >= report.client.appendedReceived);
  assert.ok(sidecar.histograms.transportMs.count > 0);
  assert.ok(sidecar.eventLoop !== null);
  assert.ok(sidecar.resources !== null);
  assert.ok(sidecar.resources.livePrimarySessions >= 1);

  assert.ok(report.budgets.results.length > 0);
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
