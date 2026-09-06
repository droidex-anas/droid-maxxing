import type { ComparisonMetric, ComparisonReport } from './abCompare.js';

export function renderComparisonMarkdown(report: ComparisonReport): string {
  const lines: string[] = [
    '# Perf comparison',
    '',
    `- Date: ${report.measuredAt}`,
    `- Baseline: \`${report.baselineRef}\` @ \`${report.baselineCommit}\`${report.baselineStale ? ' (cache was stale and was refreshed)' : ''}`,
    `- Candidate: \`${report.candidateCommit}\``,
    `- Node ${report.environment.node} on ${report.environment.platform}`,
    '',
    'A/B-measurable metrics ran on both refs using this branch’s probes against each tree’s own production APIs. Candidate-only metrics have no baseline; they are absolute numbers against budgets, not improvements.',
    '',
    '## A/B-measurable',
    '',
    '| Metric | Baseline | Candidate | Delta | Δ% | Method |',
    '| --- | --- | --- | --- | --- | --- |',
    ...report.metrics.filter((metric) => metric.class === 'ab').map(abRow),
    '',
    '## Candidate-only (not an improvement claim)',
    '',
    '| Metric | Candidate | Unit | Method |',
    '| --- | --- | --- | --- |',
    ...report.metrics.filter((metric) => metric.class === 'candidate').map(candidateRow),
    '',
    '## Deterministic gates',
    '',
    '| Gate | Actual | Budget | Mode | Status |',
    '| --- | --- | --- | --- | --- |',
    ...report.gates.results.map(
      (result) =>
        `| ${result.name} | ${fmt(result.actual)} | ${fmt(result.budget)} | ${result.mode} | ${result.status} |`,
    ),
    '',
    report.gates.hardPassed
      ? 'All measured hard gates passed.'
      : 'One or more hard gates failed or were unmeasured.',
    '',
    '## Scenarios not run here',
    '',
    ...Object.entries(report.skippedScenarios).map(([name, reason]) => `- \`${name}\`: ${reason}`),
    '',
  ];
  if (report.probes.baseline?.notes.length || report.probes.candidate.notes.length) {
    lines.push('## Probe notes', '');
    for (const note of report.probes.baseline?.notes ?? []) lines.push(`- Baseline: ${note}`);
    for (const note of report.probes.candidate.notes) lines.push(`- Candidate: ${note}`);
    lines.push('');
  }
  return lines.join('\n');
}

function abRow(metric: ComparisonMetric): string {
  return `| \`${metric.id}\` | ${fmt(metric.baseline)} | ${fmt(metric.candidate)} | ${fmt(metric.delta)} | ${pct(metric.deltaPercent)} | ${metric.method} |`;
}

function candidateRow(metric: ComparisonMetric): string {
  return `| \`${metric.id}\` | ${fmt(metric.candidate)} | ${metric.unit} | ${metric.method} |`;
}

function fmt(value: number | null): string {
  if (value === null) return '—';
  if (!Number.isFinite(value)) return 'n/a';
  if (Math.abs(value) >= 1000) return String(Math.round(value));
  return String(Math.round(value * 1000) / 1000);
}

function pct(value: number | null): string {
  if (value === null) return '—';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(1)}%`;
}
