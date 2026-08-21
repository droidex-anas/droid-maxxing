// The sidecar's single outbound surface: authenticated WebSocket fan-out,
// ordered event batching/replay, and token-gated HTTP routes. The packaged
// entry and perf harness both use this exact transport path.

import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { assertValidResponseFormat } from './appPrompt.js';
import { BridgeEventBatcher, type BridgeEventBatchMetadata } from './bridgeEventBatcher.js';
import { BridgeReplayBuffer, type SerializedEventBatch } from './bridgeReplayBuffer.js';
import { resolveBrowserAssetPath } from './browser/browserPaths.js';
import {
  BRIDGE_PROTOCOL_VERSION,
  type BridgeResetMessage,
  type ClientCommand,
  type ServerEvent,
  type ServerEventBatch,
  type ServerWireMessage,
} from './protocol.js';
import { hotPathMetrics } from './telemetry/hotPathMetrics.js';

const HOST = '127.0.0.1';
const SOFT_CLIENT_BUFFER_BYTES = 512 * 1024;
const HARD_CLIENT_BUFFER_BYTES = 8 * 1024 * 1024;
const CLIENT_CLOSE_DRAIN_MS = 250;

interface BridgeClient {
  supportsEventBatches: boolean;
}

export interface BridgeServer {
  readonly port: number;
  readonly ready: Promise<void>;
  broadcast(event: ServerEvent): void;
  browserAssetUrl(filePath: string): string;
  close(): Promise<void>;
}

