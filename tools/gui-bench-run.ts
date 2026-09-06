import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
import { renderReport, type RunResult, type ScrollMetrics, type StreamingMetrics } from './gui-bench-report.ts';
import { runSendRenderPass, type SendRenderMetrics } from './gui-bench-send-render.ts';
import { GUI_BENCH_SESSION_IDS } from './gui-bench-seed.ts';

interface ScrollSpeed {
  name: 'gentle' | 'normal' | 'flick';
  deltaY: number;
  ticks: number;
  intervalMs: number;
}

const SPEEDS: ScrollSpeed[] = [
  { name: 'gentle', deltaY: -40, ticks: 40, intervalMs: 16 },
  { name: 'normal', deltaY: -120, ticks: 30, intervalMs: 16 },
  { name: 'flick', deltaY: -480, ticks: 16, intervalMs: 16 },
];

const ARTIFACTS = '/opt/cursor/artifacts';
const WORK = '/tmp/droidex-gui-bench';
const CANDIDATE_ROOT = '/home/ubuntu/wt/send-and-render';
const RAW_PATH = join(ARTIFACTS, 'gui_bench_raw.json');

function parseArgs(argv: string[]): {
  runs: number;
  skipStreaming: boolean;
  streamingOnly: boolean;
  sendRender: boolean;
  trees: BenchTree[];
} {
  let runs = 3;
  let skipStreaming = false;
  let streamingOnly = false;
  let sendRender = false;
  let candidateOnly = false;
  const allTrees: BenchTree[] = [
    {
      name: 'baseline',
      root: '/home/ubuntu/wt/baseline-main',
      sha: gitSha('/home/ubuntu/wt/baseline-main'),
    },
    {
      name: 'candidate',
      root: CANDIDATE_ROOT,
      sha: gitSha(CANDIDATE_ROOT),
    },
  ];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--runs') runs = Number(requiredValue(argv, ++index, arg));
    if (arg === '--skip-streaming') skipStreaming = true;
    if (arg === '--streaming-only') streamingOnly = true;
    if (arg === '--send-render') sendRender = true;
    if (arg === '--candidate-only') candidateOnly = true;
  }
  const trees = candidateOnly ? allTrees.filter((tree) => tree.name === 'candidate') : allTrees;
  return { runs, skipStreaming, streamingOnly, sendRender, trees };
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
      ids.includes(GUI_BENCH_SESSION_IDS.chatChildren) &&
      ids.includes(GUI_BENCH_SESSION_IDS.chatHeavy)
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

async function measureIdle(
  app: LaunchedApp,
  durationMs: number,
): Promise<{ cpu: number; rss: number; appMetrics: unknown }> {
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
  // Resolve native addons the same way production sidecar.mjs does: next to sidecar/dist.
  const outfile = join(CANDIDATE_ROOT, 'sidecar/dist/gui-bench-replay-sidecar.mjs');
  mkdirSync(join(CANDIDATE_ROOT, 'sidecar/dist'), { recursive: true });
  execFileSync(
    join(CANDIDATE_ROOT, 'sidecar/node_modules/.bin/esbuild'),
    [
      join(CANDIDATE_ROOT, 'tools/gui-bench-replay-sidecar.ts'),
      '--bundle',
      '--platform=node',
      '--format=esm',
      `--alias:@factory/droid-sdk=${join(CANDIDATE_ROOT, 'sidecar/node_modules/@factory/droid-sdk')}`,
      `--banner:js=import{createRequire as __cr}from'module';const require=__cr(import.meta.url);`,
      `--outfile=${outfile}`,
    ],
    { stdio: 'inherit', cwd: join(CANDIDATE_ROOT, 'sidecar') },
  );
  return outfile;
}

function unwiredStreaming(reason: string): StreamingMetrics {
  return {
    wired: false,
    reason,
    durationMs: 0,
    droppedFrames: 0,
    longestFrameMs: 0,
    longTasksOver50Ms: 0,
    cpuPercent: 0,
    rssBytes: 0,
  };
}

