// Plain-data report so JSON artifacts stay diffable between runs.

import type { HistogramStats } from '../telemetry/histogram.js';
import type { HotPathMetricsSnapshot } from '../telemetry/hotPathMetrics.js';
import type { BudgetEvaluation } from './budgets.js';
import type { GateEvaluation } from './gates.js';
import type { PerfScenarioSpec } from './scenario.js';

export interface ReplayClientStats {
  appendedReceived: number;
  appendToReceiveMs: HistogramStats;
  providerToReceiveMs: HistogramStats;
  markerSamples: number;
  bytesReceived: number;
}

interface ReplayDrift {
  firstHalfToReceiveMs: HistogramStats;
  secondHalfToReceiveMs: HistogramStats;
}

export interface ReplayReport {
  scenario: PerfScenarioSpec;
  startedAt: number;
  durationMs: number;
  providerEvents: number;
  client: ReplayClientStats;
  drift: ReplayDrift | null;
  sidecar: HotPathMetricsSnapshot;
  budgets: BudgetEvaluation;
  gates: GateEvaluation;
  environment: {
    node: string;
    platform: string;
    cpus: number;
  };
}

export function renderReportMarkdown(report: ReplayReport): string {
  const transport = report.sidecar.transport;
  const counters = report.sidecar.counters;
  const lines: string[] = [
    `# Perf replay: ${report.scenario.name}`,
    '',
    `- Date: ${new Date(report.startedAt).toISOString()}`,
    `- Duration: ${ms(report.durationMs)}`,
    `- Scenario: ${report.scenario.description}`,
    `- Seed: ${n(report.scenario.seed)}, sessions: ${n(report.scenario.sessions)}, turns/session: ${n(report.scenario.turnsPerSession)}, deltas/turn: ${n(report.scenario.deltasPerTurn)}, rate: ${n(report.scenario.eventsPerSecond)}/s per session, coalesce: ${ms(report.scenario.coalesceMs)}`,
    `- Provider events yielded: ${n(report.providerEvents)}; appended events received: ${n(report.client.appendedReceived)}; marker e2e samples: ${n(report.client.markerSamples)}`,
    `- Node ${report.environment.node} on ${report.environment.platform} (${n(report.environment.cpus)} cpus)`,
    '',
    '## Stage latencies (sidecar)',
    '',
    '| Stage | p50 ms | p95 ms | p99 ms | max ms | count |',
    '| --- | --- | --- | --- | --- | --- |',
    stageRow('normalize', report.sidecar.histograms.normalizeMs),
    stageRow('sqlite writer startup', report.sidecar.histograms.persistenceStartupMs),
    stageRow('sqlite persist', report.sidecar.histograms.persistMs),
    stageRow('durability boundary', report.sidecar.histograms.persistenceBoundaryMs),
    stageRow('emit queue/flush dispatch', report.sidecar.histograms.emitMs),
    stageRow('transport fan-out', report.sidecar.histograms.transportMs),
    stageRow('transport queue delay', report.sidecar.histograms.transportQueueDelayMs),
    stageRow('coalesce merged', report.sidecar.histograms.coalesceMerged),
    '',
    '## Transport batches',
    '',
    '| Distribution | p50 | p95 | p99 | max | count |',
    '| --- | --- | --- | --- | --- | --- |',
    valueRow('delivered events / batch', report.sidecar.histograms.transportBatchEvents),
    valueRow('serialized bytes / batch', report.sidecar.histograms.transportBatchBytes),
    '',
    '## Client-observed latency',
    '',
    '| Metric | p50 ms | p95 ms | p99 ms | max ms | count |',
    '| --- | --- | --- | --- | --- | --- |',
    stageRow('append → ws receive', report.client.appendToReceiveMs),
    stageRow('provider yield → ws receive (markers)', report.client.providerToReceiveMs),
    '',
    '## Throughput and health',
    '',
    `- Event transport: ${n(counters.transportLogicalEvents)} logical → ${n(counters.transportDeliveredEvents)} delivered (${percent(transport.eventReductionRatio)} reduction) in ${n(counters.transportBatches)} batches; ${n(counters.transportImmediateBatches)} immediate`,
    `- Wire sends: ${n(counters.transportSends)} operations, ${n(transport.bytesTotal)} bytes total, ${n(transport.bytesPerSecondAvg)} bytes/s avg, ${n(transport.bytesPerSecondRecent)} bytes/s recent`,
    `- Queue peaks: ${n(transport.queue.pendingEventsMax)} events, ${n(transport.queue.pendingEstimatedBytesMax)} estimated bytes, ${ms(transport.queue.oldestPendingAgeMsMax)}`,
    `- Slow clients: ${n(counters.transportBackpressureDisconnects)} hard disconnects; ${n(transport.clientBufferedBytesMax)} buffered bytes high-water`,
    `- Replay: ${n(counters.transportReplayedBatches)} batches / ${n(counters.transportReplayedEvents)} events / ${n(transport.replayBytesTotal)} bytes; retained ${n(transport.replayBuffer.batches)} batches / ${n(transport.replayBuffer.bytes)} bytes (peak ${n(transport.replayBuffer.batchesMax)} / ${n(transport.replayBuffer.bytesMax)})`,
    `- Persistence recovery: ${n(counters.persistenceFailures)} degraded transitions / ${n(counters.persistenceRecoveries)} recoveries`,
    `- Event-loop delay p95: ${report.sidecar.eventLoop ? ms(report.sidecar.eventLoop.p95Ms) : 'n/a'}`,
    `- Memory rss: ${n(report.sidecar.process.rssBytes)} bytes; cpu: user ${ms(report.sidecar.process.cpuUserMs)} / system ${ms(report.sidecar.process.cpuSystemMs)}`,
    `- Resources: ${report.sidecar.resources ? `${n(report.sidecar.resources.livePrimarySessions)} live sessions, ${n(report.sidecar.resources.childAgentsTotal)} child agents (${n(report.sidecar.resources.childAgentsActive)} active)` : 'n/a'}`,
  ];
  if (report.drift) {
    lines.push(
      '',
      '## Session-length drift (long-history)',
      '',
      '| Half | p50 ms | p95 ms | p99 ms | max ms | count |',
      '| --- | --- | --- | --- | --- | --- |',
      stageRow('first half', report.drift.firstHalfToReceiveMs),
      stageRow('second half', report.drift.secondHalfToReceiveMs),
    );
  }
  lines.push(
    '',
    '## Budgets (phase 0 calibration)',
    '',
    '| Budget | Limit ms | Actual ms | Status |',
    '| --- | --- | --- | --- |',
    ...report.budgets.results.map(
      (result) =>
        `| ${result.name} | ${ms(result.budgetMs)} | ${result.actualMs === null ? '—' : ms(result.actualMs)} | ${result.status} |`,
    ),
    '',
    report.budgets.allMeasuredPassed
      ? 'All measured timing budgets passed (calibration; not CI-hard).'
      : 'One or more timing budgets failed or were unmeasured (calibration; not CI-hard).',
    '',
    '## Deterministic gates',
    '',
    '| Gate | Actual | Budget | Mode | Status |',
    '| --- | --- | --- | --- | --- |',
    ...report.gates.results.map(
      (result) =>
        `| ${result.name} | ${formatGateActual(result.actual, result.unit)} | ${formatGateActual(result.budget, result.unit)} | ${result.mode} | ${result.status} |`,
    ),
    '',
    report.gates.hardPassed
      ? 'All measured hard gates passed.'
      : 'One or more hard gates failed or were unmeasured.',
    '',
  );
  return lines.join('\n');
}

function stageRow(label: string, stats: HistogramStats): string {
  return `| ${label} | ${ms(stats.p50Ms)} | ${ms(stats.p95Ms)} | ${ms(stats.p99Ms)} | ${ms(stats.maxMs)} | ${n(stats.count)} |`;
}

function valueRow(label: string, stats: HistogramStats): string {
  return `| ${label} | ${value(stats.p50Ms)} | ${value(stats.p95Ms)} | ${value(stats.p99Ms)} | ${value(stats.maxMs)} | ${n(stats.count)} |`;
}

function n(value: number): string {
  return String(value);
}

function value(value: number | undefined): string {
  return value === undefined ? '—' : String(value);
}

function ms(value: number | undefined): string {
  return value === undefined ? '—' : `${value.toFixed(2)} ms`;
}

function percent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

function formatGateActual(value: number | null, unit: string): string {
  if (value === null) return '—';
  if (!Number.isFinite(value)) return 'n/a';
  if (unit === 'bytes' || unit === 'ms' || unit === 'events' || unit === 'rows') {
    return `${value.toFixed(value % 1 === 0 ? 0 : 2)} ${unit}`;
  }
  return `${String(value)} ${unit}`;
}