export function startBridgeServer(options: {
  requestedPort: number;
  token: string;
  assetToken: string;
  onCommand: (command: ClientCommand) => Promise<void>;
}): BridgeServer {
  const clients = new Map<WebSocket, BridgeClient>();
  const replay = new BridgeReplayBuffer();
  let boundPort = options.requestedPort;
  let closePromise: Promise<void> | null = null;

  const server = createServer((req, res) => {
    if (serveBrowserAsset(req, res, options.assetToken)) return;
    if (serveHotPathMetrics(req, res, options.token)) return;
    res.writeHead(404).end('not found');
  });

  const wss = new WebSocketServer({ server });
  const batcher = new BridgeEventBatcher({
    isUnderPressure: () => maxBufferedAmount(clients.keys()) >= SOFT_CLIENT_BUFFER_BYTES,
    sendBatch,
    onQueueChanged: (snapshot) => {
      hotPathMetrics.recordTransportQueue({
        pendingEvents: snapshot.pendingLogicalEvents,
        pendingEstimatedBytes: snapshot.pendingEstimatedBytes,
        oldestPendingAgeMs: snapshot.oldestPendingAgeMs,
      });
    },
  });

  function broadcast(event: ServerEvent): void {
    batcher.enqueue(event);
  }

  function sendBatch(batch: ServerEventBatch, metadata: BridgeEventBatchMetadata): void {
    const startedAt = performance.now();
    const batchData = JSON.stringify(batch);
    const replayEntry = replay.push(batch, batchData);
    let legacyPayloads: readonly string[] | null = null;
    let bytesSent = 0;
    let sendOperations = 0;
    let maxBufferedBytes = 0;

    for (const [ws, client] of clients) {
      if (ws.readyState !== ws.OPEN) continue;
      maxBufferedBytes = Math.max(maxBufferedBytes, ws.bufferedAmount);

      if (client.supportsEventBatches) {
        if (disconnectIfBackpressured(ws, replayEntry.bytes)) continue;
        ws.send(batchData);
        bytesSent += replayEntry.bytes;
        sendOperations += 1;
        continue;
      }

      // Update safety: an older renderer has no `events.batch` contract. Keep
      // it functional by unpacking the already-ordered batch into the legacy
      // one-event wire format until the whole installed app has relaunched.
      legacyPayloads ??= batch.events.map((entry) => JSON.stringify(entry.event));
      for (const data of legacyPayloads) {
        const payloadBytes = Buffer.byteLength(data);
        if (disconnectIfBackpressured(ws, payloadBytes)) break;
        ws.send(data);
        bytesSent += payloadBytes;
        sendOperations += 1;
      }
    }

    hotPathMetrics.recordTransport(performance.now() - startedAt, bytesSent, sendOperations);
    hotPathMetrics.recordTransportBatch({
      logicalEvents: metadata.logicalEvents,
      deliveredEvents: metadata.deliveredEvents,
      bytes: replayEntry.bytes,
      queueDelayMs: metadata.queueDelayMs,
      immediate: metadata.immediate,
    });
    hotPathMetrics.recordClientBufferedAmount(maxBufferedBytes);
    const replayState = replay.snapshot();
    hotPathMetrics.recordReplayBuffer(replayState.batches, replayState.bytes);
  }

  const ready = new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.requestedPort, HOST, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Sidecar bridge did not expose a TCP address.'));
        return;
      }
      boundPort = address.port;
      resolve();
    });
  });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url ?? '', `http://${HOST}`);
    if (url.searchParams.get('token') !== options.token) {
      ws.close(1008, 'unauthorized');
      return;
    }

    const client: BridgeClient = {
      supportsEventBatches:
        url.searchParams.get('bridgeProtocol') === String(BRIDGE_PROTOCOL_VERSION),
    };
    if (client.supportsEventBatches && !resumeClient(ws, url)) return;
    clients.set(ws, client);

    ws.on('message', (raw) => void handleMessage(ws, raw));
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
  });

  function resumeClient(ws: WebSocket, url: URL): boolean {
    const resumeGeneration = url.searchParams.get('resumeGeneration');
    const resumeSeqValue = url.searchParams.get('resumeSeq');
    if (resumeGeneration === null && resumeSeqValue === null) return true;

    // A reset/replay cursor must never acknowledge logical events that are
    // still sitting in the timer window. Flush before taking the cursor so
    // every acknowledged sequence is either replayable or explicitly outside
    // the retained window.
    batcher.flush();
    const current = batcher.snapshot();
    const resumeSeq = nonNegativeInteger(resumeSeqValue);
    if (resumeGeneration === null || resumeSeq === null) {
      sendReset(ws, current.lastSeq, 'invalid_resume');
      return true;
    }

    if (resumeGeneration !== batcher.generation) {
      sendReset(ws, current.lastSeq, 'generation_changed');
      return true;
    }
    if (resumeSeq > current.lastSeq) {
      sendReset(ws, current.lastSeq, 'invalid_resume');
      return true;
    }

    const missed = replay.replayAfter(resumeSeq);
    if (missed === null) {
      sendReset(ws, current.lastSeq, 'replay_unavailable');
      return true;
    }
    return replayBatches(ws, missed);
  }

  function replayBatches(ws: WebSocket, missed: readonly SerializedEventBatch[]): boolean {
    const startedAt = performance.now();
    let replayedBytes = 0;
    let replayedEvents = 0;
    let sendOperations = 0;
    for (const entry of missed) {
      if (disconnectIfBackpressured(ws, entry.bytes)) return false;
      ws.send(entry.data);
      replayedBytes += entry.bytes;
      replayedEvents += entry.eventCount;
      sendOperations += 1;
    }
    if (missed.length > 0) {
      hotPathMetrics.recordTransport(performance.now() - startedAt, replayedBytes, sendOperations);
      hotPathMetrics.recordReplay(missed.length, replayedEvents, replayedBytes);
    }
    return true;
  }

  function sendReset(ws: WebSocket, lastSeq: number, reason: BridgeResetMessage['reason']): void {
    sendDirectWire(ws, {
      type: 'bridge.reset',
      generation: batcher.generation,
      lastSeq,
      reason,
    });
  }

  async function handleMessage(ws: WebSocket, raw: RawData): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(messageText(raw));
    } catch {
      sendDirectWire(ws, { type: 'error', message: 'Invalid JSON command' });
      return;
    }
    try {
      if (typeof parsed === 'object' && parsed !== null && 'responseFormat' in parsed) {
        assertValidResponseFormat(parsed.responseFormat);
      }
      await options.onCommand(parsed as ClientCommand);
    } catch (err) {
      sendDirectWire(ws, {
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  function sendDirectWire(ws: WebSocket, message: ServerWireMessage): void {
    if (ws.readyState !== ws.OPEN) return;
    const startedAt = performance.now();
    const data = JSON.stringify(message);
    const payloadBytes = Buffer.byteLength(data);
    if (disconnectIfBackpressured(ws, payloadBytes)) return;
    ws.send(data);
    hotPathMetrics.recordTransport(performance.now() - startedAt, payloadBytes, 1);
  }

  function disconnectIfBackpressured(ws: WebSocket, payloadBytes: number): boolean {
    const projectedBufferedBytes = ws.bufferedAmount + payloadBytes;
    hotPathMetrics.recordClientBufferedAmount(projectedBufferedBytes);
    if (projectedBufferedBytes < HARD_CLIENT_BUFFER_BYTES) return false;
    clients.delete(ws);
    hotPathMetrics.recordBackpressureDisconnect(projectedBufferedBytes);
    ws.terminate();
    return true;
  }

  function messageText(raw: RawData): string {
    if (Buffer.isBuffer(raw)) return raw.toString('utf8');
    if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8');
    return Buffer.concat(raw).toString('utf8');
  }

  function browserAssetUrl(filePath: string): string {
    const url = new URL(`http://${HOST}:${String(boundPort)}/browser-assets`);
    url.searchParams.set('path', filePath);
    url.searchParams.set('token', options.assetToken);
    return url.toString();
  }

  function serveHotPathMetrics(req: IncomingMessage, res: ServerResponse, token: string): boolean {
    const url = new URL(req.url ?? '/', `http://${HOST}:${String(boundPort)}`);
    if (url.pathname !== '/perf/metrics') return false;
    if (req.method !== 'GET') {
      res.writeHead(405).end('method not allowed');
      return true;
    }
    if (url.searchParams.get('token') !== token) {
      res.writeHead(401).end('unauthorized');
      return true;
    }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(hotPathMetrics.snapshot()));
    return true;
  }

  function serveBrowserAsset(
    req: IncomingMessage,
    res: ServerResponse,
    assetToken: string,
  ): boolean {
    const url = new URL(req.url ?? '/', `http://${HOST}:${String(boundPort)}`);
    if (url.pathname !== '/browser-assets') return false;
    if (url.searchParams.get('token') !== assetToken) {
      res.writeHead(401).end('unauthorized');
      return true;
    }
    const filePath = url.searchParams.get('path');
    if (!filePath) {
      res.writeHead(403).end('forbidden');
      return true;
    }
    void resolveBrowserAssetPath(filePath)
      .then(async (resolvedPath) => {
        if (!resolvedPath) {
          res.writeHead(403).end('forbidden');
          return;
        }
        const info = await stat(resolvedPath);
        if (!info.isFile()) {
          res.writeHead(404).end('not found');
          return;
        }
        res.writeHead(200, {
          'content-type': contentType(resolvedPath),
          'cache-control': 'no-store',
        });
        createReadStream(resolvedPath).pipe(res);
      })
      .catch(() => res.writeHead(404).end('not found'));
    return true;
  }

  function contentType(filePath: string): string {
    if (filePath.endsWith('.png')) return 'image/png';
    if (filePath.endsWith('.jpg') || filePath.endsWith('.jpeg')) return 'image/jpeg';
    if (filePath.endsWith('.json')) return 'application/json';
    return 'application/octet-stream';
  }

  function close(): Promise<void> {
    if (closePromise) return closePromise;
    batcher.close();
    closePromise = new Promise<void>((resolve) => {
      let pendingServers = 2;
      const settled = () => {
        pendingServers -= 1;
        if (pendingServers === 0) resolve();
      };
      const forceClose = setTimeout(() => {
        for (const ws of clients.keys()) ws.terminate();
        clients.clear();
      }, CLIENT_CLOSE_DRAIN_MS);
      forceClose.unref();

      for (const ws of clients.keys()) {
        if (ws.readyState === ws.OPEN) ws.close(1001, 'sidecar shutting down');
        else ws.terminate();
      }
      wss.close(() => {
        clearTimeout(forceClose);
        settled();
      });
      server.close(settled);
    });
    return closePromise;
  }

  return {
    get port() {
      return boundPort;
    },
    ready,
    broadcast,
    browserAssetUrl,
    close,
  };
}

function maxBufferedAmount(clients: Iterable<WebSocket>): number {
  let max = 0;
  for (const ws of clients) max = Math.max(max, ws.bufferedAmount);
  return max;
}

function nonNegativeInteger(value: string | null): number | null {
  if (value === null || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}
