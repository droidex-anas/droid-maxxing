import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { sleep } from './gui-bench-cdp.ts';
import {
  cpuPercent,
  launchApp,
  prepareBenchHome,
  sampleProcessTree,
  seedTemplate,
  stopApp,
  totalRssBytes,
  type BenchTree,
  type LaunchedApp,
} from './gui-bench-launch.ts';
import { GUI_BENCH_PROBE_SOURCE } from './gui-bench-probe.ts';
import { GUI_BENCH_SESSION_IDS } from './gui-bench-seed.ts';

interface ScrollSpeed {
  name: 'gentle' | 'normal' | 'flick';
  deltaY: number;
  ticks: number;
  intervalMs: number;
}

interface ScrollMetrics {
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

interface RunResult {
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

interface StreamingMetrics {
  wired: boolean;
  reason?: string;
  durationMs: number;
  droppedFrames: number;
  longestFrameMs: number;
  longTasksOver50Ms: number;
  receiveToPaintP50Ms?: number;
  receiveToPaintP95Ms?: number;
  receiveToPaintMaxMs?: number;
  cpuPercent: number;
  rssBytes: number;
}

const SPEEDS: ScrollSpeed[] = [
  { name: 'gentle', deltaY: -40, ticks: 40, intervalMs: 16 },
  { name: 'normal', deltaY: -120, ticks: 30, intervalMs: 16 },
  { name: 'flick', deltaY: -480, ticks: 16, intervalMs: 16 },
];

const ARTIFACTS = '/opt/cursor/artifacts';
const WORK = '/tmp/droidex-gui-bench';

function parseArgs(argv: string[]): {
  runs: number;
  skipStreaming: boolean;
  trees: BenchTree[];
} {
  let runs = 3;
  let skipStreaming = false;
  const trees: BenchTree[] = [
    {
      name: 'baseline',
      root: '/home/ubuntu/wt/baseline-main',
      sha: gitSha('/home/ubuntu/wt/baseline-main'),
    },
    {
      name: 'candidate',
      root: '/home/ubuntu/wt/gui-bench',
      sha: gitSha('/home/ubuntu/wt/gui-bench'),
    },
  ];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--runs') runs = Number(requiredValue(argv, ++index, arg));
    if (arg === '--skip-streaming') skipStreaming = true;
  }
  return { runs, skipStreaming, trees };
}

function requiredValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value) throw new Error(`${flag} requires a value.`);
  return value;
}

function gitSha(root: string): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
}

async function installProbe(app: LaunchedApp): Promise<void> {
  await app.cdp.evaluate(GUI_BENCH_PROBE_SOURCE);
}

async function waitForSessions(app: LaunchedApp, timeoutMs = 40_000): Promise<string[]> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    await installProbe(app);
    const ids = await app.cdp.evaluate<string[]>('window.__guiBench.sessionIds()');
    if (
      ids.includes(GUI_BENCH_SESSION_IDS.chat3k) &&
      ids.includes(GUI_BENCH_SESSION_IDS.chat10k) &&
      ids.includes(GUI_BENCH_SESSION_IDS.chatChildren)
    ) {
      return ids;
    }
    await sleep(400);
  }
  const ids = await app.cdp.evaluate<string[]>('window.__guiBench.sessionIds()');
  throw new Error(`Seeded sessions never appeared. Found: ${ids.join(', ') || '(none)'}`);
}

async function openSession(
  app: LaunchedApp,
  sessionId: string,
): Promise<{ elapsedMs: number; mountedRows: number }> {
  await installProbe(app);
  return app.cdp.evaluate(`window.__guiBench.openSession(${JSON.stringify(sessionId)})`);
}

async function measureIdle(app: LaunchedApp, durationMs: number): Promise<{ cpu: number; rss: number; appMetrics: unknown }> {
  const before = sampleProcessTree(app.pid);
  await sleep(durationMs);
  const after = sampleProcessTree(app.pid);
  const appMetrics = await app.cdp.evaluate('window.__guiBench.metrics()');
  return { cpu: cpuPercent(before, after), rss: totalRssBytes(after), appMetrics };
}

