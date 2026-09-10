import { WebSocket, type RawData } from 'ws';

import { startBridgeServer } from '../bridgeServer.js';
import {
  BRIDGE_PROTOCOL_VERSION,
  type BridgeRuntimeSnapshot,
  type ClientCommand,
  type ServerEvent,
} from '../protocol.js';

export interface BridgeHarness {
  port: number;
  token: string;
  assetToken: string;
  broadcast(event: ServerEvent): void;
  close(): Promise<void>;
}

export async function withServer(
  handler: (harness: BridgeHarness) => Promise<void>,
  onCommand: (command: ClientCommand) => Promise<void> = () => Promise.resolve(),
  getSnapshot?: () => Promise<BridgeRuntimeSnapshot> | BridgeRuntimeSnapshot,
): Promise<void> {
  const token = 'test-token';
  const assetToken = 'test-asset-token';
  const server = startBridgeServer({
    requestedPort: 0,
    token,
    assetToken,
    onCommand,
    ...(getSnapshot ? { getSnapshot } : {}),
  });
  await server.ready;
  try {
    await handler({
      port: server.port,
      token,
      assetToken,
      broadcast: (event) => {
        server.broadcast(event);
      },
      close: () => server.close(),
    });
  } finally {
    await server.close();
  }
}

export function bridgeHttpUrl(harness: BridgeHarness, path: string): string {
  return `http://127.0.0.1:${String(harness.port)}${path}`;
}

export interface BridgeSocket {
  socket: WebSocket;
  received: string[];
  opened: Promise<void>;
}

/** Opens a protocol-current client, already recording messages and its open event. */
export function openBridgeSocket(
  harness: BridgeHarness,
  resume?: { generation?: string; seq?: number },
): BridgeSocket {
  const query = [
    `token=${harness.token}`,
    `bridgeProtocol=${String(BRIDGE_PROTOCOL_VERSION)}`,
    ...(resume?.generation === undefined
      ? []
      : [`resumeGeneration=${encodeURIComponent(resume.generation)}`]),
    ...(resume?.seq === undefined ? [] : [`resumeSeq=${String(resume.seq)}`]),
  ].join('&');
  const socket = new WebSocket(`ws://127.0.0.1:${String(harness.port)}?${query}`);
  const received: string[] = [];
  const opened = new Promise<void>((resolve) => socket.once('open', resolve));
  socket.on('message', (raw) => {
    received.push(messageText(raw));
  });
  return { socket, received, opened };
}

function messageText(raw: RawData): string {
  if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8');
  if (Buffer.isBuffer(raw)) return raw.toString('utf8');
  return Buffer.from(raw).toString('utf8');
}

export function closeSocket(socket: WebSocket, timeoutMs = 2_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('socket close timed out'));
    }, timeoutMs);
    socket.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.close();
  });
}

export function socketCloseCode(socket: WebSocket, timeoutMs = 2_000): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('socket close timed out'));
    }, timeoutMs);
    socket.once('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

export function socketRoundTrip(socket: WebSocket, timeoutMs = 2_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('socket round trip timed out'));
    }, timeoutMs);
    socket.once('pong', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.ping();
  });
}

export function runtimeSnapshot(): BridgeRuntimeSnapshot {
  return {
    runtime: { mode: 'cli_auth', droidPath: '/bin/droid', apiKeyConfigured: false },
    sessions: [],
    children: [],
    persistence: { durable: true, hadUnflushedWork: false },
    interrupted: [],
  };
}

export interface SnapshotGate {
  /** Resolves once the bridge asks for the snapshot. */
  started: Promise<void>;
  release(snapshot?: BridgeRuntimeSnapshot): void;
  getSnapshot: () => Promise<BridgeRuntimeSnapshot>;
}

/** Holds admission open until the test releases the runtime snapshot. */
export function deferredSnapshot(): SnapshotGate {
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let resolveSnapshot: ((snapshot: BridgeRuntimeSnapshot) => void) | undefined;
  return {
    started,
    release: (snapshot = runtimeSnapshot()) => {
      resolveSnapshot?.(snapshot);
    },
    getSnapshot: () => {
      markStarted?.();
      return new Promise<BridgeRuntimeSnapshot>((resolve) => {
        resolveSnapshot = resolve;
      });
    },
  };
}

export function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = () => {
      clearTimeout(timer);
      clearInterval(interval);
    };
    const timer = setTimeout(() => {
      finish();
      reject(new Error('waitFor timed out'));
    }, timeoutMs);
    const interval = setInterval(() => {
      if (predicate()) {
        finish();
        resolve();
      }
    }, 10);
  });
}
