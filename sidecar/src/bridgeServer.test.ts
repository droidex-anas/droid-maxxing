import assert from 'node:assert/strict';
import test from 'node:test';

import { startBridgeServer } from './bridgeServer.js';
import type { ServerEvent } from './protocol.js';
import WebSocket from 'ws';

interface Harness {
  port: number;
  token: string;
  assetToken: string;
  broadcast(event: ServerEvent): void;
  close(): Promise<void>;
}

async function withServer(
  handler: (harness: Harness) => Promise<void>,
  onCommand: () => Promise<void> = async () => undefined,
): Promise<void> {
  const token = 'test-token';
  const assetToken = 'test-asset-token';
  const server = startBridgeServer({ requestedPort: 0, token, assetToken, onCommand });
  await server.ready;
  try {
    await handler({
      port: server.port,
      token,
      assetToken,
      broadcast: server.broadcast,
      close: () => server.close(),
    });
  } finally {
    await server.close();
  }
}

test('broadcast reaches a connected authenticated client', async () => {
  await withServer(async (harness) => {
    const received: string[] = [];
    const socket = new WebSocket(`ws://127.0.0.1:${String(harness.port)}?token=${harness.token}`);
    const opened = new Promise<void>((resolve) => socket.once('open', resolve));
    socket.on('message', (raw) => received.push(String(raw)));
    await opened;

    harness.broadcast({ type: 'connection', status: 'connected' });
    await waitFor(() => received.length === 1);
    assert.match(received[0] ?? '', /"connection"/);
    socket.close();
  });
});

test('wrong token is rejected at the socket layer', async () => {
  await withServer(async (harness) => {
    const socket = new WebSocket(`ws://127.0.0.1:${String(harness.port)}?token=wrong`);
    const closed = new Promise<number>((resolve) => socket.once('close', (code) => resolve(code)));
    assert.equal(await closed, 1008);
  });
});

test('perf metrics endpoint requires the bridge token', async () => {
  await withServer(async (harness) => {
    const denied = await fetch(`http://127.0.0.1:${String(harness.port)}/perf/metrics`);
    assert.equal(denied.status, 401);

    const allowed = await fetch(
      `http://127.0.0.1:${String(harness.port)}/perf/metrics?token=${harness.token}`,
    );
    assert.equal(allowed.status, 200);
    const body = (await allowed.json()) as { pid: number; counters: Record<string, number> };
    assert.equal(typeof body.pid, 'number');
    assert.ok(body.counters);
  });
});

function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
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
