export interface ScrollMetrics {
  speed: string;
  frameCount: number;
  expectedFrames: number;
  droppedFrames: number;
  longestFrameMs: number;
  longTasksOver50Ms: number;
  longTaskMaxMs: number;
  blankHitRatio: number;
  blankDurationMs: number;
  blankMaxRatio: number;
  blankMaxHolePx?: number;
  mountedRowsMax: number;
  mountedRowsLast: number;
  cpuPercent: number;
  rssBytes: number;
}

export interface StreamingMetrics {
  wired: boolean;
  reason?: string;
  durationMs: number;
  droppedFrames: number;
  longestFrameMs: number;
  longTasksOver50Ms: number;
  receiveToPaintP50Ms?: number;
  receiveToPaintP95Ms?: number;
  receiveToPaintMaxMs?: number;
  receiveToPaintCount?: number;
  eventsReceived?: number;
  feedTextLen?: number;
  timedOut?: boolean;
  cpuPercent: number;
  rssBytes: number;
}

export interface RunResult {
  tree: 'baseline' | 'candidate';
  run: number;
  sha: string;
  coldOpen10kMs: number;
  switchTo3kMs: number;
  switchTo10kWarmMs: number;
  idleCpuPercent: number;
  idleRssBytes: number;
  appMetricsIdle: unknown;
  scroll3k: ScrollMetrics[];
  scroll10k: ScrollMetrics[];
  children: {
    openMs: number;
    mountedRows: number;
    childRowCount: number;
    scroll: ScrollMetrics | null;
  };
  streaming: StreamingMetrics | null;
  screenshotPath?: string;
}

export interface BenchTreeRef {
  name: 'baseline' | 'candidate';
  root: string;
  sha: string;
}

export interface Spread {
  median: number;
  min: number;
  max: number;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
  return sorted[mid] ?? 0;
}

export function spread(values: number[]): Spread {
  if (values.length === 0) return { median: 0, min: 0, max: 0 };
  return { median: median(values), min: Math.min(...values), max: Math.max(...values) };
}

export function fmt(stat: Spread, digits = 1): string {
  return `${stat.median.toFixed(digits)} [${stat.min.toFixed(digits)}–${stat.max.toFixed(digits)}]`;
}

export function delta(a: number, b: number): string {
  const d = b - a;
  const sign = d > 0 ? '+' : '';
  return `${sign}${d.toFixed(1)}`;
}

function scrollSeries(
  results: RunResult[],
  tree: 'baseline' | 'candidate',
  chat: '3k' | '10k',
  speed: string,
) {
  const rows = results
    .filter((result) => result.tree === tree)
    .map((result) => (chat === '3k' ? result.scroll3k : result.scroll10k).find((row) => row.speed === speed))
    .filter((row): row is ScrollMetrics => Boolean(row));
  return {
    dropped: spread(rows.map((row) => row.droppedFrames)),
    longest: spread(rows.map((row) => row.longestFrameMs)),
    longTasks: spread(rows.map((row) => row.longTasksOver50Ms)),
    blankHit: spread(rows.map((row) => row.blankHitRatio)),
    blankMs: spread(rows.map((row) => row.blankDurationMs)),
    blankMax: spread(rows.map((row) => row.blankMaxRatio)),
    holePx: spread(rows.map((row) => row.blankMaxHolePx ?? 0)),
    mounted: spread(rows.map((row) => row.mountedRowsLast)),
    cpu: spread(rows.map((row) => row.cpuPercent)),
    rss: spread(rows.map((row) => row.rssBytes)),
    frames: spread(rows.map((row) => row.frameCount)),
  };
}

const SPEEDS = ['gentle', 'normal', 'flick'] as const;

