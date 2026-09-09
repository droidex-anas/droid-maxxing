import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { WebSocket } from 'ws';

import { droidexUserDataDir } from './droidexPaths.js';
import type { ClientCommand, ServerEventBatch } from './protocol.js';
import { hotPathMetrics } from './telemetry/hotPathMetrics.js';
import {
  bridgeHttpUrl,
  closeSocket,
  deferredSnapshot,
  openBridgeSocket,
  socketCloseCode,
  socketRoundTrip,
  waitFor,
  withServer,
} from './testing/bridgeServerFixture.js';

test('broadcast after close is dropped instead of throwing', async () => {
  await withServer(async (harness) => {
    await harness.close();
    assert.doesNotThrow(() => harness.broadcast({ type: 'connection', status: 'connected' }));
  });
});

test('a browser-asset read error after headers leaves the bridge serving', async () => {
  const root = join(droidexUserDataDir(), `bridge-asset-${String(Date.now())}`);
  mkdirSync(root, { recursive: true });
  try {
    await withServer(async (harness) => {
      const readablePath = join(root, 'ok.png');
      const unreadablePath = join(root, 'blocked.png');
      writeFileSync(readablePath, 'png-ok');
      writeFileSync(unreadablePath, 'png-blocked');
      chmodSync(unreadablePath, 0);

      const blockedUrl = bridgeHttpUrl(
        harness,
        `/browser-assets?path=${encodeURIComponent(unreadablePath)}&token=${harness.assetToken}`,
      );
      await fetch(blockedUrl).catch(() => undefined);

      const readableUrl = bridgeHttpUrl(
        harness,
        `/browser-assets?path=${encodeURIComponent(readablePath)}&token=${harness.assetToken}`,
      );
      const response = await fetch(readableUrl);
      assert.equal(response.status, 200);
      assert.equal(await response.text(), 'png-ok');
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('clients without the current bridge protocol are rejected', async () => {
  await withServer(async (harness) => {
    const socket = new WebSocket(`ws://127.0.0.1:${String(harness.port)}?token=${harness.token}`);
    assert.equal(await socketCloseCode(socket), 1002);
  });
});

test('batch-capable client receives one ordered event envelope', async () => {
  await withServer(async (harness) => {
    const { socket, received, opened } = openBridgeSocket(harness);
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
    const {
      socket: first,
      received: firstReceived,
      opened: firstOpened,
    } = openBridgeSocket(harness);
    await firstOpened;

    harness.broadcast({ type: 'connection', status: 'connected' });
    await waitFor(() => firstReceived.length === 1);
    const acknowledged = JSON.parse(firstReceived[0] ?? '') as ServerEventBatch;
    await closeSocket(first);

    harness.broadcast({
      type: 'runtime.updated',
      status: { mode: 'cli_auth', droidPath: '/bin/droid', apiKeyConfigured: false },
    });

    const {
      socket: second,
      received: replayed,
      opened: secondOpened,
    } = openBridgeSocket(harness, {
      generation: acknowledged.generation,
      seq: acknowledged.lastSeq,
    });
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

    const { socket, received, opened } = openBridgeSocket(harness, { seq: 999 });
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
    const {
      socket: first,
      received: firstReceived,
      opened: firstOpened,
    } = openBridgeSocket(harness);
    const firstClosed = socketCloseCode(first);
    await firstOpened;

    harness.broadcast({ type: 'connection', status: 'connected' });
    await waitFor(() => firstReceived.length === 1);
    const acknowledged = JSON.parse(firstReceived[0] ?? '') as ServerEventBatch;
    harness.broadcast({ type: 'error', message: 'x'.repeat(8 * 1024 * 1024) });
    assert.equal(await firstClosed, 1006);

    const {
      socket: second,
      received: resumed,
      opened: secondOpened,
    } = openBridgeSocket(harness, {
      generation: acknowledged.generation,
      seq: acknowledged.lastSeq,
    });
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
    const { socket, received, opened } = openBridgeSocket(harness, {
      generation: 'old-generation',
      seq: 1,
    });
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
  const gate = deferredSnapshot();
  await withServer(
    async (harness) => {
      const { socket, received } = openBridgeSocket(harness, {
        generation: 'old-generation',
        seq: 1,
      });
      await gate.started;
      harness.broadcast({ type: 'connection', status: 'connected' });
      gate.release();
      await waitFor(() => received.length >= 2);
      assert.equal(JSON.parse(received[0] ?? '').type, 'bridge.snapshot');
      const batch = JSON.parse(received[1] ?? '') as ServerEventBatch;
      assert.equal(batch.type, 'events.batch');
      assert.equal(batch.firstSeq, 1);
      await closeSocket(socket);
    },
    async () => undefined,
    gate.getSnapshot,
  );
});

test('commands received during async admission drain in order after the snapshot', async () => {
  const gate = deferredSnapshot();
  const commands: ClientCommand[] = [];

  await withServer(
    async (harness) => {
      const { socket, received, opened } = openBridgeSocket(harness, {
        generation: 'old-generation',
        seq: 0,
      });
      await opened;
      await gate.started;

      socket.send(JSON.stringify({ type: 'connect', apiKey: '' } satisfies ClientCommand));
      socket.send(
        JSON.stringify({
          type: 'browser.restore',
          state: {
            appSessionId: 'app-1',
            browserSessionId: 'browser-1',
            url: 'https://example.test/',
            viewport: { width: 1200, height: 800, deviceScaleFactor: 2 },
            viewportMode: 'fit',
            scroll: { x: 0, y: 0 },
          },
        } satisfies ClientCommand),
      );
      await socketRoundTrip(socket);
      assert.equal(commands.length, 0);

      gate.release();
      await waitFor(() => commands.length === 2 && received.length > 0);
      assert.equal(JSON.parse(received[0] ?? '').type, 'bridge.snapshot');
      assert.deepEqual(
        commands.map((command) => command.type),
        ['connect', 'browser.restore'],
      );
      await closeSocket(socket);
    },
    async (command) => {
      commands.push(command);
    },
    gate.getSnapshot,
  );
});

test('an in-flight command does not block the result command that settles it', async () => {
  const commands: ClientCommand[] = [];
  let settleOpen: (() => void) | undefined;
  let openCompleted = false;
  const openSettled = new Promise<void>((resolve) => {
    settleOpen = resolve;
  });

  await withServer(
    async (harness) => {
      const { socket, opened } = openBridgeSocket(harness);
      await opened;

      socket.send(
        JSON.stringify({
          type: 'browser.open',
          appSessionId: 'app-1',
          url: 'https://example.test/',
        } satisfies ClientCommand),
      );
      socket.send(
        JSON.stringify({
          type: 'browser.native.result',
          result: {
            requestId: 'request-1',
            appSessionId: 'app-1',
            browserSessionId: 'browser-1',
            ok: true,
          },
        } satisfies ClientCommand),
      );
      await socketRoundTrip(socket);

      assert.deepEqual(
        commands.map((command) => command.type),
        ['browser.open', 'browser.native.result'],
      );
      assert.equal(openCompleted, true);
      await closeSocket(socket);
    },
    async (command) => {
      commands.push(command);
      if (command.type === 'browser.open') {
        await openSettled;
        openCompleted = true;
      }
      if (command.type === 'browser.native.result') settleOpen?.();
    },
  );
});

test('async admission closes a client whose queued commands exceed the bound', async () => {
  const gate = deferredSnapshot();
  const commands: ClientCommand[] = [];

  await withServer(
    async (harness) => {
      const { socket, opened } = openBridgeSocket(harness, {
        generation: 'old-generation',
        seq: 0,
      });
      const closed = socketCloseCode(socket);
      await opened;
      await gate.started;
      for (let index = 0; index <= 128; index += 1) {
        socket.send(JSON.stringify({ type: 'runtime.status' } satisfies ClientCommand));
      }
      assert.equal(await closed, 1009);
      gate.release();
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(commands, []);
    },
    async (command) => {
      commands.push(command);
    },
    gate.getSnapshot,
  );
});

test('shutdown discards commands queued during async admission', async () => {
  // Never released: the client stays in admission until shutdown closes it.
  const gate = deferredSnapshot();
  const commands: ClientCommand[] = [];

  await withServer(
    async (harness) => {
      const { socket, opened } = openBridgeSocket(harness, {
        generation: 'old-generation',
        seq: 0,
      });
      const closed = socketCloseCode(socket);
      await opened;
      await gate.started;
      socket.send(JSON.stringify({ type: 'runtime.status' } satisfies ClientCommand));
      await socketRoundTrip(socket);

      await harness.close();
      assert.equal(await closed, 1001);
      assert.deepEqual(commands, []);
    },
    async (command) => {
      commands.push(command);
    },
    gate.getSnapshot,
  );
});

test('health endpoint requires the bridge token and reports generation', async () => {
  hotPathMetrics.disable();
  await withServer(async (harness) => {
    const denied = await fetch(bridgeHttpUrl(harness, `/health`));
    assert.equal(denied.status, 401);
    const allowed = await fetch(bridgeHttpUrl(harness, `/health?token=${harness.token}`));
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
    const denied = await fetch(bridgeHttpUrl(harness, `/perf/metrics`));
    assert.equal(denied.status, 401);

    const allowed = await fetch(bridgeHttpUrl(harness, `/perf/metrics?token=${harness.token}`));
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
      const idle = await fetch(bridgeHttpUrl(harness, `/perf/metrics?token=${harness.token}`));
      const idleBody = (await idle.json()) as { eventLoop: { meanMs: number } | null };
      assert.equal(idleBody.eventLoop, null);

      const armed = await fetch(
        bridgeHttpUrl(harness, `/perf/metrics?token=${harness.token}&eventLoop=1`),
      );
      const armedBody = (await armed.json()) as { eventLoop: { meanMs: number } | null };
      assert.ok(armedBody.eventLoop !== null);
      assert.ok(Number.isFinite(armedBody.eventLoop.meanMs));

      const health = await fetch(bridgeHttpUrl(harness, `/health?token=${harness.token}`));
      assert.equal(health.status, 200);
      const healthBody = (await health.json()) as { ok: boolean; eventLoopDelayMs: number };
      assert.equal(healthBody.ok, true);
      assert.equal(typeof healthBody.eventLoopDelayMs, 'number');
    } finally {
      hotPathMetrics.disable();
    }
  });
});
