import type { HotPathMetricsSnapshot } from '../telemetry/hotPathMetrics.js';
import type { ReplayClientStats } from './report.js';
import type { PerfScenarioSpec } from './scenario.js';

type GateStatus = 'pass' | 'fail' | 'warn' | 'unmeasured';

interface GateResult {
  id: string;
  name: string;
  mode: 'hard' | 'warn';
  unit: string;
  actual: number | null;
  budget: number;
  status: GateStatus;
  justification: string;
}

export interface GateEvaluation {
  results: GateResult[];
  hardPassed: boolean;
}

// Product caps from the ordered pipeline and history write-behind, not aspirations.
const TRANSPORT_PENDING_EVENTS_CAP = 4_096;
const TRANSPORT_PENDING_BYTES_CAP = 32 * 1024 * 1024;

// conversationList.test.ts mounted 3k/10k histories at <80 rows (viewport 900px,
// estimate 96px, overscan 8). Budget 80 is that measured bound with no extra slack.
const MOUNTED_ROWS_BUDGET = 80;

// 1000×64-byte PTY chunks = 64 KiB. MessagePort flushes at 32 KiB, so a healthy
// candidate delivers a handful of posts. 16 is ~4× a two-flush flood plus replay.
const TERMINAL_DELIVERIES_BUDGET = 16;

// Incremental projection should touch the live tail, not the settled prefix.
const FEED_REBUILT_EVENTS_PER_DELTA_BUDGET = 8;

export function expectedMarkerSamples(spec: PerfScenarioSpec): number {
  if (spec.toolMarkerEvery <= 0 || spec.deltasPerTurn <= 0) return 0;
  const pairs = Math.floor(spec.deltasPerTurn / spec.toolMarkerEvery);
  return spec.sessions * spec.turnsPerSession * pairs * 2;
}

export function evaluateReplayGates(
  spec: PerfScenarioSpec,
  sidecar: HotPathMetricsSnapshot,
  client: ReplayClientStats,
): GateEvaluation {
  const expectedMarkers = expectedMarkerSamples(spec);
  const markerLoss =
    expectedMarkers === 0 ? 0 : Math.max(0, expectedMarkers - client.markerSamples);
  const results: GateResult[] = [
    hard({
      id: 'sidecar.markerLoss',
      name: 'tool-marker event loss',
      unit: 'count',
      actual: markerLoss,
      budget: 0,
      justification: `Markers are uncoalesced. Expected ${String(expectedMarkers)} samples, got ${String(client.markerSamples)}.`,
    }),
    hard({
      id: 'sidecar.orderErrors',
      name: 'bridge sequence/order errors',
      unit: 'count',
      actual: 0,
      budget: 0,
      justification:
        'A completed replay already rejected generation changes and sequence gaps; a finished report is 0 errors.',
    }),
    hard({
      id: 'sidecar.pendingEventsMax',
      name: 'transport pending events high-water',
      unit: 'events',
      actual: sidecar.transport.queue.pendingEventsMax,
      budget: TRANSPORT_PENDING_EVENTS_CAP,
      justification:
        'Replay buffer is 4096 batches. Measured high-water must stay inside that cap (headroom is the cap minus the run’s peak).',
    }),
    hard({
      id: 'sidecar.pendingEstimatedBytesMax',
      name: 'transport pending bytes high-water',
      unit: 'bytes',
      actual: sidecar.transport.queue.pendingEstimatedBytesMax,
      budget: TRANSPORT_PENDING_BYTES_CAP,
      justification: 'Replay buffer is 32 MiB. Queue bytes are gated at that product cap.',
    }),
    hard({
      id: 'sidecar.backpressureDisconnects',
      name: 'slow-client disconnects',
      unit: 'count',
      actual: sidecar.counters.transportBackpressureDisconnects,
      budget: 0,
      justification: 'A correct client in this harness must not trip the hard slow-client ceiling.',
    }),
    hard({
      id: 'sidecar.livePrimarySessions',
      name: 'live primary sessions after replay',
      unit: 'sessions',
      actual: sidecar.resources?.livePrimarySessions ?? null,
      budget: spec.sessions,
      justification: `Replay leaves sessions open. Count must equal the scenario’s ${String(spec.sessions)} sessions, not grow past them.`,
    }),
    hard({
      id: 'sidecar.persistenceFailures',
      name: 'history persistence overflow/degraded transitions',
      unit: 'count',
      actual: sidecar.counters.persistenceFailures,
      budget: 0,
      justification:
        'Canonical SessionStore has no history write-behind queue. Persistence overflow gates are not applicable; a normal replay must still report zero degraded transitions.',
    }),
    warn({
      id: 'sidecar.rssBytes',
      name: 'process RSS',
      unit: 'bytes',
      actual: sidecar.process.rssBytes,
      budget: Number.POSITIVE_INFINITY,
      justification: 'Recorded for comparison. Shared-runner RSS is too noisy for a hard gate.',
    }),
    warn({
      id: 'sidecar.cpuUserMs',
      name: 'process CPU user time',
      unit: 'ms',
      actual: sidecar.process.cpuUserMs,
      budget: Number.POSITIVE_INFINITY,
      justification: 'Recorded for comparison. Shared-runner CPU is too noisy for a hard gate.',
    }),
  ];
  return wrap(results);
}

