import assert from 'node:assert/strict';
import test from 'node:test';

import { WebSocket } from 'ws';

import { startBridgeServer } from './bridgeServer.js';
import { BRIDGE_PROTOCOL_VERSION, type ServerEvent, type ServerEventBatch } from './protocol.js';

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

test('legacy authenticated client receives the one-event update-safe wire format', async () => {
  await withServer(async (harness) => {
    const received: string[] = [];
    const socket = new WebSocket(`ws://127.0.0.1:${String(harness.port)}?token=${harness.token}`);
    const opened = new Promise<void>((resolve) => socket.once('open', resolve));
    socket.on('message', (raw) => received.push(String(raw)));
    await opened;

    harness.broadcast({ type: 'connection', status: 'connected' });
    await waitFor(() => received.length === 1);
    assert.deepEqual(JSON.parse(received[0] ?? ''), {
      type: 'connection',
      status: 'connected',
    });
    await closeSocket(socket);
  });
});

test('batch-capable client receives one ordered event envelope', async () => {
  await withServer(async (harness) => {
    const received: string[] = [];
    const socket = new WebSocket(
      `ws://127.0.0.1:${String(harness.port)}?token=${harness.token}&bridgeProtocol=${String(BRIDGE_PROTOCOL_VERSION)}`,
    );
    const opened = new Promise<void>((resolve) => socket.once('open', resolve));
    socket.on('message', (raw) => received.push(String(raw)));
    await opened;

    harness.broadcast({ type: 'mission.progress', appSessionId: 'app', entries: [] });
    harness.broadcast({ type: 'mission.progress', appSessionId: 'app', entries: [] });
    await waitFor(() => received.length === 1);

    const batch = JSON.parse(received[0] ?? '') as ServerEventBatch;
    assert.equal(batch.type, 'events.batch');
    assert.equal(batch.firstSeq, 1);
    assert.equal(batch.lastSeq, 2);
    assert.deepEqual(
      batch.events.map((entry) => entry.event.type),
      ['mission.progress', 'mission.progress'],
    );
    await closeSocket(socket);
  });
});

test('same-process reconnect replays batches after the acknowledged sequence', async () => {
  await withServer(async (harness) => {
    const firstReceived: string[] = [];
    const first = new WebSocket(
      `ws://127.0.0.1:${String(harness.port)}?token=${harness.token}&bridgeProtocol=${String(BRIDGE_PROTOCOL_VERSION)}`,
    );
    const firstOpened = new Promise<void>((resolve) => first.once('open', resolve));
    first.on('message', (raw) => firstReceived.push(String(raw)));
    await firstOpened;

    harness.broadcast({ type: 'connection', status: 'connected' });
    await waitFor(() => firstReceived.length === 1);
    const acknowledged = JSON.parse(firstReceived[0] ?? '') as ServerEventBatch;
    await closeSocket(first);

    harness.broadcast({
      type: 'runtime.updated',
      status: { mode: 'cli_auth', droidPath: '/bin/droid', apiKeyConfigured: false },
    });

    const replayed: string[] = [];
    const second = new WebSocket(
      `ws://127.0.0.1:${String(harness.port)}?token=${harness.token}&bridgeProtocol=${String(BRIDGE_PROTOCOL_VERSION)}&resumeGeneration=${encodeURIComponent(acknowledged.generation)}&resumeSeq=${String(acknowledged.lastSeq)}`,
    );
    const secondOpened = new Promise<void>((resolve) => second.once('open', resolve));
    second.on('message', (raw) => replayed.push(String(raw)));
    await secondOpened;
    await waitFor(() => replayed.length === 1);

    const batch = JSON.parse(replayed[0] ?? '') as ServerEventBatch;
    assert.equal(batch.firstSeq, acknowledged.lastSeq + 1);
    assert.equal(batch.events[0]?.event.type, 'runtime.updated');
    await closeSocket(second);
  });
});

test('resume reset flushes pending sequences before admitting the client', async () => {
  await withServer(async (harness) => {
    harness.broadcast({ type: 'mission.progress', appSessionId: 'app', entries: [] });

    const received: string[] = [];
    const socket = new WebSocket(
      `ws://127.0.0.1:${String(harness.port)}?token=${harness.token}&bridgeProtocol=${String(BRIDGE_PROTOCOL_VERSION)}&resumeSeq=999`,
    );
    const opened = new Promise<void>((resolve) => socket.once('open', resolve));
    socket.on('message', (raw) => received.push(String(raw)));
    await opened;
    await waitFor(() => received.length === 1);
    const reset = JSON.parse(received[0] ?? '') as {
      type: string;
      generation: string;
      lastSeq: number;
      reason: string;
    };
    assert.equal(reset.type, 'bridge.reset');
    assert.equal(typeof reset.generation, 'string');
    assert.equal(reset.lastSeq, 1);
    assert.equal(reset.reason, 'invalid_resume');

    harness.broadcast({ type: 'connection', status: 'connected' });
    await waitFor(() => received.length === 2);
    const boundary = JSON.parse(received[1] ?? '') as ServerEventBatch;
    assert.equal(boundary.firstSeq, 2);
    assert.equal(boundary.lastSeq, 2);
    assert.deepEqual(
      received.map((message) => JSON.parse(message) as { type: string }).map(({ type }) => type),
      ['bridge.reset', 'events.batch'],
    );
    await closeSocket(socket);
  });
});

for (const client of [
  { name: 'batch-capable', query: `&bridgeProtocol=${String(BRIDGE_PROTOCOL_VERSION)}` },
  { name: 'legacy', query: '' },
]) {
  test(`${client.name} client is disconnected before an oversized payload is queued`, async () => {
    await withServer(async (harness) => {
      const received: string[] = [];
      const socket = new WebSocket(
        `ws://127.0.0.1:${String(harness.port)}?token=${harness.token}${client.query}`,
      );
      const opened = new Promise<void>((resolve) => socket.once('open', resolve));
      const closed = socketCloseCode(socket);
      socket.on('message', (raw) => received.push(String(raw)));
      await opened;

      harness.broadcast({ type: 'error', message: 'x'.repeat(8 * 1024 * 1024) });

      assert.equal(await closed, 1006);
      assert.deepEqual(received, []);
    });
  });
}

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

function closeSocket(socket: WebSocket, timeoutMs = 2_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('socket close timed out')), timeoutMs);
    socket.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.close();
  });
}

function socketCloseCode(socket: WebSocket, timeoutMs = 2_000): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('socket close timed out')), timeoutMs);
    socket.once('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

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