async function measureScroll(app: LaunchedApp, speed: ScrollSpeed): Promise<ScrollMetrics> {
  await installProbe(app);
  const box = await app.cdp.evaluate<{ x: number; y: number } | null>('window.__guiBench.scrollerBox()');
  if (!box) throw new Error('Chat scroller not found.');
  const before = sampleProcessTree(app.pid);
  await app.cdp.evaluate('window.__guiBench.start()');
  for (let tick = 0; tick < speed.ticks; tick += 1) {
    await app.cdp.dispatchWheel(box.x, box.y, speed.deltaY);
    await sleep(speed.intervalMs);
  }
  await sleep(120);
  const snapshot = await app.cdp.evaluate<Omit<ScrollMetrics, 'speed' | 'cpuPercent' | 'rssBytes'>>(
    'window.__guiBench.stop()',
  );
  const after = sampleProcessTree(app.pid);
  return {
    speed: speed.name,
    ...snapshot,
    cpuPercent: cpuPercent(before, after),
    rssBytes: totalRssBytes(after),
  };
}

async function captureChat(app: LaunchedApp, label: string): Promise<string> {
  const path = join(ARTIFACTS, `${label}.png`);
  writeFileSync(path, await app.cdp.capturePng());
  return path;
}

async function runHistoryPass(tree: BenchTree, run: number, templateHome: string): Promise<RunResult> {
  const home = join(WORK, 'homes', `${tree.name}-${String(run)}`);
  const userDataDir = join(WORK, 'profiles', `${tree.name}-${String(run)}`);
  prepareBenchHome(templateHome, home);
  const app = await launchApp({
    tree,
    runId: `history-${tree.name}-${String(run)}`,
    cdpPort: 9222 + run * 2 + (tree.name === 'candidate' ? 1 : 0),
    home,
    userDataDir,
  });
  try {
    await waitForSessions(app);
    await app.cdp.evaluate('window.__guiBench.dismissOverlays()');
    const active = await app.cdp.evaluate<string | null>('window.__guiBench.activeSessionId()');
    if (active === GUI_BENCH_SESSION_IDS.chat10k) {
      await openSession(app, GUI_BENCH_SESSION_IDS.chat3k);
    }
    const cold = await openSession(app, GUI_BENCH_SESSION_IDS.chat10k);
    const idle = await measureIdle(app, 2_500);
    const scroll10k: ScrollMetrics[] = [];
    for (const speed of SPEEDS) scroll10k.push(await measureScroll(app, speed));
    const screenshotPath = await captureChat(app, `gui_bench_${tree.name}_10k_run${String(run)}`);
    const switch3k = await openSession(app, GUI_BENCH_SESSION_IDS.chat3k);
    const scroll3k: ScrollMetrics[] = [];
    for (const speed of SPEEDS) scroll3k.push(await measureScroll(app, speed));
    const switch10k = await openSession(app, GUI_BENCH_SESSION_IDS.chat10k);
    const childrenOpen = await openSession(app, GUI_BENCH_SESSION_IDS.chatChildren);
    const childRowCount = (await app.cdp.evaluate<string[]>('window.__guiBench.childRows()')).length;
    const childrenScroll = await measureScroll(app, SPEEDS[1]!);
    return {
      tree: tree.name,
      run,
      sha: tree.sha,
      coldOpen10kMs: cold.elapsedMs,
      switchTo3kMs: switch3k.elapsedMs,
      switchTo10kWarmMs: switch10k.elapsedMs,
      idleCpuPercent: idle.cpu,
      idleRssBytes: idle.rss,
      appMetricsIdle: idle.appMetrics,
      scroll3k,
      scroll10k,
      children: {
        openMs: childrenOpen.elapsedMs,
        mountedRows: childrenOpen.mountedRows,
        childRowCount,
        scroll: childrenScroll,
      },
      streaming: null,
      screenshotPath,
    };
  } finally {
    await stopApp(app);
    await sleep(800);
  }
}