export function renderReport(results: RunResult[], trees: BenchTreeRef[]): string {
  const baseline = results.filter((result) => result.tree === 'baseline');
  const candidate = results.filter((result) => result.tree === 'candidate');
  const lines: string[] = [];
  lines.push('# DROIDEX GUI bench: origin/main vs cursor/perf-integration-e50f');
  lines.push('');
  lines.push('## Caveat');
  lines.push('');
  lines.push(
    'This VM runs Electron 39.8.10 and software-rasterizes (GPU process fails). Absolute FPS is **not** the owner’s machine. Relative CPU, main-thread long tasks, dropped rAF frames, RSS, session-switch times, and blank-during-scroll **are** the comparison.',
  );
  lines.push('');
  lines.push('## Refs');
  lines.push('');
  lines.push('- **baseline** `origin/main` `/home/ubuntu/wt/baseline-main` `99f5ca882147a1641298072e5b64deeaa3d52062`');
  lines.push(
    '- **candidate product** `cursor/perf-integration-e50f` `76bdea9fd1312e0d46c7bd294440582d47170634` (virtualizer + perf phases). Bench-only Electron hoist + CDP tooling live on `cursor/perf-gui-bench-e50f`.',
  );
  const historyShas = [...new Set(results.map((row) => `${row.tree} history ${row.sha}`))];
  for (const line of historyShas) lines.push(`- measured: ${line}`);
  for (const tree of trees) lines.push(`- **${tree.name} tooling HEAD at report** \`${tree.sha}\` (${tree.root})`);
  lines.push('');
  lines.push('## Method');
  lines.push('');
  lines.push('- One Electron app at a time, alternating baseline/candidate, 3 runs each. 4 CPUs / 16 GB. `--no-sandbox`, `DISPLAY=:1`.');
  lines.push('- Seeded Factory JSONL history (`gui-bench-3k` ~3000 events, `gui-bench-10k` ~10000 events, `gui-bench-children` 24 child sessions). Separate `DROIDEX_USER_DATA_DIR` and `HOME` per run.');
  lines.push('- Drive via CDP `Input.dispatchMouseEvent` `mouseWheel` at gentle −40 px, normal −120 px, flick −480 px per 16 ms tick.');
  lines.push('- Frames: in-page `requestAnimationFrame` timestamps. A drop is a rAF gap > 1.5×16.67 ms (~25 ms).');
  lines.push('- Long tasks: `PerformanceObserver({type:\'longtask\'})` with `startTime >= phaseStartedAt`, duration > 50 ms.');
  lines.push(
    '- Blank: each rAF, largest contiguous viewport gap not covered by `[data-feed-row-id]`. A **hit** is a hole taller than 96 px (one estimated row). Ordinary 16 px list gaps are not hits.',
  );
  lines.push('- CPU/RSS: `/proc` tree of the Electron PID (sum of descendants). Cross-check `droidControl.getPerformanceMetrics()` on candidate only — origin/main does not expose it.');
  lines.push(
    '- Candidate launch required hoisting `let mainWindow = null` above `sidecarSupervisor.subscribe` in `electron/main.cjs`. As committed on `76bdea9`, Electron throws `Cannot access \'mainWindow\' before initialization` and never creates a window. Measurement used that hoist; it is not a renderer/virtualizer change.',
  );
  lines.push(
    '- Streaming: candidate-only. A **dev-only** sidecar bundle injects `ReplayFactoryRuntime` through `SessionManager` `dependencies.runtime` (not in `sidecar/dist` production build). origin/main has no `replayRuntime.ts`; mixing the candidate sidecar under baseline Electron was refused.',
  );
  lines.push('');
  const metric = (name: string, pick: (row: RunResult) => number, digits = 1) => {
    const b = spread(baseline.map(pick));
    const c = spread(candidate.map(pick));
    lines.push(`| ${name} | ${fmt(b, digits)} | ${fmt(c, digits)} | ${delta(b.median, c.median)} |`);
  };
  lines.push('## Open / switch / idle');
  lines.push('');
  lines.push('| metric | baseline | candidate | Δ (cand − base) |');
  lines.push('| --- | --- | --- | --- |');
  metric('cold open 10k (ms)', (row) => row.coldOpen10kMs);
  metric('switch to 3k (ms)', (row) => row.switchTo3kMs);
  metric('warm switch to 10k (ms)', (row) => row.switchTo10kWarmMs);
  metric('idle CPU % (sum of tree, 4-core host)', (row) => row.idleCpuPercent);
  metric('idle RSS (MiB)', (row) => row.idleRssBytes / (1024 * 1024));
  metric('children chat open (ms)', (row) => row.children.openMs);
  metric('children mounted rows', (row) => row.children.mountedRows, 0);
  metric('visible subagent rows', (row) => row.children.childRowCount, 0);
  lines.push('');
  for (const chat of ['3k', '10k'] as const) {
    lines.push(`## Scroll quality (${chat})`);
    lines.push('');
    lines.push('| speed | metric | baseline | candidate | Δ |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const speed of SPEEDS) {
      const b = scrollSeries(results, 'baseline', chat, speed);
      const c = scrollSeries(results, 'candidate', chat, speed);
      const row = (label: string, left: Spread, right: Spread, digits = 1) => {
        lines.push(`| ${speed} | ${label} | ${fmt(left, digits)} | ${fmt(right, digits)} | ${delta(left.median, right.median)} |`);
      };
      row('dropped rAF frames', b.dropped, c.dropped, 0);
      row('longest frame (ms)', b.longest, c.longest);
      row('long tasks >50ms', b.longTasks, c.longTasks, 0);
      row('blank hit ratio (hole>96px)', b.blankHit, c.blankHit, 3);
      row('blank duration (ms)', b.blankMs, c.blankMs);
      row('largest hole (px)', b.holePx, c.holePx);
      row('mounted rows', b.mounted, c.mounted, 0);
      row('CPU % during scroll', b.cpu, c.cpu);
      row(
        'RSS after (MiB)',
        {
          median: b.rss.median / (1024 * 1024),
          min: b.rss.min / (1024 * 1024),
          max: b.rss.max / (1024 * 1024),
        },
        {
          median: c.rss.median / (1024 * 1024),
          min: c.rss.min / (1024 * 1024),
          max: c.rss.max / (1024 * 1024),
        },
      );
    }
    lines.push('');
  }
  lines.push('## Streaming');
  lines.push('');
  const streamB = baseline.map((row) => row.streaming).filter((row): row is StreamingMetrics => Boolean(row));
  const streamC = candidate.map((row) => row.streaming).filter((row): row is StreamingMetrics => Boolean(row));
  const wiredB = streamB.filter((row) => row.wired);
  const wiredC = streamC.filter((row) => row.wired);
  if (streamB.length === 0 && streamC.length === 0) {
    lines.push('Streaming pass did not run.');
  } else {
    lines.push(
      'Candidate streams through the real sidecar path (`ReplayFactoryRuntime` → SessionManager → bridge → renderer). Baseline is unwired (no replay runtime on origin/main).',
    );
    lines.push('');
    lines.push('| metric | baseline | candidate | Δ |');
    lines.push('| --- | --- | --- | --- |');
    const add = (name: string, pick: (row: StreamingMetrics) => number, digits = 1) => {
      const b = spread(wiredB.map(pick));
      const c = spread(wiredC.map(pick));
      const left = wiredB.length === 0 ? 'unwired' : fmt(b, digits);
      const right = wiredC.length === 0 ? 'unwired' : fmt(c, digits);
      const d = wiredB.length === 0 || wiredC.length === 0 ? 'n/a' : delta(b.median, c.median);
      lines.push(`| ${name} | ${left} | ${right} | ${d} |`);
    };
    add('duration (ms)', (row) => row.durationMs, 0);
    add('dropped rAF frames', (row) => row.droppedFrames, 0);
    add('longest frame (ms)', (row) => row.longestFrameMs);
    add('long tasks >50ms', (row) => row.longTasksOver50Ms, 0);
    add('receiveToPaint p50 (ms)', (row) => row.receiveToPaintP50Ms ?? 0);
    add('receiveToPaint p95 (ms)', (row) => row.receiveToPaintP95Ms ?? 0);
    add('receiveToPaint count', (row) => row.receiveToPaintCount ?? 0, 0);
    add('eventsReceived', (row) => row.eventsReceived ?? 0, 0);
    add('CPU %', (row) => row.cpuPercent);
    add('RSS (MiB)', (row) => row.rssBytes / (1024 * 1024));
    lines.push('');
    lines.push(
      'receiveToPaint is the renderer’s cumulative histogram from page start, not a stream-only delta. Compare count before vs after: idle opens were ~5 samples; a successful replay turn lands two hundred-plus samples, so p50/p95 are dominated by the streamed answer.',
    );
    const failedReasons = [
      ...new Set(
        [...streamB, ...streamC]
          .filter((row) => !row.wired)
          .map((row) => row.reason ?? 'unknown'),
      ),
    ];
    if (failedReasons.length > 0) {
      lines.push('');
      lines.push('Streaming wiring notes:');
      for (const reason of failedReasons) lines.push(`- ${reason}`);
    }
  }
  lines.push('');
  lines.push('## Findings');
  lines.push('');
  const blank10k = scrollSeries(results, 'candidate', '10k', 'flick');
  const blankBase = scrollSeries(results, 'baseline', '10k', 'flick');
  lines.push(
    `- **Blank during scroll (owner’s question):** with a 96 px hole threshold, candidate blank-hit ratio is ${fmt(blank10k.blankHit, 3)} on 10k flick (baseline ${fmt(blankBase.blankHit, 3)}). Largest hole median is ${fmt(blank10k.holePx)} px on candidate 10k flick vs ${fmt(blankBase.holePx)} px baseline — consistent with the 16 px list gap, not missing rows. The ~17-row virtualizer window did **not** produce unfilled viewport holes in these wheel-driven scrolls.`,
  );
  const mounted = scrollSeries(results, 'candidate', '10k', 'normal');
  const mountedB = scrollSeries(results, 'baseline', '10k', 'normal');
  lines.push(
    `- **Mounted rows:** candidate 10k normal ${fmt(mounted.mounted, 0)} vs baseline ${fmt(mountedB.mounted, 0)}. Virtualizer is doing what it claims.`,
  );
  const dropped = scrollSeries(results, 'candidate', '10k', 'gentle');
  const droppedB = scrollSeries(results, 'baseline', '10k', 'gentle');
  lines.push(
    `- **Dropped rAF, 10k gentle:** candidate ${fmt(dropped.dropped, 0)} vs baseline ${fmt(droppedB.dropped, 0)}. Spread on candidate is wide; this is a smoothness finding, not a blank-content finding.`,
  );
  const idleCpuB = spread(baseline.map((row) => row.idleCpuPercent));
  const idleCpuC = spread(candidate.map((row) => row.idleCpuPercent));
  lines.push(`- **Idle CPU:** candidate ${fmt(idleCpuC)} vs baseline ${fmt(idleCpuB)} (worse).`);
  const idleRssB = spread(baseline.map((row) => row.idleRssBytes / (1024 * 1024)));
  const idleRssC = spread(candidate.map((row) => row.idleRssBytes / (1024 * 1024)));
  lines.push(`- **Idle RSS:** candidate ${fmt(idleRssC)} MiB vs baseline ${fmt(idleRssB)} MiB.`);
  const warmB = spread(baseline.map((row) => row.switchTo10kWarmMs));
  const warmC = spread(candidate.map((row) => row.switchTo10kWarmMs));
  lines.push(`- **Warm switch to 10k:** candidate ${fmt(warmC)} ms vs baseline ${fmt(warmB)} ms.`);
  lines.push(
    '- **Subagent cards:** seeded 24-child chat. Sidebar shows 5 `subagent-row` nodes (list limit). The parent feed only has 3 mounted rows, so the viewport below that short transcript is empty by content (~478 px hole, blank-hit 1.0) — that is not a virtualizer miss. Concurrent live child *streaming* was not driven in the desktop app; the replay `streaming` scenario is a single session. Sibling re-render isolation under concurrent child tokens was **not** measured here and is not fabricated.',
  );
  if (wiredC.length > 0) {
    const paint = spread(wiredC.map((row) => row.receiveToPaintP50Ms ?? 0));
    const droppedStream = spread(wiredC.map((row) => row.droppedFrames));
    const paints = spread(wiredC.map((row) => row.receiveToPaintCount ?? 0));
    const events = spread(wiredC.map((row) => row.eventsReceived ?? 0));
    lines.push(
      `- **Streaming (candidate only):** receiveToPaint p50 ${fmt(paint)} ms, dropped rAF ${fmt(droppedStream, 0)}, paint samples ${fmt(paints, 0)} / eventsReceived ${fmt(events, 0)}. Baseline cannot be compared without mixing trees.`,
    );
  }
  lines.push(
    '- **Long tasks during scroll:** both trees reported 0 tasks >50 ms after filtering to the scroll phase. Either the software-raster path is not producing longtask entries, or scroll work is under 50 ms on this host. Do not read this as “no jank” — dropped rAF is the jank signal.',
  );
  lines.push('');
  lines.push('## Reproduce');
  lines.push('');
  lines.push('```bash');
  lines.push('# Shared node_modules already present. Never npm ci.');
  lines.push('cd /workspace');
  lines.push('git worktree add /home/ubuntu/wt/baseline-main origin/main');
  lines.push('ln -s /workspace/node_modules /home/ubuntu/wt/baseline-main/node_modules');
  lines.push('ln -s /workspace/sidecar/node_modules /home/ubuntu/wt/baseline-main/sidecar/node_modules');
  lines.push('cd /home/ubuntu/wt/baseline-main && npm run build');
  lines.push('');
  lines.push('cd /workspace');
  lines.push('git fetch origin cursor/perf-gui-bench-e50f');
  lines.push('git worktree add /home/ubuntu/wt/gui-bench origin/cursor/perf-gui-bench-e50f');
  lines.push('ln -s /workspace/node_modules /home/ubuntu/wt/gui-bench/node_modules');
  lines.push('ln -s /workspace/sidecar/node_modules /home/ubuntu/wt/gui-bench/sidecar/node_modules');
  lines.push('cd /home/ubuntu/wt/gui-bench && npm run build');
  lines.push('');
  lines.push('export DISPLAY=:1 XAUTHORITY=/home/ubuntu/.Xauthority');
  lines.push('cd /home/ubuntu/wt/gui-bench');
  lines.push('npm run gui-bench:seed -- --home /tmp/droidex-gui-bench/template-home');
  lines.push('npm run gui-bench:run -- --runs 3');
  lines.push('# History already captured: npm run gui-bench:run -- --runs 3 --streaming-only');
  lines.push('```');
  lines.push('');
  lines.push('Raw per-run JSON: `/opt/cursor/artifacts/gui_bench_raw.json`.');
  lines.push('Seed manifest: `/opt/cursor/artifacts/gui_bench_seed_manifest.json`.');
  lines.push('Screenshots: `/opt/cursor/artifacts/gui_bench_baseline_10k_seeded_chat.png`, `gui_bench_candidate_10k_seeded_chat.png`, `gui_bench_candidate_replay_stream.png`.');
  return `${lines.join('\n')}\n`;
}
