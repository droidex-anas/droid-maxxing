import assert from 'node:assert/strict';
import test from 'node:test';

import { WebSocket } from 'ws';

import { MAX_BRIDGE_FRAME_BYTES } from './bridgeCommandParser.js';
import { startBridgeServer } from './bridgeServer.js';
import { BRIDGE_PROTOCOL_VERSION, type ClientCommand, type ServerWireMessage } from './protocol.js';

const MARKER = 'untrusted-payload-marker';

interface Harness {
  port: number;
  token: string;
  commands: ClientCommand[];
  close(): Promise<void>;
}

async function withServer(handler: (harness: Harness) => Promise<void>): Promise<void> {
  const token = 'test-token';
  const commands: ClientCommand[] = [];
  const server = startBridgeServer({
    requestedPort: 0,
    token,
    assetToken: 'test-asset-token',
    onCommand: async (command) => {
      commands.push(command);
    },
  });
  await server.ready;
  try {
    await handler({
      port: server.port,
      token,
      commands,
      close: () => server.close(),
    });
  } finally {
    await server.close();
  }
}

function openClient(harness: Harness): Promise<WebSocket> {
  const socket = new WebSocket(
    `ws://127.0.0.1:${String(harness.port)}?token=${harness.token}&bridgeProtocol=${String(BRIDGE_PROTOCOL_VERSION)}`,
  );
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

function socketCloseCode(socket: WebSocket, timeoutMs = 4_000): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('socket close timed out')), timeoutMs);
    socket.once('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

function nextMessage(socket: WebSocket, timeoutMs = 4_000): Promise<ServerWireMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('message timed out')), timeoutMs);
    socket.once('message', (raw) => {
      clearTimeout(timer);
      resolve(JSON.parse(String(raw)) as ServerWireMessage);
    });
  });
}

function closeSocket(socket: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (socket.readyState === socket.CLOSED) {
      resolve();
      return;
    }
    socket.once('close', () => resolve());
    socket.close();
  });
}

test('a valid command reaches onCommand and is not closed', async () => {
  await withServer(async (harness) => {
    const socket = await openClient(harness);
    socket.send(JSON.stringify(runtimeStatus));
    await waitFor(() => harness.commands.length === 1);
    assert.deepEqual(harness.commands, [runtimeStatus]);
    assert.equal(socket.readyState, WebSocket.OPEN);
    await closeSocket(socket);
  });
});

test('invalid JSON never reaches onCommand and does not close the socket', async () => {
  await withServer(async (harness) => {
    const socket = await openClient(harness);
    const message = nextMessage(socket);
    socket.send(`{"type":"${MARKER}"`);
    const error = await message;
    assert.equal(error.type, 'error');
    if (error.type !== 'error') return;
    assert.equal(error.code, 'invalid_bridge_frame');
    assert.equal(error.message.includes(MARKER), false);
    assert.equal(harness.commands.length, 0);
    assert.equal(socket.readyState, WebSocket.OPEN);
    await closeSocket(socket);
  });
});

test('a malformed provider selection never reaches onCommand or an adapter', async () => {
  await withServer(async (harness) => {
    const socket = await openClient(harness);
    const message = nextMessage(socket);
    socket.send(
      JSON.stringify({
        type: 'session.create',
        clientRef: 'ref-1',
        title: 'Title',
        goal: MARKER,
        sessionPurpose: 'chat',
        configuration: {
          providerSelection: {
            providerInstanceId: 'unknown-provider',
            modelId: MARKER,
            options: { nested: { leak: MARKER } },
          },
          interactionMode: 'auto',
          autonomy: 'medium',
        },
      }),
    );
    const error = await message;
    assert.equal(error.type, 'error');
    if (error.type !== 'error') return;
    assert.equal(error.code, 'invalid_bridge_frame');
    assert.equal(error.message.includes(MARKER), false);
    assert.equal(error.message.includes('unknown-provider'), false);
    assert.equal(harness.commands.length, 0);
    await closeSocket(socket);
  });
});

test('schema failures stay open and never call onCommand', async () => {
  await withServer(async (harness) => {
    const socket = await openClient(harness);
    const message = nextMessage(socket);
    socket.send(JSON.stringify({ type: 'session.send', appSessionId: MARKER }));
    const error = await message;
    assert.equal(error.type, 'error');
    if (error.type !== 'error') return;
    assert.equal(error.code, 'invalid_bridge_frame');
    assert.equal(error.message.includes(MARKER), false);
    assert.equal(harness.commands.length, 0);
    assert.equal(socket.readyState, WebSocket.OPEN);
    await closeSocket(socket);
  });
});

test('a binary frame closes with 1003 and never reaches onCommand', async () => {
  await withServer(async (harness) => {
    const socket = await openClient(harness);
    const closed = socketCloseCode(socket);
    socket.send(Buffer.from(JSON.stringify(runtimeStatus)), { binary: true });
    assert.equal(await closed, 1003);
    assert.equal(harness.commands.length, 0);
  });
});

test('invalid UTF-8 closes with 1003 and never reaches onCommand', async () => {
  await withServer(async (harness) => {
    const socket = await openClient(harness);
    const closed = socketCloseCode(socket);
    socket.send(Buffer.from([0xc3, 0x28]), { binary: false });
    assert.equal(await closed, 1003);
    assert.equal(harness.commands.length, 0);
  });
});

test('an oversized text frame closes with 1009 and never reaches onCommand', async () => {
  await withServer(async (harness) => {
    const socket = await openClient(harness);
    const closed = socketCloseCode(socket);
    socket.send(sizedNativeResultFrame(MAX_BRIDGE_FRAME_BYTES + 1), { binary: false });
    assert.equal(await closed, 1009);
    assert.equal(harness.commands.length, 0);
  });
});

test('a frame exactly at the cap is accepted', async () => {
  await withServer(async (harness) => {
    const socket = await openClient(harness);
    socket.send(sizedNativeResultFrame(MAX_BRIDGE_FRAME_BYTES), { binary: false });
    await waitFor(() => harness.commands.length === 1);
    assert.equal(harness.commands[0]?.type, 'browser.native.result');
    assert.equal(socket.readyState, WebSocket.OPEN);
    await closeSocket(socket);
  });
});

test('a frame one byte below the cap is accepted', async () => {
  await withServer(async (harness) => {
    const socket = await openClient(harness);
    socket.send(sizedNativeResultFrame(MAX_BRIDGE_FRAME_BYTES - 1), { binary: false });
    await waitFor(() => harness.commands.length === 1);
    assert.equal(harness.commands[0]?.type, 'browser.native.result');
    await closeSocket(socket);
  });
});

function waitFor(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
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

function sizedNativeResultFrame(size: number): Buffer {
  const prefix =
    '{"type":"browser.native.result","result":{"requestId":"r","appSessionId":"a","browserSessionId":"b","ok":true,"image":"';
  const suffix = '"}}';
  const overhead = Buffer.byteLength(prefix) + Buffer.byteLength(suffix);
  return Buffer.concat([
    Buffer.from(prefix),
    Buffer.alloc(size - overhead, 0x61),
    Buffer.from(suffix),
  ]);
}

const runtimeStatus = { type: 'runtime.status' } as const;