function bundleReplaySidecar(): string {
  const outfile = join(WORK, 'gui-bench-replay-sidecar.mjs');
  execFileSync(
    join('/home/ubuntu/wt/gui-bench', 'sidecar/node_modules/.bin/esbuild'),
    [
      join('/home/ubuntu/wt/gui-bench', 'tools/gui-bench-replay-sidecar.ts'),
      '--bundle',
      '--platform=node',
      '--format=esm',
      `--banner:js=import{createRequire as __cr}from'module';const require=__cr(import.meta.url);`,
      `--outfile=${outfile}`,
    ],
    { stdio: 'inherit' },
  );
  return outfile;
}

async function runStreamingPass(
  tree: BenchTree,
  run: number,
  sidecarEntry: string,
): Promise<StreamingMetrics> {
  if (tree.name === 'baseline') {
    return {
      wired: false,
      reason:
        'origin/main has no sidecar/src/perf/replayRuntime.ts. Refusing to run the candidate replay sidecar under baseline Electron, which would mix trees.',
      durationMs: 0,
      droppedFrames: 0,
      longestFrameMs: 0,
      longTasksOver50Ms: 0,
      cpuPercent: 0,
      rssBytes: 0,
    };
  }
  const home = join(WORK, 'stream-homes', `${tree.name}-${String(run)}`);
  const userDataDir = join(WORK, 'stream-profiles', `${tree.name}-${String(run)}`);
  mkdirSync(home, { recursive: true });
  const app = await launchApp({
    tree,
    runId: `stream-${tree.name}-${String(run)}`,
    cdpPort: 9322 + run * 2 + (tree.name === 'candidate' ? 1 : 0),
    home,
    userDataDir,
    sidecarEntry,
    extraEnv: { GUI_BENCH_REPLAY_SCENARIO: 'streaming' },
  });
  try {
    await sleep(4_000);
    await installProbe(app);
    await app.cdp.evaluate('window.__guiBench.clickNewChat()');
    await sleep(1_200);
    const before = sampleProcessTree(app.pid);
    await app.cdp.evaluate('window.__guiBench.start()');
    const started = Date.now();
    await app.cdp.evaluate('window.__guiBench.sendPrompt("stream a long answer")');
    await sleep(8_000);
    const snapshot = await app.cdp.evaluate<{
      droppedFrames: number;
      longestFrameMs: number;
      longTasksOver50Ms: number;
      rendererPerf?: {
        receiveToPaintMs?: { p50Ms?: number; p95Ms?: number; maxMs?: number };
      };
    }>('window.__guiBench.stop()');
    const after = sampleProcessTree(app.pid);
    return {
      wired: true,
      durationMs: Date.now() - started,
      droppedFrames: snapshot.droppedFrames,
      longestFrameMs: snapshot.longestFrameMs,
      longTasksOver50Ms: snapshot.longTasksOver50Ms,
      receiveToPaintP50Ms: snapshot.rendererPerf?.receiveToPaintMs?.p50Ms,
      receiveToPaintP95Ms: snapshot.rendererPerf?.receiveToPaintMs?.p95Ms,
      receiveToPaintMaxMs: snapshot.rendererPerf?.receiveToPaintMs?.maxMs,
      cpuPercent: cpuPercent(before, after),
      rssBytes: totalRssBytes(after),
    };
  } catch (error) {
    return {
      wired: false,
      reason: error instanceof Error ? error.message : String(error),
      durationMs: 0,
      droppedFrames: 0,
      longestFrameMs: 0,
      longTasksOver50Ms: 0,
      cpuPercent: 0,
      rssBytes: 0,
    };
  } finally {
    await stopApp(app);
    await sleep(800);
  }
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const even = sorted.length % 2 === 0;
  if (even) return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
  return sorted[mid] ?? 0;
}

function spread(values: number[]): { median: number; min: number; max: number } {
  if (values.length === 0) return { median: 0, min: 0, max: 0 };
  return { median: median(values), min: Math.min(...values), max: Math.max(...values) };
}

