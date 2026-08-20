// Report shape and Markdown rendering for perf replay runs. Kept as plain
// data so JSON artifacts stay diffable between runs and code changes.

import type { HistogramStats } from '../telemetry/histogram.js';
import type { HotPathMetricsSnapshot } from '../telemetry/hotPathMetrics.js';
import type { BudgetEvaluation } from './budgets.js';
import type { PerfScenarioSpec } from './scenario.js';

export interface ReplayClientStats {
  appendedReceived: number;
  appendToReceiveMs: HistogramStats;
  providerToReceiveMs: HistogramStats;
  markerSamples: number;
  bytesReceived: number;
}

export interface ReplayDrift {
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
  environment: {
    node: string;
    platform: string;
    cpus: number;
  };
}

export function renderReportMarkdown(report: ReplayReport): string {
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
    stageRow('sqlite persist', report.sidecar.histograms.persistMs),
    stageRow('emit dispatch (contains transport)', report.sidecar.histograms.emitMs),
    stageRow('transport fan-out', report.sidecar.histograms.transportMs),
    stageRow('coalesce merged', report.sidecar.histograms.coalesceMerged),
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
    `- Transport: ${n(report.sidecar.transport.bytesTotal)} bytes total, ${n(report.sidecar.transport.bytesPerSecondAvg)} bytes/s avg, ${n(report.sidecar.transport.bytesPerSecondRecent)} bytes/s recent`,
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
      ? 'All measured budgets passed.'
      : 'One or more budgets failed or were unmeasured.',
    '',
  );
  return lines.join('\n');
}

function stageRow(label: string, stats: HistogramStats): string {
  return `| ${label} | ${ms(stats.p50Ms)} | ${ms(stats.p95Ms)} | ${ms(stats.p99Ms)} | ${ms(stats.maxMs)} | ${n(stats.count)} |`;
}

function n(value: number): string {
  return String(value);
}

function ms(value: number | undefined): string {
  return value === undefined ? '—' : `${value.toFixed(2)} ms`;
}
