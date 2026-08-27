const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { createTerminalManager, MAX_REPLAY_BYTES } = require('./terminal.cjs');
const {
  createTerminalSubscriptionRegistry,
  TERMINAL_BATCH_MAX_BYTES,
  TERMINAL_BATCH_WINDOW_MS,
  TERMINAL_MAX_INPUT_BYTES,
  TERMINAL_MAX_PENDING_BYTES,
} = require('./terminalPort.cjs');

function fixture() {
  const instances = [];
  const manager = createTerminalManager({
    platform: 'darwin',
    randomId: (() => {
      let id = 0;
      return () => `terminal-${++id}`;
    })(),
    fsp: {
      stat: async () => ({ isDirectory: () => true }),
      realpath: async (cwd) => `/real${cwd}`,
    },
    resolveShell: () => ({ file: '/bin/zsh', args: ['-l'] }),
    buildEnv: () => ({ TERM: 'xterm-256color' }),
    loadPty: () => ({
      spawn(file, args, spawnOptions) {
        let dataHandler = () => {};
        let exitHandler = () => {};
        const instance = {
          file,
          args,
          options: spawnOptions,
          writes: [],
          resizes: [],
          killed: false,
          onData(handler) {
            dataHandler = handler;
          },
          onExit(handler) {
            exitHandler = handler;
          },
          write(data) {
            this.writes.push(data);
          },
          resize(cols, rows) {
            this.resizes.push([cols, rows]);
          },
          kill() {
            this.killed = true;
          },
          emitData(data) {
            dataHandler(data);
          },
          emitExit(exitCode = 0, signal = 0) {
            exitHandler({ exitCode, signal });
          },
        };
        instances.push(instance);
        return instance;
      },
    }),
  });
  return { manager, instances };
}

function fakePort() {
  const emitter = new EventEmitter();
  const port = {
    posted: [],
    closed: false,
    start() {},
    postMessage(data) {
      if (this.closed) throw new Error('port closed');
      this.posted.push(structuredClone(data));
    },
    close() {
      if (this.closed) return;
      this.closed = true;
      emitter.emit('close');
    },
    on(event, handler) {
      emitter.on(event, handler);
    },
    removeListener(event, handler) {
      emitter.removeListener(event, handler);
    },
    emitMessage(data) {
      emitter.emit('message', { data });
    },
  };
  return port;
}

function fakeSender(id = 1) {
  const sender = new EventEmitter();
  sender.id = id;
  sender.destroyed = false;
  sender.isDestroyed = () => sender.destroyed;
  sender.send = () => {
    throw new Error('legacy terminal-event IPC must not be used');
  };
  return sender;
}

function createHarness(options = {}) {
  const timers = [];
  const { manager, instances } = fixture();
  const registry = createTerminalSubscriptionRegistry(manager, {
    setTimeout: (callback) => {
      const handle = { callback };
      timers.push(handle);
      return handle;
    },
    clearTimeout: (handle) => {
      const index = timers.indexOf(handle);
      if (index >= 0) timers.splice(index, 1);
    },
    batchWindowMs: options.batchWindowMs ?? TERMINAL_BATCH_WINDOW_MS,
    batchMaxBytes: options.batchMaxBytes ?? TERMINAL_BATCH_MAX_BYTES,
    maxPendingBytes: options.maxPendingBytes ?? TERMINAL_MAX_PENDING_BYTES,
  });
  return {
    manager,
    instances,
    registry,
    flushTimers() {
      const pending = timers.splice(0);
      for (const timer of pending) timer.callback();
    },
    pendingTimerCount() {
      return timers.length;
    },
  };
}

function dataPayloads(port) {
  return port.posted.filter((payload) => payload.kind === 'data');
}

function postedBytes(port) {
  return port.posted.reduce(
    (total, payload) =>
      payload && typeof payload.data === 'string'
        ? total + Buffer.byteLength(payload.data, 'utf8')
        : total,
    0,
  );
}

function ackAll(port) {
  for (const payload of [...port.posted]) {
    if (payload.kind !== 'data' && payload.kind !== 'replay') continue;
    port.emitMessage({
      type: 'ack',
      bytes: Buffer.byteLength(payload.data || '', 'utf8'),
      byteOffset: payload.byteOffset ?? payload.totalEmittedBytes ?? 0,
    });
  }
}

