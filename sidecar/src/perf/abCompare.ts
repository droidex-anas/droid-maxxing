import type { GateEvaluation } from './gates.js';
import { metricClass, METRIC_CATALOG } from './metricKind.js';
import type { ReplayReport } from './report.js';

interface AbProbeMetric {
  id: string;
  value: number;
  unit: string;
  method: string;
}

export interface AbProbeResult {
  treeRoot: string;
  metrics: AbProbeMetric[];
  notes: string[];
}

export interface BaselineCache {
  baselineRef: string;
  baselineCommit: string;
  measuredAt: string;
  probes: AbProbeResult;
}

export interface ComparisonMetric {
  id: string;
  class: 'ab' | 'candidate';
  unit: string;
  baseline: number | null;
  candidate: number | null;
  delta: number | null;
  deltaPercent: number | null;
  method: string;
  availability: string;
}

export interface ComparisonReport {
  baselineRef: string;
  baselineCommit: string;
  candidateCommit: string;
  candidateTree: string;
  baselineStale: boolean;
  measuredAt: string;
  environment: { node: string; platform: string };
  probes: { baseline: AbProbeResult | null; candidate: AbProbeResult };
  metrics: ComparisonMetric[];
  candidateReplays: ReplayReport[];
  gates: GateEvaluation;
  skippedScenarios: Record<string, string>;
}

export function diffProbes(
  baseline: AbProbeResult | null,
  candidate: AbProbeResult,
): ComparisonMetric[] {
  const ids = new Set([
    ...(baseline?.metrics.map((metric) => metric.id) ?? []),
    ...candidate.metrics.map((metric) => metric.id),
  ]);
  const metrics: ComparisonMetric[] = [];
  for (const id of [...ids].sort()) {
    const classKind = metricClass(id) ?? 'candidate';
    const catalog = METRIC_CATALOG.find((entry) => entry.id === id);
    const left = baseline?.metrics.find((metric) => metric.id === id);
    const right = candidate.metrics.find((metric) => metric.id === id);
    const candidateValue = finiteOrNull(right?.value);
    const baselineValue = classKind === 'ab' ? finiteOrNull(left?.value) : null;
    const delta =
      classKind === 'ab' && baselineValue !== null && candidateValue !== null
        ? candidateValue - baselineValue
        : null;
    const deltaPercent =
      delta !== null && baselineValue !== null && baselineValue !== 0
        ? (delta / baselineValue) * 100
        : null;
    metrics.push({
      id,
      class: classKind,
      unit: right?.unit ?? left?.unit ?? '',
      baseline: baselineValue,
      candidate: candidateValue,
      delta,
      deltaPercent,
      method: right?.method ?? left?.method ?? '',
      availability: catalog?.availability ?? 'Not listed in the metric catalog.',
    });
  }
  return metrics;
}

export function candidateReplayMetrics(reports: ReplayReport[]): ComparisonMetric[] {
  return reports.flatMap((report) => {
    const sidecar = report.sidecar;
    const prefix = `replay.${report.scenario.name}`;
    return [
      comparison(
        `${prefix}.eventReductionRatio`,
        'candidate',
        'ratio',
        sidecar.transport.eventReductionRatio,
        'sidecar transport logical→delivered reduction',
      ),
      comparison(
        `${prefix}.pendingEventsMax`,
        'candidate',
        'events',
        sidecar.transport.queue.pendingEventsMax,
        'transport queue high-water during this replay',
      ),
      comparison(
        `${prefix}.pendingEstimatedBytesMax`,
        'candidate',
        'bytes',
        sidecar.transport.queue.pendingEstimatedBytesMax,
        'transport queued bytes high-water during this replay',
      ),
      comparison(
        `${prefix}.persistenceBoundaryP95Ms`,
        'candidate',
        'ms',
        sidecar.histograms.persistenceBoundaryMs.p95Ms ?? null,
        'write-behind durability boundary p95',
      ),
      comparison(
        `${prefix}.rssBytes`,
        'candidate',
        'bytes',
        sidecar.process.rssBytes,
        'process RSS after this replay; warn-only',
      ),
    ];
  });
}

function comparison(
  id: string,
  classKind: 'ab' | 'candidate',
  unit: string,
  candidate: number | null,
  method: string,
): ComparisonMetric {
  return {
    id,
    class: classKind,
    unit,
    baseline: null,
    candidate,
    delta: null,
    deltaPercent: null,
    method,
    availability:
      METRIC_CATALOG.find((entry) => id.endsWith(entry.id.replace('sidecar.', '')))?.availability ??
      'Candidate-only: origin/main does not contain this pipeline.',
  };
}

function finiteOrNull(value: number | undefined): number | null {
  return value !== undefined && Number.isFinite(value) ? value : null;
}
