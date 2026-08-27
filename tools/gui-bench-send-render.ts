import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { sleep } from './gui-bench-cdp.ts';
import {
  cpuPercent,
  launchApp,
  prepareBenchHome,
  sampleProcessTree,
  stopApp,
  totalRssBytes,
  type BenchTree,
  type LaunchedApp,
} from './gui-bench-launch.ts';
import { GUI_BENCH_PROBE_SOURCE } from './gui-bench-probe.ts';
import { GUI_BENCH_SESSION_IDS } from './gui-bench-seed.ts';

const ARTIFACTS = '/opt/cursor/artifacts';

export interface SendRenderMetrics {
  run: number;
  loadavg: string;
  typingOn10k: TypingMetrics;
  echoOnHeavyMs: EchoMetrics;
  echo100kbMs: EchoMetrics;
  heavyOpenMs: number;
  heavyScroll: {
    droppedFrames: number;
    longestFrameMs: number;
    longTasksOver50Ms: number;
    longTaskMaxMs: number;
    cpuPercent: number;
  };
  mermaidSvgMs: number;
  mermaidFound: boolean;
  blockCounts: Record<string, number | boolean>;
}

interface TypingMetrics {
  count: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  meanMs: number;
}

interface EchoMetrics {
  elapsedMs: number;
  found: boolean;
  composerCleared: boolean;
  rows: number;
}

async function installProbe(app: LaunchedApp): Promise<void> {
  await app.cdp.evaluate(GUI_BENCH_PROBE_SOURCE);
}

async function openSession(app: LaunchedApp, sessionId: string): Promise<{ elapsedMs: number }> {
  await installProbe(app);
  return app.cdp.evaluate(`window.__guiBench.openSession(${JSON.stringify(sessionId)})`);
}

export async function runSendRenderPass(
  tree: BenchTree,
  run: number,
  templateHome: string,
): Promise<SendRenderMetrics> {
  const loadavg = (await import('node:fs')).readFileSync('/proc/loadavg', 'utf8').trim();
  const home = join('/tmp/droidex-gui-bench', 'send-homes', `${tree.name}-${String(run)}`);
  const userDataDir = join('/tmp/droidex-gui-bench', 'send-profiles', `${tree.name}-${String(run)}`);
  prepareBenchHome(templateHome, home);
  const app = await launchApp({
    tree,
    runId: `send-render-${tree.name}-${String(run)}`,
    cdpPort: 9422 + run,
    home,
    userDataDir,
  });
  try {
    await installProbe(app);
    await app.cdp.evaluate('window.__guiBench.waitForShell(40000)');
    await app.cdp.evaluate('window.__guiBench.dismissOverlays()');
    await waitForId(app, GUI_BENCH_SESSION_IDS.chatHeavy);
    const heavyOpen = await openSession(app, GUI_BENCH_SESSION_IDS.chatHeavy);
    await sleep(400);
    const mermaid = await app.cdp.evaluate<{ elapsedMs: number; found: boolean }>(
      'window.__guiBench.waitForMermaidSvg(8000)',
    );
    const blockCounts = await app.cdp.evaluate<Record<string, number | boolean>>(
      'window.__guiBench.heavyBlockCounts()',
    );
    await installProbe(app);
    await app.cdp.evaluate('window.__guiBench.start()');
    const box = await app.cdp.evaluate<{ x: number; y: number } | null>(
      'window.__guiBench.scrollerBox()',
    );
    const before = sampleProcessTree(app.pid);
    if (box) {
      for (let tick = 0; tick < 24; tick += 1) {
        await app.cdp.dispatchWheel(box.x, box.y, -160);
        await sleep(16);
      }
    }
    await sleep(120);
    const scrollSnap = await app.cdp.evaluate<{
      droppedFrames: number;
      longestFrameMs: number;
      longTasksOver50Ms: number;
      longTaskMaxMs: number;
    }>('window.__guiBench.stop()');
    const after = sampleProcessTree(app.pid);

    await openSession(app, GUI_BENCH_SESSION_IDS.chat10k);
    await sleep(300);
    const typingOn10k = await app.cdp.evaluate<TypingMetrics>(
      'window.__guiBench.measureTyping(24, 0)',
    );

    const echoOnHeavyMs = await measureEcho(app, `echo-marker-${String(run)}-${String(Date.now())}`);
    const echo100kbMs = await measureEcho(app, `SENDRENDER100KB-${'x'.repeat(100_000)}`);

    const screenshotPath = join(ARTIFACTS, `gui_bench_heavy_run${String(run)}.png`);
    writeFileSync(screenshotPath, await app.cdp.capturePng());

    return {
      run,
      loadavg,
      typingOn10k,
      echoOnHeavyMs,
      echo100kbMs,
      heavyOpenMs: heavyOpen.elapsedMs,
      heavyScroll: {
        ...scrollSnap,
        cpuPercent: cpuPercent(before, after),
      },
      mermaidSvgMs: mermaid.elapsedMs,
      mermaidFound: mermaid.found,
      blockCounts,
    };
  } finally {
    await stopApp(app);
    await sleep(800);
  }
}

async function waitForId(app: LaunchedApp, sessionId: string, timeoutMs = 40_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    await installProbe(app);
    const ids = await app.cdp.evaluate<string[]>('window.__guiBench.sessionIds()');
    if (ids.includes(sessionId)) return;
    await sleep(400);
  }
  throw new Error(`Session ${sessionId} never appeared.`);
}

async function measureEcho(app: LaunchedApp, text: string): Promise<EchoMetrics> {
  await installProbe(app);
  await app.cdp.evaluate('window.__guiBench.waitForSendReady(15000)');
  const previous = await app.cdp.evaluate<number>(
    'document.querySelectorAll(\'[data-testid="chat-view"] [data-feed-row-id]\').length',
  );
  await app.cdp.evaluate(`window.__guiBench.fillPrompt(${JSON.stringify(text)})`);
  const started = Date.now();
  await app.cdp.evaluate('window.__guiBench.clickSend()');
  const wait = await app.cdp.evaluate<{ elapsedMs: number; found: boolean; rows: number }>(
    `window.__guiBench.waitForUserEcho(${JSON.stringify(text.slice(0, 48))}, ${String(previous)}, 4000)`,
  );
  const composer = await app.cdp.evaluate<string | null>('window.__guiBench.composerValue()');
  return {
    elapsedMs: Math.max(Date.now() - started, wait.elapsedMs),
    found: wait.found,
    composerCleared: composer === '',
    rows: wait.rows,
  };
}