function scrollSeries(results: RunResult[], tree: 'baseline' | 'candidate', chat: '3k' | '10k', speed: string) {
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

function fmt(stat: { median: number; min: number; max: number }, digits = 1): string {
  return `${stat.median.toFixed(digits)} [${stat.min.toFixed(digits)}–${stat.max.toFixed(digits)}]`;
}

function delta(a: number, b: number): string {
  const d = b - a;
  const sign = d > 0 ? '+' : '';
  return `${sign}${d.toFixed(1)}`;
}

function renderReport(results: RunResult[], trees: BenchTree[]): string {
  const baseline = results.filter((result) => result.tree === 'baseline');
  const candidate = results.filter((result) => result.tree === 'candidate');
  const lines: string[] = [];
  lines.push('# DROIDEX GUI bench: origin/main vs cursor/perf-integration-e50f');
  lines.push('');
  lines.push('## Caveat');
  lines.push('');
  lines.push(
    'This VM software-rasterizes (GPU process fails). Absolute FPS is not the owner’s machine. Relative CPU, main-thread long tasks, dropped rAF frames, RSS, and blank-during-scroll **are** the comparison.',
  );
  lines.push('');
  lines.push('## Refs');
  lines.push('');
  for (const tree of trees) lines.push(`- **${tree.name}** \`${tree.sha}\` (${tree.root})`);
  lines.push('');
  lines.push('## Method');
  lines.push('');
  lines.push('- One app at a time, alternating baseline/candidate, 3 runs each.');
  lines.push('- Seeded Factory JSONL history (~3k events, ~10k events, 24-child chat).');
  lines.push('- Drive via CDP `Input.dispatchMouseEvent` `mouseWheel`.');
  lines.push('- Frames: in-page `requestAnimationFrame` timestamps. A drop is a rAF gap > 1.5×16.67 ms.');
  lines.push('- Long tasks: `PerformanceObserver({type:\'longtask\'})` > 50 ms.');
  lines.push('- Blank: each rAF, largest contiguous viewport gap not covered by `[data-feed-row-id]`. A hit is a hole taller than 96px (one estimated row), not ordinary 16px list gaps.');
  lines.push(
    'Candidate launch required hoisting `let mainWindow = null` above `sidecarSupervisor.subscribe` in `electron/main.cjs`. As committed on `cursor/perf-integration-e50f` (`76bdea9`), Electron throws `Cannot access \'mainWindow\' before initialization` and never creates a window. Measurement used that hoist; it is not a renderer/virtualizer change.',
  );
  lines.push('');
  const metric = (
    name: string,
    pick: (row: RunResult) => number,
  ) => {
    const b = spread(baseline.map(pick));
    const c = spread(candidate.map(pick));
    lines.push(`| ${name} | ${fmt(b)} | ${fmt(c)} | ${delta(b.median, c.median)} |`);
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
  metric('children mounted rows', (row) => row.children.mountedRows);
  metric('visible subagent rows', (row) => row.children.childRowCount);
  lines.push('');
  for (const chat of ['3k', '10k'] as const) {
    lines.push(`## Scroll quality (${chat})`);
    lines.push('');
    lines.push('| speed | metric | baseline | candidate | Δ |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const speed of SPEEDS) {
      const b = scrollSeries(results, 'baseline', chat, speed.name);
      const c = scrollSeries(results, 'candidate', chat, speed.name);
      const row = (label: string, left: { median: number }, right: { median: number }, l: typeof b.dropped, r: typeof c.dropped) => {
        lines.push(
          `| ${speed.name} | ${label} | ${fmt(l)} | ${fmt(r)} | ${delta(left.median, right.median)} |`,
        );
      };
      row('dropped rAF frames', b.dropped, c.dropped, b.dropped, c.dropped);
      row('longest frame (ms)', b.longest, c.longest, b.longest, c.longest);
      row('long tasks >50ms', b.longTasks, c.longTasks, b.longTasks, c.longTasks);
      row('blank hit ratio (hole>96px)', b.blankHit, c.blankHit, b.blankHit, c.blankHit);
      row('blank duration (ms)', b.blankMs, c.blankMs, b.blankMs, c.blankMs);
      row('blank max ratio', b.blankMax, c.blankMax, b.blankMax, c.blankMax);
      row('largest hole (px)', b.holePx, c.holePx, b.holePx, c.holePx);
      row('mounted rows', b.mounted, c.mounted, b.mounted, c.mounted);
      row('CPU % during scroll', b.cpu, c.cpu, b.cpu, c.cpu);
      row('RSS after (MiB)', { median: b.rss.median / (1024 * 1024) }, { median: c.rss.median / (1024 * 1024) }, { median: b.rss.median / (1024 * 1024), min: b.rss.min / (1024 * 1024), max: b.rss.max / (1024 * 1024) }, { median: c.rss.median / (1024 * 1024), min: c.rss.min / (1024 * 1024), max: c.rss.max / (1024 * 1024) });
    }
    lines.push('');
  }
  lines.push('## Streaming');
  lines.push('');
  const streamB = baseline.map((row) => row.streaming).filter((row): row is StreamingMetrics => Boolean(row));
  const streamC = candidate.map((row) => row.streaming).filter((row): row is StreamingMetrics => Boolean(row));
  if (streamB.length === 0 && streamC.length === 0) {
    lines.push('Streaming pass did not run.');
  } else {
    lines.push('| metric | baseline | candidate | Δ |');
    lines.push('| --- | --- | --- | --- |');
    const s = (pick: (row: StreamingMetrics) => number) => {
      const b = spread(streamB.map(pick));
      const c = spread(streamC.map(pick));
      return { b, c };
    };
    const add = (name: string, pick: (row: StreamingMetrics) => number) => {
      const { b, c } = s(pick);
      lines.push(`| ${name} | ${fmt(b)} | ${fmt(c)} | ${delta(b.median, c.median)} |`);
    };
    add('dropped rAF frames', (row) => row.droppedFrames);
    add('longest frame (ms)', (row) => row.longestFrameMs);
    add('long tasks >50ms', (row) => row.longTasksOver50Ms);
    add('receiveToPaint p50 (ms)', (row) => row.receiveToPaintP50Ms ?? 0);
    add('receiveToPaint p95 (ms)', (row) => row.receiveToPaintP95Ms ?? 0);
    add('CPU %', (row) => row.cpuPercent);
    const failed = [...streamB, ...streamC].filter((row) => !row.wired);
    if (failed.length > 0) {
      lines.push('');
      lines.push('Streaming wiring failures:');
      for (const row of failed) lines.push(`- ${row.reason ?? 'unknown'}`);
    }
  }
  lines.push('');
  lines.push('## Raw runs');
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify(results, null, 2));
  lines.push('```');
  return `${lines.join('\n')}\n`;
}

async function main(): Promise<void> {
  mkdirSync(ARTIFACTS, { recursive: true });
  mkdirSync(WORK, { recursive: true });
  const { runs, skipStreaming, trees } = parseArgs(process.argv.slice(2));
  const templateHome = join(WORK, 'template-home');
  const manifest = seedTemplate(templateHome);
  writeFileSync(join(ARTIFACTS, 'gui_bench_seed_manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const results: RunResult[] = [];
  for (let run = 1; run <= runs; run += 1) {
    for (const tree of trees) {
      process.stdout.write(`\n== history ${tree.name} run ${String(run)} ==\n`);
      const result = await runHistoryPass(tree, run, templateHome);
      results.push(result);
      writeFileSync(join(ARTIFACTS, 'gui_bench_raw.json'), `${JSON.stringify(results, null, 2)}\n`);
    }
  }
  if (!skipStreaming) {
    const sidecarEntry = bundleReplaySidecar();
    for (let run = 1; run <= runs; run += 1) {
      for (const tree of trees) {
        process.stdout.write(`\n== streaming ${tree.name} run ${String(run)} ==\n`);
        const streaming = await runStreamingPass(tree, run, sidecarEntry);
        const row = results.find((result) => result.tree === tree.name && result.run === run);
        if (row) row.streaming = streaming;
        writeFileSync(join(ARTIFACTS, 'gui_bench_raw.json'), `${JSON.stringify(results, null, 2)}\n`);
      }
    }
  }
  const report = renderReport(results, trees);
  writeFileSync(join(ARTIFACTS, 'gui_bench_report.md'), report);
  process.stdout.write(report);
}

await main();