test('terminal subscription cycles retain one sender cleanup listener', async () => {
  const { manager, registry } = createHarness();
  const sender = fakeSender();
  const terminal = await manager.create({ appSessionId: 'session-1', cwd: '/repo' });

  for (let index = 0; index < 20; index += 1) {
    const port = fakePort();
    registry.subscribe(sender, terminal.id, port);
    registry.unsubscribe(sender, terminal.id);
    assert.equal(port.closed, true);
  }

  assert.equal(sender.listenerCount('destroyed'), 1);

  const active = fakePort();
  registry.subscribe(sender, terminal.id, active);
  sender.emit('destroyed');

  assert.equal(sender.listenerCount('destroyed'), 0);
  assert.equal(active.closed, true);
});

test('input is delivered without a Promise round trip', async () => {
  const { manager, instances, registry } = createHarness();
  const terminal = await manager.create({ appSessionId: 'session-1', cwd: '/repo' });
  const sender = fakeSender();
  const port = fakePort();
  registry.subscribe(sender, terminal.id, port);

  port.emitMessage({ type: 'input', data: 'echo hi\r' });

  assert.deepEqual(instances[0].writes, ['echo hi\r']);
});

test('batched data stays ordered and preserves sequence and byteOffset', async () => {
  const { manager, instances, registry, flushTimers } = createHarness();
  const terminal = await manager.create({ appSessionId: 'session-1', cwd: '/repo' });
  const sender = fakeSender();
  const port = fakePort();
  registry.subscribe(sender, terminal.id, port);
  assert.equal(port.posted[0].kind, 'replay');

  instances[0].emitData('a');
  instances[0].emitData('b');
  instances[0].emitData('c');
  assert.equal(dataPayloads(port).length, 0);

  flushTimers();
  const [batch] = dataPayloads(port);
  assert.equal(batch.data, 'abc');
  assert.equal(batch.sequence, 3);
  assert.equal(batch.byteOffset, 3);
});

test('late subscriber gets replay then live data with no gap or duplication', async () => {
  const { manager, instances, registry, flushTimers } = createHarness();
  const terminal = await manager.create({ appSessionId: 'session-1', cwd: '/repo' });
  const earlySender = fakeSender(1);
  const lateSender = fakeSender(2);
  const early = fakePort();
  registry.subscribe(earlySender, terminal.id, early);

  instances[0].emitData('hello');
  flushTimers();
  instances[0].emitData(' ');
  const late = fakePort();
  registry.subscribe(lateSender, terminal.id, late);
  assert.equal(late.posted[0].kind, 'replay');
  assert.equal(late.posted[0].data, 'hello ');
  assert.equal(late.posted[0].byteOffset, 6);
  assert.equal(late.posted[0].truncated, false);

  instances[0].emitData('world');
  flushTimers();

  const earlyLive = dataPayloads(early)
    .map((payload) => payload.data)
    .join('');
  const lateLive = dataPayloads(late)
    .map((payload) => payload.data)
    .join('');
  assert.equal(`${early.posted[0].data}${earlyLive}`, 'hello world');
  assert.equal(`${late.posted[0].data}${lateLive}`, 'hello world');
});

test('byte cap flushes immediately and reduces a synthetic flood to 32 KiB posts', async () => {
  const { manager, instances, registry, pendingTimerCount } = createHarness();
  const terminal = await manager.create({ appSessionId: 'session-1', cwd: '/repo' });
  const sender = fakeSender();
  const port = fakePort();
  registry.subscribe(sender, terminal.id, port);

  const chunk = 'x'.repeat(64);
  const flood = (TERMINAL_BATCH_MAX_BYTES / 64) * 4;
  for (let index = 0; index < flood; index += 1) instances[0].emitData(chunk);

  const data = dataPayloads(port);
  assert.equal(data.length, 4);
  assert.equal(
    data.every((payload) => Buffer.byteLength(payload.data, 'utf8') === TERMINAL_BATCH_MAX_BYTES),
    true,
  );
  assert.equal(pendingTimerCount(), 0);
  assert.equal(TERMINAL_BATCH_WINDOW_MS, 4);
});

test('pending port bytes stay bounded under flood until the renderer acks', async () => {
  const maxPendingBytes = 1024;
  const batchMaxBytes = 256;
  const { manager, instances, registry, flushTimers } = createHarness({
    maxPendingBytes,
    batchMaxBytes,
  });
  const terminal = await manager.create({ appSessionId: 'session-1', cwd: '/repo' });
  const sender = fakeSender();
  const port = fakePort();
  registry.subscribe(sender, terminal.id, port);

  instances[0].emitData('n'.repeat(MAX_REPLAY_BYTES + 2048));
  flushTimers();

  assert.ok(postedBytes(port) <= maxPendingBytes + batchMaxBytes);
  const beforeAck = port.posted.length;
  ackAll(port);
  assert.ok(port.posted.length > beforeAck);
  const resync = port.posted[port.posted.length - 1];
  assert.equal(resync.kind, 'data');
  assert.equal(resync.truncated, true);
  assert.ok(resync.droppedBytes > 0);
  assert.equal(Buffer.byteLength(resync.data, 'utf8') <= MAX_REPLAY_BYTES, true);
});

