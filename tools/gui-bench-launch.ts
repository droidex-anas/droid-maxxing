import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CdpClient, sleep, waitForCdpTarget } from './gui-bench-cdp.ts';
import { seedGuiBenchHistory } from './gui-bench-seed.ts';

export interface BenchTree {
  name: 'baseline' | 'candidate';
  root: string;
  sha: string;
}

export interface LaunchedApp {
  tree: BenchTree;
  pid: number;
  cdpPort: number;
  userDataDir: string;
  home: string;
  child: ChildProcess;
  cdp: CdpClient;
}

export interface ProcSample {
  atMs: number;
  pid: number;
  rssBytes: number;
  cpuUserTicks: number;
  cpuSystemTicks: number;
}

const CLK_TCK = 100;

export function prepareBenchHome(templateHome: string, destHome: string): void {
  rmSync(destHome, { recursive: true, force: true });
  mkdirSync(join(destHome, '.factory', 'sessions'), { recursive: true });
  seedInto(templateHome, destHome);
}

export function seedTemplate(templateHome: string): ReturnType<typeof seedGuiBenchHistory> {
  rmSync(templateHome, { recursive: true, force: true });
  mkdirSync(templateHome, { recursive: true });
  return seedGuiBenchHistory(templateHome);
}

function seedInto(templateHome: string, destHome: string): void {
  const from = join(templateHome, '.factory');
  const to = join(destHome, '.factory');
  cpRecursive(from, to);
}

function cpRecursive(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = join(from, entry.name);
    const dest = join(to, entry.name);
    if (entry.isDirectory()) cpRecursive(source, dest);
    else writeFileSync(dest, readFileSync(source));
  }
}

export function writeCompletedOnboarding(userDataDir: string): void {
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(
    join(userDataDir, 'onboarding.json'),
    `${JSON.stringify({ completed: true, version: 1, cliAutoUpdate: false, appAutoUpdate: false }, null, 2)}\n`,
  );
}

export async function launchApp(options: {
  tree: BenchTree;
  runId: string;
  cdpPort: number;
  home: string;
  userDataDir: string;
  sidecarEntry?: string;
  extraEnv?: NodeJS.ProcessEnv;
}): Promise<LaunchedApp> {
  writeCompletedOnboarding(options.userDataDir);
  const electronBin = join(options.tree.root, 'node_modules/.bin/electron');
  const main = join(options.tree.root, 'electron/main.cjs');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DISPLAY: process.env.DISPLAY || ':1',
    XAUTHORITY: process.env.XAUTHORITY || '/home/ubuntu/.Xauthority',
    HOME: options.home,
    USERPROFILE: options.home,
    DROIDEX_USER_DATA_DIR: options.userDataDir,
    ELECTRON_ENABLE_LOGGING: '1',
  };
  delete env.ELECTRON_START_URL;
  delete env.FACTORY_API_KEY;
  delete env.DROID_PATH;
  if (options.sidecarEntry) env.SIDECAR_ENTRY = options.sidecarEntry;
  if (options.extraEnv) Object.assign(env, options.extraEnv);

  const child = spawn(
    electronBin,
    [main, '--no-sandbox', `--remote-debugging-port=${String(options.cdpPort)}`, '--remote-allow-origins=*'],
    {
      cwd: options.tree.root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const pid = child.pid;
  if (!pid) {
    child.kill();
    throw new Error(`Failed to spawn Electron for ${options.tree.name}.`);
  }
  const logChunks: string[] = [];
  const onLog = (chunk: Buffer) => {
    const text = String(chunk);
    logChunks.push(text);
    if (logChunks.length > 80) logChunks.splice(0, logChunks.length - 80);
  };
  child.stdout?.on('data', onLog);
  child.stderr?.on('data', onLog);

  try {
    const target = await waitForCdpTarget(options.cdpPort);
    const cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
    return {
      tree: options.tree,
      pid,
      cdpPort: options.cdpPort,
      userDataDir: options.userDataDir,
      home: options.home,
      child,
      cdp,
    };
  } catch (error) {
    await stopProcessTree(pid);
    throw new Error(
      `Launch failed for ${options.tree.name}: ${error instanceof Error ? error.message : String(error)}\n${logChunks.join('')}`,
    );
  }
}

export async function stopApp(app: LaunchedApp): Promise<void> {
  try {
    app.cdp.close();
  } catch {
    // The page may already be gone.
  }
  await stopProcessTree(app.pid);
}

export async function stopProcessTree(rootPid: number): Promise<void> {
  const pids = collectDescendants(rootPid);
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Already gone.
    }
  }
  await sleep(400);
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
  await sleep(150);
}

function collectDescendants(rootPid: number): number[] {
  const childrenByParent = new Map<number, number[]>();
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    try {
      const stat = readFileSync(join('/proc', entry, 'stat'), 'utf8');
      const close = stat.indexOf(')');
      const parts = stat.slice(close + 2).split(' ');
      const ppid = Number(parts[1]);
      const list = childrenByParent.get(ppid) ?? [];
      list.push(pid);
      childrenByParent.set(ppid, list);
    } catch {
      continue;
    }
  }
  const out: number[] = [];
  const stack = [rootPid];
  while (stack.length > 0) {
    const pid = stack.pop();
    if (pid === undefined) break;
    out.push(pid);
    for (const child of childrenByParent.get(pid) ?? []) stack.push(child);
  }
  return out;
}

export function sampleProcessTree(rootPid: number): ProcSample[] {
  const atMs = Date.now();
  return collectDescendants(rootPid).flatMap((pid) => {
    const sample = readProc(pid, atMs);
    return sample ? [sample] : [];
  });
}

function readProc(pid: number, atMs: number): ProcSample | null {
  try {
    const stat = readFileSync(join('/proc', String(pid), 'stat'), 'utf8');
    const close = stat.indexOf(')');
    const parts = stat.slice(close + 2).split(' ');
    const status = readFileSync(join('/proc', String(pid), 'status'), 'utf8');
    const rssMatch = status.match(/^VmRSS:\s+(\d+)\s+kB$/m);
    return {
      atMs,
      pid,
      rssBytes: rssMatch ? Number(rssMatch[1]) * 1024 : 0,
      cpuUserTicks: Number(parts[11]),
      cpuSystemTicks: Number(parts[12]),
    };
  } catch {
    return null;
  }
}

export function cpuPercent(before: ProcSample[], after: ProcSample[]): number {
  const elapsedMs = medianTime(after) - medianTime(before);
  if (elapsedMs <= 0) return 0;
  const beforeByPid = new Map(before.map((sample) => [sample.pid, sample]));
  let deltaTicks = 0;
  for (const sample of after) {
    const previous = beforeByPid.get(sample.pid);
    if (!previous) continue;
    deltaTicks += sample.cpuUserTicks + sample.cpuSystemTicks - previous.cpuUserTicks - previous.cpuSystemTicks;
  }
  return (deltaTicks / CLK_TCK / (elapsedMs / 1000)) * 100;
}

export function totalRssBytes(samples: ProcSample[]): number {
  return samples.reduce((sum, sample) => sum + sample.rssBytes, 0);
}

function medianTime(samples: ProcSample[]): number {
  if (samples.length === 0) return Date.now();
  return samples[0]?.atMs ?? Date.now();
}
