// Sidecar-measurable legs of the renderer contract. Numbers are calibration
// defaults, not release gates; baseline reports decide the final budgets.

import type { HotPathMetricsSnapshot } from '../telemetry/hotPathMetrics.js';
import type { ReplayReport } from './report.js';

interface BudgetResult {
  name: string;
  budgetMs: number;
  actualMs: number | null;
  status: 'pass' | 'fail' | 'unmeasured';
}

export interface BudgetEvaluation {
  results: BudgetResult[];
  allMeasuredPassed: boolean;
}

export function evaluateBudgets(
  sidecar: HotPathMetricsSnapshot,
  client: ReplayReport['client'],
  coalesceMs: number,
): BudgetEvaluation {
  const results: BudgetResult[] = [
    stage('normalize p95', 2, sidecar.histograms.normalizeMs.p95Ms),
    stage('sqlite writer startup', 500, sidecar.histograms.persistenceStartupMs.p95Ms),
    stage('sqlite persist p95', 10, sidecar.histograms.persistMs.p95Ms),
    stage('durability boundary p95', 25, sidecar.histograms.persistenceBoundaryMs.p95Ms),
    stage('emit dispatch p95', 15, sidecar.histograms.emitMs.p95Ms),
    stage('transport fan-out p95', 5, sidecar.histograms.transportMs.p95Ms),
    // Coalesced deltas intentionally dwell up to the coalesce window before
    // they are flushed, so the wire-leg budget adds that window on top.
    stage('append-to-client p95', coalesceMs + 20, client.appendToReceiveMs.p95Ms),
    stage('provider-to-client p95 (marker events)', 50, client.providerToReceiveMs.p95Ms),
    stage('event-loop delay p95', 25, sidecar.eventLoop ? sidecar.eventLoop.p95Ms : undefined),
  ];
  const measured = results.filter((result) => result.status !== 'unmeasured');
  return {
    results,
    allMeasuredPassed: measured.length > 0 && measured.every((result) => result.status === 'pass'),
  };
}

function stage(name: string, budgetMs: number, actualMs: number | undefined): BudgetResult {
  if (actualMs === undefined) return { name, budgetMs, actualMs: null, status: 'unmeasured' };
  return {
    name,
    budgetMs,
    actualMs,
    status: actualMs <= budgetMs ? 'pass' : 'fail',
  };
}
