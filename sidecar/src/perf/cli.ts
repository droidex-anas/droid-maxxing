// CLI entry for the deterministic perf replay harness (#116/#126).
//
//   npm run perf:replay -- --scenario multi-agent
//   npm run perf:replay -- --scenario smoke --enforce-gates
//   npm run perf:compare -- --baseline origin/main
//   npm run perf:gates
//
// Writes JSON + Markdown artifacts to reports/perf/ (gitignored).

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderComparisonMarkdown } from './abReport.js';
import {
  DEFAULT_BASELINE_REF,
  DEFAULT_COMPARE_SCENARIOS,
  defaultCandidateRoot,
  runComparison,
  runGateSuite,
} from './abRunner.js';
import { runSoak, sessionSwitchTick } from './lifecycle.js';
import { renderReportMarkdown } from './report.js';
import { runReplay } from './runner.js';
import { PERF_SCENARIOS, resolveScenario, SKIPPED_PERF_SCENARIOS } from './scenario.js';

interface CliOptions {
  mode: 'replay' | 'compare' | 'gates';
  scenario: string;
  seed?: number;
  enforceBudgets: boolean;
  enforceGates: boolean;
  refreshBaseline: boolean;
  skipBundle: boolean;
  baselineRef: string;
  outDir: string;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    mode: 'replay',
    scenario: 'smoke',
    enforceBudgets: false,
    enforceGates: false,
    refreshBaseline: false,
    skipBundle: false,
    baselineRef: DEFAULT_BASELINE_REF,
    outDir: defaultOutDir(),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--list') {
      console.log('Available scenarios:');
      for (const name of Object.keys(PERF_SCENARIOS)) console.log(`  - ${name}`);
      console.log('Skipped (documented, not runnable here):');
      for (const [name, reason] of Object.entries(SKIPPED_PERF_SCENARIOS)) {
        console.log(`  - ${name}: ${reason}`);
      }
      process.exit(0);
    } else if (arg === '--compare') {
      options.mode = 'compare';
    } else if (arg === '--gates') {
      options.mode = 'gates';
    } else if (arg === '--enforce-budgets') {
      options.enforceBudgets = true;
    } else if (arg === '--enforce-gates') {
      options.enforceGates = true;
    } else if (arg === '--refresh-baseline') {
      options.refreshBaseline = true;
    } else if (arg === '--skip-bundle') {
      options.skipBundle = true;
    } else if (arg === '--scenario') {
      options.scenario = requiredValue(argv, ++index, arg);
    } else if (arg === '--baseline') {
      options.baselineRef = requiredValue(argv, ++index, arg);
    } else if (arg === '--seed') {
      options.seed = Number(requiredValue(argv, ++index, arg));
      if (!Number.isInteger(options.seed)) throw new Error('--seed must be an integer.');
    } else if (arg === '--out') {
      options.outDir = requiredValue(argv, ++index, arg);
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        'Usage: tsx src/perf/cli.ts [--scenario name] [--seed n] [--out dir] [--enforce-budgets] [--enforce-gates] [--compare] [--gates] [--baseline ref] [--refresh-baseline] [--skip-bundle] [--list]',
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument "${arg}".`);
    }
  }
  return options;
}

function requiredValue(argv: string[], index: number, flag: string): string {
  const value = argv.at(index);
  if (value === undefined) throw new Error(`${flag} requires a value.`);
  return value;
}

function defaultOutDir(): string {
  const sidecarDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
  return resolve(sidecarDir, '..', 'reports', 'perf');
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  mkdirSync(options.outDir, { recursive: true });
  if (options.mode === 'compare' || options.mode === 'gates') {
    const report =
      options.mode === 'gates'
        ? await runGateSuite(defaultCandidateRoot())
        : await runComparison({
            baselineRef: options.baselineRef,
            refreshBaseline: options.refreshBaseline,
            skipBundle: options.skipBundle,
            includeBaseline: true,
            scenarios: DEFAULT_COMPARE_SCENARIOS,
            candidateRoot: defaultCandidateRoot(),
          });
    const markdown = renderComparisonMarkdown(report);
    const jsonPath = join(options.outDir, `${options.mode}.json`);
    writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(join(options.outDir, `${options.mode}.md`), markdown);
    writeFileSync(join(options.outDir, 'latest.md'), markdown);
    console.log(markdown);
    console.log(`Artifacts: ${jsonPath}`);
    if (!report.gates.hardPassed) {
      console.error('Gate status: FAILED (see report).');
      if (options.enforceGates || options.mode === 'gates') process.exitCode = 1;
    } else {
      console.log('Gate status: passed.');
    }
    return;
  }

  const spec = resolveScenario(
    options.scenario,
    options.seed === undefined ? {} : { seed: options.seed },
  );
  console.log(`Running perf replay scenario "${spec.name}" (seed ${String(spec.seed)})...`);
  let report;
  if (spec.kind === 'soak') {
    report = await runSoak(spec);
  } else if (spec.kind === 'session-switch') {
    report = await runReplay({ spec, onWaitTick: sessionSwitchTick(spec) });
  } else {
    report = await runReplay({ spec });
  }
  const jsonPath = join(options.outDir, `${spec.name}.json`);
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(options.outDir, `${spec.name}.md`), renderReportMarkdown(report));
  writeFileSync(join(options.outDir, 'latest.md'), renderReportMarkdown(report));
  console.log(renderReportMarkdown(report));
  console.log(`Artifacts: ${jsonPath}`);
  if (!report.budgets.allMeasuredPassed) {
    console.error('Budget status: FAILED (see report).');
    if (options.enforceBudgets) process.exitCode = 1;
  } else {
    console.log('Budget status: passed.');
  }
  if (!report.gates.hardPassed) {
    console.error('Gate status: FAILED (see report).');
    if (options.enforceGates) process.exitCode = 1;
  } else {
    console.log('Gate status: passed.');
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