test('unsubscribe, port close, sender destroy, clear, and exit all release the port', async () => {
  const { manager, instances, registry } = createHarness();
  const terminal = await manager.create({ appSessionId: 'session-1', cwd: '/repo' });
  const sender = fakeSender();

  const unsubPort = fakePort();
  registry.subscribe(sender, terminal.id, unsubPort);
  registry.unsubscribe(sender, terminal.id);
  registry.unsubscribe(sender, terminal.id);
  assert.equal(unsubPort.closed, true);

  const peerClose = fakePort();
  registry.subscribe(sender, terminal.id, peerClose);
  peerClose.close();
  assert.equal(peerClose.closed, true);
  instances[0].emitData('after-close');
  assert.equal(
    peerClose.posted.some((payload) => payload.kind === 'data'),
    false,
  );

  const destroyed = fakePort();
  registry.subscribe(sender, terminal.id, destroyed);
  sender.emit('destroyed');
  assert.equal(destroyed.closed, true);

  const sender2 = fakeSender(2);
  const cleared = fakePort();
  const other = await manager.create({ appSessionId: 'session-1', cwd: '/repo' });
  registry.subscribe(sender2, other.id, cleared);
  registry.clear();
  assert.equal(cleared.closed, true);

  const sender3 = fakeSender(3);
  const exited = fakePort();
  const leaving = await manager.create({ appSessionId: 'session-2', cwd: '/repo' });
  registry.subscribe(sender3, leaving.id, exited);
  instances[2].emitExit(0, 0);
  assert.equal(
    exited.posted.some((payload) => payload.kind === 'exit'),
    true,
  );
  assert.equal(exited.closed, true);
});

test('double close after exit is idempotent', async () => {
  const { manager, instances, registry } = createHarness();
  const terminal = await manager.create({ appSessionId: 'session-1', cwd: '/repo' });
  const sender = fakeSender();
  const port = fakePort();
  registry.subscribe(sender, terminal.id, port);
  instances[0].emitExit(1, 0);
  registry.unsubscribe(sender, terminal.id);
  registry.clear(sender.id);
  assert.equal(port.closed, true);
  assert.equal(port.posted.filter((payload) => payload.kind === 'exit').length, 1);
});

test('malformed and unknown port messages are ignored without tearing down', async () => {
  const { manager, instances, registry } = createHarness();
  const terminal = await manager.create({ appSessionId: 'session-1', cwd: '/repo' });
  const sender = fakeSender();
  const port = fakePort();
  registry.subscribe(sender, terminal.id, port);

  port.emitMessage(null);
  port.emitMessage('write-me');
  port.emitMessage(['input', 'x']);
  port.emitMessage({ type: 'input' });
  port.emitMessage({ type: 'input', data: 12 });
  port.emitMessage({ type: 'input', data: { text: 'x' } });
  port.emitMessage({ type: 'poke', data: 'x' });
  port.emitMessage({ type: 'ack', bytes: '1', byteOffset: 1 });

  assert.deepEqual(instances[0].writes, []);
  assert.equal(port.closed, false);

  port.emitMessage({ type: 'input', data: 'ok' });
  assert.deepEqual(instances[0].writes, ['ok']);
});

test('an oversized input post is ignored and does not tear down the terminal', async () => {
  const { manager, instances, registry } = createHarness();
  const terminal = await manager.create({ appSessionId: 'session-1', cwd: '/repo' });
  const sender = fakeSender();
  const port = fakePort();
  registry.subscribe(sender, terminal.id, port);

  port.emitMessage({ type: 'input', data: 'x'.repeat(TERMINAL_MAX_INPUT_BYTES + 1) });
  assert.deepEqual(instances[0].writes, []);
  assert.equal(port.closed, false);

  port.emitMessage({ type: 'input', data: 'x'.repeat(TERMINAL_MAX_INPUT_BYTES) });
  assert.equal(instances[0].writes.length, 1);
  assert.equal(instances[0].writes[0].length, TERMINAL_MAX_INPUT_BYTES);
});
