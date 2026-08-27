import assert from 'node:assert/strict';
import test from 'node:test';

import { diffProbes, type AbProbeResult } from './abCompare.js';
import { expectedMarkerSamples, evaluateProbeGates, evaluateReplayGates } from './gates.js';
import { metricClass } from './metricKind.js';
import { PERF_SCENARIOS, resolveScenario, SKIPPED_PERF_SCENARIOS } from './scenario.js';

test('new issue-126 scenarios resolve and skipped names stay documented', () => {
  for (const name of [
    'idle',
    'agents-4',
    'agents-16',
    'agents-27',
    'long-tail',
    'session-switch',
    'soak',
  ]) {
    const spec = resolveScenario(name);
    assert.equal(spec.name, name);
  }
  assert.equal(resolveScenario('session-switch').kind, 'session-switch');
  assert.equal(resolveScenario('soak').kind, 'soak');
  assert.ok(SKIPPED_PERF_SCENARIOS['browser-workspace']);
  assert.ok(SKIPPED_PERF_SCENARIOS['sidecar-restart']);
  assert.ok(PERF_SCENARIOS.smoke);
});

test('A/B catalog never labels sidecar pipeline metrics as ab', () => {
  assert.equal(metricClass('bundle.initialJsBytes'), 'ab');
  assert.equal(metricClass('feed.mountedRowsAt10k'), 'ab');
  assert.equal(metricClass('sidecar.eventReductionRatio'), 'candidate');
  assert.equal(metricClass('sidecar.pendingEventsMax'), 'candidate');
});

test('diffProbes never fabricates a baseline for candidate-only ids', () => {
  const baseline: AbProbeResult = {
    treeRoot: 'main',
    notes: [],
    metrics: [{ id: 'bundle.initialJsBytes', value: 2_000_000, unit: 'bytes', method: 'dist' }],
  };
  const candidate: AbProbeResult = {
    treeRoot: 'head',
    notes: [],
    metrics: [
      { id: 'bundle.initialJsBytes', value: 1_200_000, unit: 'bytes', method: 'dist' },
      { id: 'sidecar.eventReductionRatio', value: 0.4, unit: 'ratio', method: 'replay' },
    ],
  };
  const metrics = diffProbes(baseline, candidate);
  const bundle = metrics.find((metric) => metric.id === 'bundle.initialJsBytes');
  const reduction = metrics.find((metric) => metric.id === 'sidecar.eventReductionRatio');
  assert.equal(bundle?.class, 'ab');
  assert.equal(bundle?.delta, -800_000);
  assert.equal(reduction?.class, 'candidate');
  assert.equal(reduction?.baseline, null);
  assert.equal(reduction?.delta, null);
});

test('replay gates fail on marker loss and pass a clean smoke-shaped snapshot', () => {
  const spec = resolveScenario('smoke', { deltasPerTurn: 20, toolMarkerEvery: 20 });
  assert.equal(expectedMarkerSamples(spec), 2);
  const sidecar = emptySidecar({ livePrimarySessions: 1 });
  const fail = evaluateReplayGates(spec, sidecar, {
    appendedReceived: 0,
    appendToReceiveMs: { count: 0 },
    providerToReceiveMs: { count: 0 },
    firstTokenMs: { count: 0 },
    markerSamples: 0,
    firstTokenSamples: 0,
    bytesReceived: 0,
  });
  assert.equal(fail.results.find((result) => result.id === 'sidecar.markerLoss')?.status, 'fail');
  assert.equal(fail.hardPassed, false);

  const pass = evaluateReplayGates(spec, sidecar, {
    appendedReceived: 4,
    appendToReceiveMs: { count: 4 },
    providerToReceiveMs: { count: 2 },
    firstTokenMs: { count: 1 },
    markerSamples: 2,
    firstTokenSamples: 1,
    bytesReceived: 100,
  });
  assert.equal(pass.results.find((result) => result.id === 'sidecar.markerLoss')?.status, 'pass');
  assert.equal(pass.results.find((result) => result.id === 'sidecar.rssBytes')?.mode, 'warn');
});

test('probe gates fail unbounded mounted rows and pass the measured 10k window', () => {
  const fail = evaluateProbeGates({
    mountedRowsAt10k: 10_000,
    rowVisitsPerTailDeltaAt10k: 10_000,
    eventsRebuiltPerDelta: 200,
    terminalDeliveriesPerFlood: 1_000,
    livePrimarySessionsAfterSoak: 3,
  });
  assert.equal(fail.hardPassed, false);

  const pass = evaluateProbeGates({
    mountedRowsAt10k: 26,
    rowVisitsPerTailDeltaAt10k: 26,
    eventsRebuiltPerDelta: 2,
    terminalDeliveriesPerFlood: 4,
    livePrimarySessionsAfterSoak: 0,
  });
  assert.equal(pass.hardPassed, true);
  for (const result of pass.results) {
    assert.ok(result.justification.length > 0);
  }
});

function emptySidecar(resources: { livePrimarySessions: number }) {
  const emptyHist = { count: 0 };
  return {
    pid: 1,
    startedAt: 0,
    uptimeMs: 0,
    counters: {
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
    },
    histograms: {
      normalizeMs: emptyHist,
      persistenceStartupMs: emptyHist,
      persistMs: emptyHist,
      persistenceBoundaryMs: emptyHist,
      emitMs: emptyHist,
      transportMs: emptyHist,
      coalesceMerged: emptyHist,
      transportBatchEvents: emptyHist,
      transportBatchBytes: emptyHist,
      transportQueueDelayMs: emptyHist,
    },
    transport: {
      bytesTotal: 0,
      bytesPerSecondAvg: 0,
      bytesPerSecondRecent: 0,
      eventReductionRatio: 0,
      clientBufferedBytesMax: 0,
      replayBytesTotal: 0,
      queue: {
        pendingEvents: 0,
        pendingEstimatedBytes: 0,
        oldestPendingAgeMs: 0,
        pendingEventsMax: 0,
        pendingEstimatedBytesMax: 0,
        oldestPendingAgeMsMax: 0,
      },
      replayBuffer: { batches: 0, bytes: 0, batchesMax: 0, bytesMax: 0 },
    },
    eventLoop: null,
    resources: {
      livePrimarySessions: resources.livePrimarySessions,
      childAgentsTotal: 0,
      childAgentsActive: 0,
      childAgentsLive: 0,
      childAgentsQueued: 0,
      contextPollers: 0,
      contextPollersActive: 0,
      autoCompactionWatchdogs: 0,
      sessionFileWatchers: 0,
    },
    process: { rssBytes: 1, heapUsedBytes: 1, heapTotalBytes: 1, cpuUserMs: 1, cpuSystemMs: 0 },
  };
}
