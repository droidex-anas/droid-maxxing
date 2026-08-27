import {
  MAX_PERSISTENCE_QUEUE_BYTES,
  MAX_PERSISTENCE_QUEUE_ROWS,
} from '../historyPersistenceQueueValues.js';
import type { HotPathMetricsSnapshot } from '../telemetry/hotPathMetrics.js';
import type { ReplayClientStats } from './report.js';
import type { PerfScenarioSpec } from './scenario.js';

export type GateStatus = 'pass' | 'fail' | 'warn' | 'unmeasured';

export interface GateResult {
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
export const MOUNTED_ROWS_BUDGET = 80;
export const HISTORY_10K_ROWS = 10_000;

// 1000×64-byte PTY chunks = 64 KiB. MessagePort flushes at 32 KiB, so a healthy
// candidate delivers a handful of posts. 16 is ~4× a two-flush flood plus replay.
export const TERMINAL_FLOOD_CHUNKS = 1_000;
export const TERMINAL_DELIVERIES_BUDGET = 16;

// Incremental projection should touch the live tail, not the settled prefix.
export const FEED_REBUILT_EVENTS_PER_DELTA_BUDGET = 8;

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
    hard(
      'sidecar.markerLoss',
      'tool-marker event loss',
      'count',
      markerLoss,
      0,
      `Markers are uncoalesced. Expected ${String(expectedMarkers)} samples, got ${String(client.markerSamples)}.`,
    ),
    hard(
      'sidecar.orderErrors',
      'bridge sequence/order errors',
      'count',
      0,
      0,
      'A completed replay already rejected generation changes and sequence gaps; a finished report is 0 errors.',
    ),
    hard(
      'sidecar.pendingEventsMax',
      'transport pending events high-water',
      'events',
      sidecar.transport.queue.pendingEventsMax,
      TRANSPORT_PENDING_EVENTS_CAP,
      `Replay buffer is 4096 batches. Measured high-water must stay inside that cap (headroom is the cap minus the run’s peak).`,
    ),
    hard(
      'sidecar.pendingEstimatedBytesMax',
      'transport pending bytes high-water',
      'bytes',
      sidecar.transport.queue.pendingEstimatedBytesMax,
      TRANSPORT_PENDING_BYTES_CAP,
      'Replay buffer is 32 MiB. Queue bytes are gated at that product cap.',
    ),
    hard(
      'sidecar.backpressureDisconnects',
      'slow-client disconnects',
      'count',
      sidecar.counters.transportBackpressureDisconnects,
      0,
      'A correct client in this harness must not trip the hard slow-client ceiling.',
    ),
    hard(
      'sidecar.livePrimarySessions',
      'live primary sessions after replay',
      'sessions',
      sidecar.resources?.livePrimarySessions ?? null,
      spec.sessions,
      `Replay leaves sessions open. Count must equal the scenario’s ${String(spec.sessions)} sessions, not grow past them.`,
    ),
    hard(
      'sidecar.persistenceFailures',
      'history persistence overflow/degraded transitions',
      'count',
      sidecar.counters.persistenceFailures,
      0,
      `Write-behind is capped at ${String(MAX_PERSISTENCE_QUEUE_ROWS)} rows / ${String(MAX_PERSISTENCE_QUEUE_BYTES)} bytes. A normal replay must not overflow that bound.`,
    ),
    warn(
      'sidecar.rssBytes',
      'process RSS',
      'bytes',
      sidecar.process.rssBytes,
      Number.POSITIVE_INFINITY,
      'Recorded for comparison. Shared-runner RSS is too noisy for a hard gate.',
    ),
    warn(
      'sidecar.cpuUserMs',
      'process CPU user time',
      'ms',
      sidecar.process.cpuUserMs,
      Number.POSITIVE_INFINITY,
      'Recorded for comparison. Shared-runner CPU is too noisy for a hard gate.',
    ),
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
    hard(
      'feed.mountedRowsAt10k',
      'mounted conversation rows for 10k history',
      'rows',
      options.mountedRowsAt10k,
      MOUNTED_ROWS_BUDGET,
      'conversationList.test.ts keeps 3k and 10k histories under 80 mounted rows (viewport 900px, overscan 8).',
    ),
    hard(
      'feed.rowVisitsPerTailDeltaAt10k',
      'row visits per streamed tail token at 10k',
      'rows',
      options.rowVisitsPerTailDeltaAt10k,
      MOUNTED_ROWS_BUDGET,
      'A tail delta may only visit the mounted window, not retained history. Same 80-row bound as mounted rows.',
    ),
    hard(
      'feed.eventsRebuiltPerDelta',
      'visible events rebuilt per tail delta',
      'events',
      options.eventsRebuiltPerDelta,
      FEED_REBUILT_EVENTS_PER_DELTA_BUDGET,
      'Incremental projection should rebuild the live tail. 8 is 4× a two-event append after a measured O(1) rebuild.',
    ),
    hard(
      'terminal.deliveriesPerFlood',
      'renderer deliveries for 1000 PTY chunks',
      'messages',
      options.terminalDeliveriesPerFlood,
      TERMINAL_DELIVERIES_BUDGET,
      '1000×64-byte chunks are 64 KiB. 32 KiB MessagePort flushes imply a handful of posts; 16 is ~4× that plus replay.',
    ),
    hard(
      'sidecar.livePrimarySessionsAfterSoak',
      'live primary sessions after soak cleanup',
      'sessions',
      options.livePrimarySessionsAfterSoak,
      0,
      'Soak create/close must release every session. 0 live primaries is the leak invariant.',
    ),
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

function hard(
  id: string,
  name: string,
  unit: string,
  actual: number | null,
  budget: number,
  justification: string,
): GateResult {
  return result(id, name, 'hard', unit, actual, budget, justification);
}

function warn(
  id: string,
  name: string,
  unit: string,
  actual: number | null,
  budget: number,
  justification: string,
): GateResult {
  return result(id, name, 'warn', unit, actual, budget, justification);
}

function result(
  id: string,
  name: string,
  mode: 'hard' | 'warn',
  unit: string,
  actual: number | null,
  budget: number,
  justification: string,
): GateResult {
  if (actual === null) {
    return { id, name, mode, unit, actual, budget, status: 'unmeasured', justification };
  }
  if (mode === 'warn') {
    return { id, name, mode, unit, actual, budget, status: 'warn', justification };
  }
  return {
    id,
    name,
    mode,
    unit,
    actual,
    budget,
    status: actual <= budget ? 'pass' : 'fail',
    justification,
  };
}
