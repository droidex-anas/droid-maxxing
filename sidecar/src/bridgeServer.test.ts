import assert from 'node:assert/strict';
import test from 'node:test';

import { WebSocket } from 'ws';

import { startBridgeServer } from './bridgeServer.js';
import {
  BRIDGE_PROTOCOL_VERSION,
  type BridgeRuntimeSnapshot,
  type ServerEvent,
  type ServerEventBatch,
} from './protocol.js';
import { hotPathMetrics } from './telemetry/hotPathMetrics.js';

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
      broadcast: server.broadcast,
      close: () => server.close(),
    });
  } finally {
    await server.close();
  }
}

test('clients without the current bridge protocol are rejected', async () => {
  await withServer(async (harness) => {
    const socket = new WebSocket(`ws://127.0.0.1:${String(harness.port)}?token=${harness.token}`);
    assert.equal(await socketCloseCode(socket), 1002);
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

test('an oversized batch resets a reconnect cursor instead of replaying the payload', async () => {
  await withServer(async (harness) => {
    const firstReceived: string[] = [];
    const first = new WebSocket(
      `ws://127.0.0.1:${String(harness.port)}?token=${harness.token}&bridgeProtocol=${String(BRIDGE_PROTOCOL_VERSION)}`,
    );
    const firstOpened = new Promise<void>((resolve) => first.once('open', resolve));
    const firstClosed = socketCloseCode(first);
    first.on('message', (raw) => firstReceived.push(String(raw)));
    await firstOpened;

    harness.broadcast({ type: 'connection', status: 'connected' });
    await waitFor(() => firstReceived.length === 1);
    const acknowledged = JSON.parse(firstReceived[0] ?? '') as ServerEventBatch;
    harness.broadcast({ type: 'error', message: 'x'.repeat(8 * 1024 * 1024) });
    assert.equal(await firstClosed, 1006);

    const resumed: string[] = [];
    const second = new WebSocket(
      `ws://127.0.0.1:${String(harness.port)}?token=${harness.token}&bridgeProtocol=${String(BRIDGE_PROTOCOL_VERSION)}&resumeGeneration=${encodeURIComponent(acknowledged.generation)}&resumeSeq=${String(acknowledged.lastSeq)}`,
    );
    const secondOpened = new Promise<void>((resolve) => second.once('open', resolve));
    second.on('message', (raw) => resumed.push(String(raw)));
    await secondOpened;
    await waitFor(() => resumed.length === 1);

    const snapshot = JSON.parse(resumed[0] ?? '') as {
      type: string;
      lastSeq: number;
      reason: string;
    };
    assert.equal(snapshot.type, 'bridge.snapshot');
    assert.equal(snapshot.lastSeq, 2);
    assert.equal(snapshot.reason, 'replay_unavailable');

    harness.broadcast({ type: 'connection', status: 'connected' });
    await waitFor(() => resumed.length === 2);
    const next = JSON.parse(resumed[1] ?? '') as ServerEventBatch;
    assert.equal(next.firstSeq, 3);
    assert.equal(next.lastSeq, 3);
    await closeSocket(second);
  });
});

test('a generation change sends a compact snapshot instead of a hard reset', async () => {
  await withServer(async (harness) => {
    harness.broadcast({ type: 'connection', status: 'connected' });
    const received: string[] = [];
    const socket = new WebSocket(
      `ws://127.0.0.1:${String(harness.port)}?token=${harness.token}&bridgeProtocol=${String(BRIDGE_PROTOCOL_VERSION)}&resumeGeneration=old-generation&resumeSeq=1`,
    );
    const opened = new Promise<void>((resolve) => socket.once('open', resolve));
    socket.on('message', (raw) => received.push(String(raw)));
    await opened;
    await waitFor(() => received.length === 1);
    const snapshot = JSON.parse(received[0] ?? '') as {
      type: string;
      reason: string;
      snapshot: { sessions: unknown[]; persistence: { hadUnflushedWork: boolean } };
    };
    assert.equal(snapshot.type, 'bridge.snapshot');
    assert.equal(snapshot.reason, 'generation_changed');
    assert.deepEqual(snapshot.snapshot.sessions, []);
    assert.equal(snapshot.snapshot.persistence.hadUnflushedWork, false);
    await closeSocket(socket);
  });
});

test('a generation-changed snapshot is delivered before later broadcasts', async () => {
  let releaseSnapshot: ((snapshot: BridgeRuntimeSnapshot) => void) | undefined;
  const snapshot = {
    runtime: { mode: 'cli_auth' as const, droidPath: '/bin/droid', apiKeyConfigured: false },
    sessions: [],
    children: [],
    persistence: { durable: true, hadUnflushedWork: false },
    interrupted: [],
  };
  await withServer(
    async (harness) => {
      const received: string[] = [];
      const socket = new WebSocket(
        `ws://127.0.0.1:${String(harness.port)}?token=${harness.token}&bridgeProtocol=${String(BRIDGE_PROTOCOL_VERSION)}&resumeGeneration=old-generation&resumeSeq=1`,
      );
      socket.on('message', (raw) => received.push(String(raw)));
      await waitFor(() => releaseSnapshot !== undefined);
      harness.broadcast({ type: 'connection', status: 'connected' });
      releaseSnapshot?.(snapshot);
      await waitFor(() => received.length >= 2);
      assert.equal(JSON.parse(received[0] ?? '').type, 'bridge.snapshot');
      const batch = JSON.parse(received[1] ?? '') as ServerEventBatch;
      assert.equal(batch.type, 'events.batch');
      assert.equal(batch.firstSeq, 1);
      await closeSocket(socket);
    },
    async () => undefined,
    () =>
      new Promise<BridgeRuntimeSnapshot>((resolve) => {
        releaseSnapshot = resolve;
      }),
  );
});

test('health endpoint requires the bridge token and reports generation', async () => {
  hotPathMetrics.disable();
  await withServer(async (harness) => {
    const denied = await fetch(`http://127.0.0.1:${String(harness.port)}/health`);
    assert.equal(denied.status, 401);
    const allowed = await fetch(
      `http://127.0.0.1:${String(harness.port)}/health?token=${harness.token}`,
    );
    assert.equal(allowed.status, 200);
    const body = (await allowed.json()) as {
      ok: boolean;
      generation: string;
      lastSeq: number;
      eventLoopDelayMs: number;
    };
    assert.equal(body.ok, true);
    assert.equal(typeof body.generation, 'string');
    assert.equal(typeof body.lastSeq, 'number');
    assert.equal(typeof body.eventLoopDelayMs, 'number');
    assert.equal(body.eventLoopDelayMs, 0);
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
    const body = (await allowed.json()) as {
      pid: number;
      counters: Record<string, number>;
      eventLoop: { meanMs: number } | null;
    };
    assert.equal(typeof body.pid, 'number');
    assert.ok(body.counters);
    assert.equal(body.eventLoop, null);
  });
});

test('perf metrics can arm event-loop sampling on demand without changing /health liveness', async () => {
  await withServer(async (harness) => {
    try {
      const idle = await fetch(
        `http://127.0.0.1:${String(harness.port)}/perf/metrics?token=${harness.token}`,
      );
      const idleBody = (await idle.json()) as { eventLoop: { meanMs: number } | null };
      assert.equal(idleBody.eventLoop, null);

      const armed = await fetch(
        `http://127.0.0.1:${String(harness.port)}/perf/metrics?token=${harness.token}&eventLoop=1`,
      );
      const armedBody = (await armed.json()) as { eventLoop: { meanMs: number } | null };
      assert.ok(armedBody.eventLoop !== null);
      assert.ok(Number.isFinite(armedBody.eventLoop.meanMs));

      const health = await fetch(
        `http://127.0.0.1:${String(harness.port)}/health?token=${harness.token}`,
      );
      assert.equal(health.status, 200);
      const healthBody = (await health.json()) as { ok: boolean; eventLoopDelayMs: number };
      assert.equal(healthBody.ok, true);
      assert.equal(typeof healthBody.eventLoopDelayMs, 'number');
    } finally {
      hotPathMetrics.disable();
    }
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