async function runStreamingPass(tree: BenchTree, run: number, sidecarEntry: string): Promise<StreamingMetrics> {
  if (tree.name === 'baseline') {
    return unwiredStreaming(
      'origin/main has no sidecar/src/perf/replayRuntime.ts. Refusing to run the candidate replay sidecar under baseline Electron, which would mix trees.',
    );
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
    await installProbe(app);
    await app.cdp.evaluate('window.__guiBench.waitForShell(25000)');
    await app.cdp.evaluate('window.__guiBench.dismissOverlays()');
    await app.cdp.evaluate('window.__guiBench.clickNewChat()');
    await app.cdp.evaluate('window.__guiBench.waitForSendReady(25000)');
    await app.cdp.evaluate(`(() => { const area = document.querySelector('textarea'); if (area) area.focus(); })()`);
    await app.cdp.insertText('stream a long answer');
    const before = sampleProcessTree(app.pid);
    await app.cdp.evaluate('window.__guiBench.start()');
    const started = Date.now();
    await app.cdp.evaluate('window.__guiBench.clickSend()');
    await app.cdp.dispatchEnter();
    const streamWait = await app.cdp.evaluate<{
      elapsedMs: number;
      textLen: number;
      paints: number;
      timedOut: boolean;
    }>('window.__guiBench.waitForStreamPaint(14000)');
    const snapshot = await app.cdp.evaluate<{
      droppedFrames: number;
      longestFrameMs: number;
      longTasksOver50Ms: number;
      rendererPerf?: {
        eventsReceived?: number;
        receiveToPaintMs?: { p50Ms?: number; p95Ms?: number; maxMs?: number; count?: number };
      };
    }>('window.__guiBench.stop()');
    const after = sampleProcessTree(app.pid);
    await captureChat(app, `gui_bench_${tree.name}_streaming_run${String(run)}`);
    const paint = snapshot.rendererPerf?.receiveToPaintMs;
    const wired = (paint?.count ?? 0) >= 8 || streamWait.textLen > 800;
    return {
      wired,
      reason: wired
        ? undefined
        : `Replay sidecar launched but stream did not paint enough (paints=${String(paint?.count ?? 0)}, textLen=${String(streamWait.textLen)}, timedOut=${String(streamWait.timedOut)}).`,
      durationMs: Date.now() - started,
      droppedFrames: snapshot.droppedFrames,
      longestFrameMs: snapshot.longestFrameMs,
      longTasksOver50Ms: snapshot.longTasksOver50Ms,
      receiveToPaintP50Ms: paint?.p50Ms,
      receiveToPaintP95Ms: paint?.p95Ms,
      receiveToPaintMaxMs: paint?.maxMs,
      receiveToPaintCount: paint?.count,
      eventsReceived: snapshot.rendererPerf?.eventsReceived,
      feedTextLen: streamWait.textLen,
      timedOut: streamWait.timedOut,
      cpuPercent: cpuPercent(before, after),
      rssBytes: totalRssBytes(after),
    };
  } catch (error) {
    try {
      await captureChat(app, `gui_bench_${tree.name}_streaming_fail_run${String(run)}`);
    } catch {
      // Window may already be gone.
    }
    return unwiredStreaming(error instanceof Error ? error.message : String(error));
  } finally {
    await stopApp(app);
    await sleep(800);
  }
}

function writeResults(results: RunResult[], trees: BenchTree[]): void {
  writeFileSync(RAW_PATH, `${JSON.stringify(results, null, 2)}\n`);
  const report = renderReport(results, trees);
  writeFileSync(join(ARTIFACTS, 'gui_bench_desktop_comparison.md'), report);
  writeFileSync(join(ARTIFACTS, 'gui_bench_report.md'), report);
  process.stdout.write(report);
}

function loadExistingResults(): RunResult[] {
  const parsed = JSON.parse(readFileSync(RAW_PATH, 'utf8')) as RunResult[];
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`${RAW_PATH} is missing or empty; run history first.`);
  }
  return parsed;
}

async function main(): Promise<void> {
  mkdirSync(ARTIFACTS, { recursive: true });
  mkdirSync(WORK, { recursive: true });
  const { runs, skipStreaming, streamingOnly, sendRender, trees } = parseArgs(process.argv.slice(2));
  if (sendRender) {
    const templateHome = join(WORK, 'template-home');
    const manifest = seedTemplate(templateHome);
    writeFileSync(join(ARTIFACTS, 'gui_bench_seed_manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    const sendResults: SendRenderMetrics[] = [];
    for (let run = 1; run <= runs; run += 1) {
      for (const tree of trees) {
        process.stdout.write(`\n== send-render ${tree.name} run ${String(run)} ==\n`);
        const result = await runSendRenderPass(tree, run, templateHome);
        sendResults.push(result);
        writeFileSync(join(ARTIFACTS, 'gui_bench_send_render.json'), `${JSON.stringify(sendResults, null, 2)}\n`);
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      }
    }
    return;
  }
  let results: RunResult[] = [];
  if (streamingOnly) {
    results = loadExistingResults();
  } else {
    const templateHome = join(WORK, 'template-home');
    const manifest = seedTemplate(templateHome);
    writeFileSync(join(ARTIFACTS, 'gui_bench_seed_manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    for (let run = 1; run <= runs; run += 1) {
      for (const tree of trees) {
        process.stdout.write(`\n== history ${tree.name} run ${String(run)} ==\n`);
        const result = await runHistoryPass(tree, run, templateHome);
        results.push(result);
        writeFileSync(RAW_PATH, `${JSON.stringify(results, null, 2)}\n`);
      }
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
        else process.stdout.write(`no history row for ${tree.name} run ${String(run)}; streaming kept only in log\n`);
        writeFileSync(RAW_PATH, `${JSON.stringify(results, null, 2)}\n`);
      }
    }
  }
  writeResults(results, trees);
}

await main();