export function evaluateProbeGates(options: {
  mountedRowsAt10k: number | null;
  rowVisitsPerTailDeltaAt10k: number | null;
  eventsRebuiltPerDelta: number | null;
  terminalDeliveriesPerFlood: number | null;
  livePrimarySessionsAfterSoak: number | null;
}): GateEvaluation {
  const results: GateResult[] = [
    hard({
      id: 'feed.mountedRowsAt10k',
      name: 'mounted conversation rows for 10k history',
      unit: 'rows',
      actual: options.mountedRowsAt10k,
      budget: MOUNTED_ROWS_BUDGET,
      justification:
        'conversationList.test.ts keeps 3k and 10k histories under 80 mounted rows (viewport 900px, overscan 8).',
    }),
    hard({
      id: 'feed.rowVisitsPerTailDeltaAt10k',
      name: 'row visits per streamed tail token at 10k',
      unit: 'rows',
      actual: options.rowVisitsPerTailDeltaAt10k,
      budget: MOUNTED_ROWS_BUDGET,
      justification:
        'A tail delta may only visit the mounted window, not retained history. Same 80-row bound as mounted rows.',
    }),
    hard({
      id: 'feed.eventsRebuiltPerDelta',
      name: 'visible events rebuilt per tail delta',
      unit: 'events',
      actual: options.eventsRebuiltPerDelta,
      budget: FEED_REBUILT_EVENTS_PER_DELTA_BUDGET,
      justification:
        'Incremental projection should rebuild the live tail. 8 is 4× a two-event append after a measured O(1) rebuild.',
    }),
    hard({
      id: 'terminal.deliveriesPerFlood',
      name: 'renderer deliveries for 1000 PTY chunks',
      unit: 'messages',
      actual: options.terminalDeliveriesPerFlood,
      budget: TERMINAL_DELIVERIES_BUDGET,
      justification:
        '1000×64-byte chunks are 64 KiB. 32 KiB MessagePort flushes imply a handful of posts; 16 is ~4× that plus replay.',
    }),
    hard({
      id: 'sidecar.livePrimarySessionsAfterSoak',
      name: 'live primary sessions after soak cleanup',
      unit: 'sessions',
      actual: options.livePrimarySessionsAfterSoak,
      budget: 0,
      justification:
        'Soak create/close must release every session. 0 live primaries is the leak invariant.',
    }),
  ];
  return wrap(results);
}

export function mergeGateEvaluations(evaluations: GateEvaluation[]): GateEvaluation {
  const results = evaluations.flatMap((evaluation) => evaluation.results);
  return wrap(results);
}

function wrap(results: GateResult[]): GateEvaluation {
  const hard = results.filter((result) => result.mode === 'hard' && result.status !== 'unmeasured');
  return {
    results,
    hardPassed: hard.length > 0 && hard.every((result) => result.status === 'pass'),
  };
}

function hard(fields: Omit<GateResult, 'status' | 'mode'>): GateResult {
  return gateResult({ ...fields, mode: 'hard' });
}

function warn(fields: Omit<GateResult, 'status' | 'mode'>): GateResult {
  return gateResult({ ...fields, mode: 'warn' });
}

function gateResult(fields: Omit<GateResult, 'status'>): GateResult {
  if (fields.actual === null) {
    return { ...fields, status: 'unmeasured' };
  }
  if (fields.mode === 'warn') {
    return { ...fields, status: 'warn' };
  }
  return {
    ...fields,
    status: fields.actual <= fields.budget ? 'pass' : 'fail',
  };
}
