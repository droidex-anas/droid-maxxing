import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const READY_TIMEOUT_MS = 20_000;
const SESSIONS_LIST_TIMEOUT_MS = 30_000;
const READY_PATTERN = /SIDECAR_READY (\d+)/;

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
  // Build outside the timed runs so the source protocol and launched artifact agree.
  await promisify(execFile)(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], {
    cwd: resolve(treeRoot, 'sidecar'),
    timeout: 120_000,
  });
  const requireFromTree = createRequire(entry);
  const wsPath = resolve(treeRoot, 'sidecar/node_modules/ws');
  const { WebSocket: WebSocketClass } = requireFromTree(wsPath) as {
    WebSocket: WebSocketConstructor;
  };
  const bridgeProtocol = await bridgeProtocolForTree(treeRoot);
  const runs = startupRuns();
  const readySamples: number[] = [];
  const listSamples: number[] = [];

  for (let run = 0; run < runs; run += 1) {
    const home = join('/tmp', `droidex-perf-sidecar-${String(process.pid)}-${String(run)}`);
    await rm(home, { recursive: true, force: true });
    await mkdir(home, { recursive: true });
    try {
      const sample = await measureOnce(entry, home, WebSocketClass, bridgeProtocol);
      readySamples.push(sample.readyMs);
      listSamples.push(sample.firstSessionsListMs);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }

  const wire = bridgeProtocol === undefined ? 'direct server events' : 'ordered bridge batches';
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
  webSocketCtor: WebSocketConstructor,
  bridgeProtocol: number | undefined,
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
      const match = READY_PATTERN.exec(stdout);
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

  await waitForSessionsList(webSocketCtor, port, token, bridgeProtocol);
  const firstSessionsListMs = performance.now() - spawnAt;
  child.kill();

  return { readyMs, firstSessionsListMs };
}

async function waitForSessionsList(
  webSocketCtor: WebSocketConstructor,
  port: number,
  token: string,
  bridgeProtocol: number | undefined,
): Promise<SessionsListEvent> {
  const socket = new webSocketCtor(bridgeUrl(port, token, bridgeProtocol));
  await new Promise<void>((resolveOpen, reject) => {
    socket.once('open', () => {
      resolveOpen();
    });
    socket.once('error', (error: unknown) => {
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });

  const listPromise = new Promise<SessionsListEvent>((resolveList, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('sessions.list timeout'));
    }, SESSIONS_LIST_TIMEOUT_MS);
    socket.on('message', (raw: Buffer | ArrayBuffer | Buffer[]) => {
      try {
        const message = JSON.parse(messageText(raw)) as WireMessage;
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

async function bridgeProtocolForTree(treeRoot: string): Promise<number | undefined> {
  if (!existsSync(join(treeRoot, 'sidecar/src/bridgeServer.ts'))) return undefined;
  const protocol: unknown = Reflect.get(
    await import(pathToFileURL(join(treeRoot, 'sidecar/src/protocol.ts')).href),
    'BRIDGE_PROTOCOL_VERSION',
  );
  if (typeof protocol !== 'number') throw new Error('Tree does not export its bridge protocol.');
  return protocol;
}

function bridgeUrl(port: number, token: string, bridgeProtocol: number | undefined): string {
  const params = new URLSearchParams({ token });
  if (bridgeProtocol !== undefined) params.set('bridgeProtocol', String(bridgeProtocol));
  return `ws://127.0.0.1:${String(port)}/?${params.toString()}`;
}

function parseSessionsList(message: WireMessage): SessionsListEvent | null {
  if (message.type === 'sessions.list' && Array.isArray(message.sessions)) {
    return { type: 'sessions.list', sessions: message.sessions };
  }
  if (message.type !== 'events.batch' || !Array.isArray(message.events)) return null;
  for (const entry of message.events) {
    if (entry.event?.type === 'sessions.list') return entry.event;
  }
  return null;
}

function metric(id: string, value: number, unit: string, method: string): AbProbeMetric {
  return { id, value, unit, method };
}

function messageText(raw: Buffer | ArrayBuffer | Buffer[]): string {
  if (Buffer.isBuffer(raw)) return raw.toString('utf8');
  if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8');
  return Buffer.from(new Uint8Array(raw)).toString('utf8');
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

type WebSocketConstructor = new (url: string) => WebSocketLike;

interface WebSocketLike {
  once(event: 'open' | 'error', listener: (...args: unknown[]) => void): void;
  on(event: 'message', listener: (raw: Buffer | ArrayBuffer | Buffer[]) => void): void;
  send(data: string): void;
  close(): void;
}
