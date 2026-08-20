// The sidecar's single outbound surface: the authenticated WebSocket fan-out
// plus the token-gated HTTP routes (browser assets, hot-path metrics). Owned
// here so the packaged entry (index.ts) and the perf replay harness run the
// exact same transport code the renderer talks to.

import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { ClientCommand, ServerEvent } from './protocol.js';
import { assertValidResponseFormat } from './appPrompt.js';
import { resolveBrowserAssetPath } from './browser/browserPaths.js';
import { hotPathMetrics } from './telemetry/hotPathMetrics.js';

const HOST = '127.0.0.1';

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
  const clients = new Set<WebSocket>();
  let boundPort = options.requestedPort;

  const server = createServer((req, res) => {
    if (serveBrowserAsset(req, res, options.assetToken)) return;
    if (serveHotPathMetrics(req, res, options.token)) return;
    res.writeHead(404).end('not found');
  });

  const wss = new WebSocketServer({ server });

  function broadcast(event: ServerEvent): void {
    const startedAt = performance.now();
    const data = JSON.stringify(event);
    let sentTo = 0;
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) {
        ws.send(data);
        sentTo += 1;
      }
    }
    hotPathMetrics.recordTransport(performance.now() - startedAt, Buffer.byteLength(data), sentTo);
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
    clients.add(ws);

    ws.on('message', (raw) => void handleMessage(ws, raw));

    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
  });

  async function handleMessage(ws: WebSocket, raw: RawData): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(messageText(raw));
    } catch {
      ws.send(
        JSON.stringify({
          type: 'error',
          message: 'Invalid JSON command',
        } satisfies ServerEvent),
      );
      return;
    }
    try {
      if (typeof parsed === 'object' && parsed !== null && 'responseFormat' in parsed) {
        assertValidResponseFormat(parsed.responseFormat);
      }
      await options.onCommand(parsed as ClientCommand);
    } catch (err) {
      ws.send(
        JSON.stringify({
          type: 'error',
          message: err instanceof Error ? err.message : String(err),
        } satisfies ServerEvent),
      );
    }
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

  return {
    get port() {
      return boundPort;
    },
    ready,
    broadcast,
    browserAssetUrl,
    close: () =>
      new Promise<void>((resolve) => {
        // A renderer that stalls on the close handshake must not hold
        // shutdown hostage: destroy live sockets, then close the servers.
        for (const ws of clients) ws.terminate();
        clients.clear();
        let pending = 2;
        const settled = () => {
          if (--pending === 0) resolve();
        };
        wss.close(settled);
        server.close(settled);
      }),
  };
}
