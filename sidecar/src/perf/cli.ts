// CLI entry for the deterministic perf replay harness (#116 phase 0).
//
//   npm --prefix sidecar run perf:replay -- --scenario multi-agent
//   npm --prefix sidecar run perf:replay -- --scenario smoke --enforce-budgets
//
// Writes JSON + Markdown artifacts to reports/perf/ (gitignored) and exits
// non-zero when a run fails or when --enforce-budgets finds a breach.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runReplay } from './runner.js';
import { PERF_SCENARIOS, resolveScenario } from './scenario.js';
import { renderReportMarkdown } from './report.js';

interface CliOptions {
  scenario: string;
  seed?: number;
  enforceBudgets: boolean;
  outDir: string;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    scenario: 'smoke',
    enforceBudgets: false,
    outDir: defaultOutDir(),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--list') {
      console.log('Available scenarios:');
      for (const name of Object.keys(PERF_SCENARIOS)) console.log(`  - ${name}`);
      process.exit(0);
    } else if (arg === '--enforce-budgets') {
      options.enforceBudgets = true;
    } else if (arg === '--scenario') {
      options.scenario = requiredValue(argv, ++index, arg);
    } else if (arg === '--seed') {
      options.seed = Number(requiredValue(argv, ++index, arg));
      if (!Number.isInteger(options.seed)) throw new Error('--seed must be an integer.');
    } else if (arg === '--out') {
      options.outDir = requiredValue(argv, ++index, arg);
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        'Usage: tsx src/perf/cli.ts [--scenario name] [--seed n] [--out dir] [--enforce-budgets] [--list]',
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
  // The CLI runs from the sidecar package via npm --prefix; artifacts belong
  // to the checkout, not the package. src/perf/cli.ts → sidecar/ → repo root.
  const sidecarDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
  return resolve(sidecarDir, '..', 'reports', 'perf');
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const spec = resolveScenario(
    options.scenario,
    options.seed === undefined ? {} : { seed: options.seed },
  );
  console.log(`Running perf replay scenario "${spec.name}" (seed ${String(spec.seed)})...`);
  const report = await runReplay({ spec });
  mkdirSync(options.outDir, { recursive: true });
  const jsonPath = join(options.outDir, `${spec.name}.json`);
  const markdownPath = join(options.outDir, `${spec.name}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(markdownPath, renderReportMarkdown(report));
  writeFileSync(join(options.outDir, 'latest.md'), renderReportMarkdown(report));
  console.log(renderReportMarkdown(report));
  console.log(`Artifacts: ${jsonPath}`);
  if (!report.budgets.allMeasuredPassed) {
    console.error('Budget status: FAILED (see report).');
    if (options.enforceBudgets) process.exitCode = 1;
  } else {
    console.log('Budget status: passed.');
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
