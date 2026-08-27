import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  candidateReplayMetrics,
  diffProbes,
  type AbProbeResult,
  type BaselineCache,
  type ComparisonReport,
} from './abCompare.js';
import { evaluateProbeGates, mergeGateEvaluations } from './gates.js';
import { runSoak, sessionSwitchTick } from './lifecycle.js';
import { runReplay } from './runner.js';
import { resolveScenario, SKIPPED_PERF_SCENARIOS } from './scenario.js';

export const DEFAULT_BASELINE_REF = 'origin/main';
export const DEFAULT_COMPARE_SCENARIOS = [
  'smoke',
  'idle',
  'streaming',
  'agents-4',
  'agents-16',
  'agents-27',
  'multi-agent',
  'long-tail',
  'session-switch',
  'soak',
] as const;

export const GATE_SCENARIOS = ['smoke', 'soak'] as const;

export interface CompareOptions {
  baselineRef: string;
  refreshBaseline: boolean;
  skipBundle: boolean;
  includeBaseline: boolean;
  scenarios: readonly string[];
  candidateRoot: string;
}

export function defaultCandidateRoot(): string {
  return resolve(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), '..');
}

export function baselineCachePath(candidateRoot: string): string {
  return join(candidateRoot, 'sidecar/src/perf/baselines/origin-main.json');
}

export async function runComparison(options: CompareOptions): Promise<ComparisonReport> {
  const candidateRoot = options.candidateRoot;
  const baselineCommit = options.includeBaseline
    ? git(candidateRoot, ['rev-parse', options.baselineRef]).trim()
    : '';
  const candidateCommit = git(candidateRoot, ['rev-parse', 'HEAD']).trim();
  const cache = options.includeBaseline ? readCache(baselineCachePath(candidateRoot)) : null;
  const cacheHit =
    options.includeBaseline &&
    !options.refreshBaseline &&
    cache !== null &&
    cache.baselineCommit === baselineCommit &&
    cache.baselineRef === options.baselineRef;

  let baselineProbes: AbProbeResult | null = cacheHit ? cache.probes : null;
  if (options.includeBaseline && !cacheHit) {
    baselineProbes = measureBaselineTree(
      candidateRoot,
      options.baselineRef,
      baselineCommit,
      options.skipBundle,
    );
    const nextCache: BaselineCache = {
      baselineRef: options.baselineRef,
      baselineCommit,
      measuredAt: new Date().toISOString(),
      probes: baselineProbes,
    };
    const cachePath = baselineCachePath(candidateRoot);
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, `${JSON.stringify(nextCache, null, 2)}\n`);
  }

  if (!options.skipBundle) ensureViteBuild(candidateRoot);
  const candidateProbes = runProbes(candidateRoot, candidateRoot);
  const probeMetrics = diffProbes(baselineProbes, candidateProbes);
  const candidateReplays: ComparisonReport['candidateReplays'] = [];
  for (const name of options.scenarios) {
    const spec = resolveScenario(name);
    if (spec.kind === 'soak') candidateReplays.push(await runSoak(spec));
    else if (spec.kind === 'session-switch') {
      candidateReplays.push(await runReplay({ spec, onWaitTick: sessionSwitchTick(spec) }));
    } else {
      candidateReplays.push(await runReplay({ spec }));
    }
  }

  const probeGates = evaluateProbeGates({
    mountedRowsAt10k: metricValue(candidateProbes, 'feed.mountedRowsAt10k'),
    rowVisitsPerTailDeltaAt10k: metricValue(candidateProbes, 'feed.rowVisitsPerTailDeltaAt10k'),
    eventsRebuiltPerDelta: metricValue(candidateProbes, 'feed.eventsRebuiltPerDelta'),
    terminalDeliveriesPerFlood: metricValue(candidateProbes, 'terminal.deliveriesPerFlood'),
    livePrimarySessionsAfterSoak:
      candidateReplays.find((report) => report.scenario.kind === 'soak')?.sidecar.resources
        ?.livePrimarySessions ?? null,
  });
  const replayGates = candidateReplays.map((report) => report.gates);

  return {
    baselineRef: options.baselineRef,
    baselineCommit,
    candidateCommit,
    candidateTree: candidateRoot,
    baselineStale:
      options.includeBaseline && cache !== null && cache.baselineCommit !== baselineCommit,
    measuredAt: new Date().toISOString(),
    environment: { node: process.version, platform: `${process.platform}/${process.arch}` },
    probes: { baseline: baselineProbes, candidate: candidateProbes },
    metrics: [...probeMetrics, ...candidateReplayMetrics(candidateReplays)],
    candidateReplays,
    gates: mergeGateEvaluations([probeGates, ...replayGates]),
    skippedScenarios: SKIPPED_PERF_SCENARIOS,
  };
}

export async function runGateSuite(candidateRoot: string): Promise<ComparisonReport> {
  return runComparison({
    baselineRef: DEFAULT_BASELINE_REF,
    refreshBaseline: false,
    skipBundle: true,
    includeBaseline: false,
    scenarios: GATE_SCENARIOS,
    candidateRoot,
  });
}

function measureBaselineTree(
  candidateRoot: string,
  baselineRef: string,
  baselineCommit: string,
  skipBundle: boolean,
): AbProbeResult {
  const worktree = join('/tmp', `droidex-perf-baseline-${baselineCommit.slice(0, 12)}`);
  if (!existsSync(worktree)) {
    git(candidateRoot, ['worktree', 'add', '--detach', worktree, baselineCommit]);
    linkModules(candidateRoot, worktree);
  }
  if (!skipBundle) ensureViteBuild(worktree);
  const probes = runProbes(candidateRoot, worktree);
  return { ...probes, treeRoot: `${baselineRef}@${baselineCommit}` };
}

function runProbes(candidateRoot: string, treeRoot: string): AbProbeResult {
  const script = join(candidateRoot, 'tools/perf-ab-probes.ts');
  const output = execFileSync(process.execPath, ['--import', 'tsx', script, treeRoot], {
    encoding: 'utf8',
    cwd: candidateRoot,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return JSON.parse(output) as AbProbeResult;
}

function ensureViteBuild(treeRoot: string): void {
  if (existsSync(join(treeRoot, 'dist/index.html'))) return;
  execFileSync(process.execPath, [join(treeRoot, 'node_modules/vite/bin/vite.js'), 'build'], {
    cwd: treeRoot,
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'production' },
  });
}

function linkModules(candidateRoot: string, worktree: string): void {
  const rootModules = join(candidateRoot, 'node_modules');
  const sidecarModules = join(candidateRoot, 'sidecar/node_modules');
  if (!existsSync(join(worktree, 'node_modules')) && existsSync(rootModules)) {
    execFileSync('ln', ['-s', rootModules, join(worktree, 'node_modules')]);
  }
  if (!existsSync(join(worktree, 'sidecar/node_modules')) && existsSync(sidecarModules)) {
    execFileSync('ln', ['-s', sidecarModules, join(worktree, 'sidecar/node_modules')]);
  }
}

function readCache(path: string): BaselineCache | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as BaselineCache;
}

function metricValue(result: AbProbeResult, id: string): number | null {
  const value = result.metrics.find((metric) => metric.id === id)?.value;
  return value !== undefined && Number.isFinite(value) ? value : null;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}
