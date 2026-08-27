import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

const BRIDGE_PROTOCOL = 3;
const READY_TIMEOUT_MS = 20_000;
const SESSIONS_LIST_TIMEOUT_MS = 30_000;

export interface AbProbeMetric {
  id: string;
  value: number;
  unit: string;
  method: string;
}

function startupRuns(): number {
  return Number(process.env.DROIDEX_PERF_SIDECAR_STARTUP_RUNS ?? 5);
}

export async function measureSidecarStartup(treeRoot: string): Promise<AbProbeMetric[]> {
  const entry = resolve(treeRoot, 'sidecar/dist/sidecar.mjs');
  if (!existsSync(entry)) {
    return [
      metric('sidecar.readyMs', NaN, 'ms', 'sidecar/dist/sidecar.mjs missing'),
      metric('sidecar.firstSessionsListMs', NaN, 'ms', 'sidecar/dist/sidecar.mjs missing'),
    ];
  }
  const requireFromTree = createRequire(entry);
  const wsPath = resolve(treeRoot, 'sidecar/node_modules/ws');
  const { WebSocket } = requireFromTree(wsPath) as { WebSocket: WebSocketConstructor };
  const orderedBridge = usesOrderedBridge(treeRoot);
  const runs = startupRuns();
  const readySamples: number[] = [];
  const listSamples: number[] = [];

  for (let run = 0; run < runs; run += 1) {
    const home = join('/tmp', `droidex-perf-sidecar-${String(process.pid)}-${String(run)}`);
    await rm(home, { recursive: true, force: true });
    await mkdir(home, { recursive: true });
    try {
      const sample = await measureOnce(entry, home, WebSocket, orderedBridge);
      readySamples.push(sample.readyMs);
      listSamples.push(sample.firstSessionsListMs);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }

  const wire = orderedBridge ? 'ordered bridge batches' : 'direct server events';
  return [
    metric(
      'sidecar.readyMs',
      median(readySamples),
      'ms',
      `median of ${String(runs)} spawn→SIDECAR_READY timings on sidecar/dist/sidecar.mjs`,
    ),
    metric(
      'sidecar.firstSessionsListMs',
      median(listSamples),
      'ms',
      `median of ${String(runs)} spawn→first sessions.list timings via ${wire}`,
    ),
  ];
}

async function measureOnce(
  entry: string,
  home: string,
  WebSocketCtor: WebSocketConstructor,
  orderedBridge: boolean,
): Promise<{ readyMs: number; firstSessionsListMs: number }> {
  const token = randomBytes(32).toString('hex');
  const assetToken = randomBytes(32).toString('hex');
  const spawnAt = performance.now();
  const child = spawn(process.execPath, [entry], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      BRIDGE_TOKEN: token,
      BROWSER_ASSET_TOKEN: assetToken,
      BRIDGE_PORT: '0',
      DROIDEX_USER_DATA_DIR: home,
      HOME: home,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdout = '';
  let settled = false;
  const port = await new Promise<number>((resolvePort, reject) => {
    const timeout = setTimeout(() => {
      if (!settled) reject(new Error('SIDECAR_READY timeout'));
    }, READY_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
      const match = stdout.match(/SIDECAR_READY (\d+)/);
      if (!match || settled) return;
      settled = true;
      clearTimeout(timeout);
      resolvePort(Number(match[1]));
    });
    child.once('error', (error) => {
      if (!settled) reject(error);
    });
    child.once('exit', (code) => {
      if (!settled) reject(new Error(`exited ${String(code)} before ready: ${stdout}`));
    });
  });
  const readyMs = performance.now() - spawnAt;

  const listEvent = await waitForSessionsList(WebSocketCtor, port, token, orderedBridge);
  const firstSessionsListMs = performance.now() - spawnAt;
  child.kill();

  if (listEvent.type !== 'sessions.list' || !Array.isArray(listEvent.sessions)) {
    throw new Error(`sessions.list missing or malformed: ${JSON.stringify(listEvent)}`);
  }

  return { readyMs, firstSessionsListMs };
}

async function waitForSessionsList(
  WebSocketCtor: WebSocketConstructor,
  port: number,
  token: string,
  orderedBridge: boolean,
): Promise<SessionsListEvent> {
  const socket = new WebSocketCtor(bridgeUrl(port, token, orderedBridge));
  await new Promise<void>((resolveOpen, reject) => {
    socket.once('open', () => resolveOpen());
    socket.once('error', (error: unknown) => {
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });

  const listPromise = new Promise<SessionsListEvent>((resolveList, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('sessions.list timeout')),
      SESSIONS_LIST_TIMEOUT_MS,
    );
    socket.on('message', (raw: Buffer | ArrayBuffer | Buffer[]) => {
      try {
        const message = JSON.parse(String(raw)) as WireMessage;
        const event = parseSessionsList(message);
        if (!event) return;
        clearTimeout(timeout);
        resolveList(event);
      } catch {
        // ignore malformed frames
      }
    });
  });

  socket.send(JSON.stringify({ type: 'sessions.list' }));
  const event = await listPromise;
  socket.close();
  return event;
}

function usesOrderedBridge(treeRoot: string): boolean {
  return existsSync(join(treeRoot, 'sidecar/src/bridgeServer.ts'));
}

function bridgeUrl(port: number, token: string, orderedBridge: boolean): string {
  const params = new URLSearchParams({ token });
  if (orderedBridge) params.set('bridgeProtocol', String(BRIDGE_PROTOCOL));
  return `ws://127.0.0.1:${String(port)}/?${params.toString()}`;
}

function parseSessionsList(message: WireMessage): SessionsListEvent | null {
  if (message.type === 'sessions.list' && Array.isArray(message.sessions)) {
    return message;
  }
  if (message.type !== 'events.batch' || !Array.isArray(message.events)) return null;
  for (const entry of message.events) {
    if (entry?.event?.type === 'sessions.list') return entry.event;
  }
  return null;
}

function metric(id: string, value: number, unit: string, method: string): AbProbeMetric {
  return { id, value, unit, method };
}

function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? NaN;
}

interface SessionsListEvent {
  type: 'sessions.list';
  sessions: unknown[];
}

interface WireMessage {
  type?: string;
  sessions?: unknown[];
  events?: { event?: SessionsListEvent }[];
}

interface WebSocketConstructor {
  new (url: string): WebSocketLike;
}

interface WebSocketLike {
  once(event: 'open' | 'error', listener: (...args: unknown[]) => void): void;
  on(event: 'message', listener: (raw: Buffer | ArrayBuffer | Buffer[]) => void): void;
  send(data: string): void;
  close(): void;
}
