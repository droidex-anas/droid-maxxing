const assert = require('node:assert/strict');
const test = require('node:test');
const { createTerminalManager, MAX_COLS, MAX_REPLAY_BYTES, MAX_ROWS } = require('./terminal.cjs');

function fixture(options = {}) {
  const instances = [];
  const manager = createTerminalManager({
    platform: 'darwin',
    randomId: (() => {
      let id = 0;
      return () => `terminal-${++id}`;
    })(),
    fsp: options.fsp ?? {
      stat: async () => ({ isDirectory: () => true }),
      realpath: async (cwd) => `/real${cwd}`,
    },
    setTimeout: options.setTimeout,
    clearTimeout: options.clearTimeout,
    exitRetentionMs: options.exitRetentionMs,
    defaultCwd: options.defaultCwd,
    resolveShell: () => ({ file: '/bin/zsh', args: ['-l'] }),
    buildEnv: () => ({ TERM: 'xterm-256color' }),
    loadPty: () => ({
      spawn(file, args, options) {
        let dataHandler = () => {};
        let exitHandler = () => {};
        const instance = {
          file,
          args,
          options,
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

test('terminal manager keeps a PTY alive until explicit kill', async () => {
  const { manager, instances } = fixture();
  const terminal = await manager.create({
    appSessionId: 'session-1',
    cwd: '/repo',
    cols: 100,
    rows: 30,
  });
  assert.equal(terminal.cwd, '/real/repo');
  manager.write(terminal.id, 'echo test\r');
  manager.resize(terminal.id, 120, 40);
  assert.deepEqual(instances[0].writes, ['echo test\r']);
  assert.deepEqual(instances[0].resizes, [[120, 40]]);
  assert.equal(manager.list().length, 1);
  manager.kill(terminal.id);
  assert.equal(instances[0].killed, true);
  assert.equal(manager.list().length, 0);
});

test('terminal manager opens a folderless chat in its configured runtime directory', async () => {
  const { manager, instances } = fixture({ defaultCwd: () => '/droidex/chats' });

  const terminal = await manager.create({ appSessionId: 'chat-1', cwd: '' });

  assert.equal(terminal.cwd, '/real/droidex/chats');
  assert.equal(instances[0].options.cwd, '/real/droidex/chats');
});

test('explicit kill does not retain the terminal after its PTY exits', async () => {
  const cleanups = [];
  const { manager, instances } = fixture({
    setTimeout: (callback) => {
      cleanups.push(callback);
      return { unref() {} };
    },
    clearTimeout: () => {},
    exitRetentionMs: 10,
  });
  const terminal = await manager.create({ appSessionId: 'session-1', cwd: '/repo' });

  manager.kill(terminal.id);
  instances[0].emitExit();

  assert.equal(cleanups.length, 0);
  assert.equal(manager.list().length, 0);
});

test('terminal manager caps dimensions before spawning and resizing the PTY', async () => {
  const { manager, instances } = fixture();
  const terminal = await manager.create({
    appSessionId: 'session-1',
    cwd: '/repo',
    cols: Number.MAX_SAFE_INTEGER,
    rows: Number.MAX_SAFE_INTEGER,
  });

  assert.equal(terminal.cols, MAX_COLS);
  assert.equal(terminal.rows, MAX_ROWS);

  manager.resize(terminal.id, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
  assert.deepEqual(instances[0].resizes, [[MAX_COLS, MAX_ROWS]]);
});

test('terminal subscribers receive bounded replay and exit state', async () => {
  const { manager, instances } = fixture();
  const terminal = await manager.create({ appSessionId: 'session-1', cwd: '/repo' });
  instances[0].emitData('x'.repeat(MAX_REPLAY_BYTES + 32));
  instances[0].emitExit(7, 0);
  const events = [];
  manager.subscribe(terminal.id, (event) => events.push(event));
  assert.equal(events[0].kind, 'replay');
  assert.equal(Buffer.byteLength(events[0].data), MAX_REPLAY_BYTES);
  assert.equal(events[0].truncated, true);
  assert.equal(events[1].kind, 'exit');
  assert.equal(events[1].exitCode, 7);
});

test('terminal manager enforces per-session and global limits', async () => {
  const { manager } = fixture();
  for (let index = 0; index < 4; index += 1) {
    await manager.create({ appSessionId: 'session-1', cwd: '/repo' });
  }
  await assert.rejects(manager.create({ appSessionId: 'session-1', cwd: '/repo' }), /per session/);
  for (let index = 0; index < 4; index += 1) {
    await manager.create({ appSessionId: 'session-2', cwd: '/repo' });
  }
  await assert.rejects(manager.create({ appSessionId: 'session-3', cwd: '/repo' }), /global/);
});

test('concurrent terminal creation cannot exceed the per-session limit', async () => {
  let releaseValidation;
  const validationGate = new Promise((resolve) => {
    releaseValidation = resolve;
  });
  const { manager } = fixture({
    fsp: {
      stat: async () => {
        await validationGate;
        return { isDirectory: () => true };
      },
      realpath: async (cwd) => `/real${cwd}`,
    },
  });
  const creations = Array.from({ length: 6 }, () =>
    manager.create({ appSessionId: 'session-1', cwd: '/repo' }),
  );

  releaseValidation();
  const results = await Promise.allSettled(creations);

  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 4);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 2);
  assert.equal(manager.list().length, 4);
});

test('exited terminals are reclaimed after the retention window', async () => {
  const cleanups = [];
  const { manager, instances } = fixture({
    setTimeout: (callback) => {
      cleanups.push(callback);
      return { unref() {} };
    },
    clearTimeout: () => {},
    exitRetentionMs: 10,
  });
  const exited = [];
  for (let index = 0; index < 4; index += 1) {
    exited.push(await manager.create({ appSessionId: 'session-1', cwd: '/repo' }));
    instances[index].emitExit();
  }

  await assert.rejects(manager.create({ appSessionId: 'session-1', cwd: '/repo' }), /per session/);

  for (const cleanup of cleanups) cleanup();
  assert.equal(manager.list().length, 0);
  await manager.create({ appSessionId: 'session-1', cwd: '/repo' });
});

test('replay trimming preserves complete UTF-8 characters', async () => {
  const { manager, instances } = fixture();
  const terminal = await manager.create({ appSessionId: 'session-1', cwd: '/repo' });
  instances[0].emitData(`🙂${'a'.repeat(MAX_REPLAY_BYTES - 2)}`);
  const events = [];

  manager.subscribe(terminal.id, (event) => events.push(event));

  assert.equal(events[0].kind, 'replay');
  assert.equal(events[0].data.startsWith('\uFFFD'), false);
  assert.equal(events[0].data, 'a'.repeat(MAX_REPLAY_BYTES - 2));
  assert.equal(events[0].droppedBytes, 4);
});

test('replaySince owns window arithmetic at every offset boundary', async () => {
  const { manager, instances } = fixture();
  const terminal = await manager.create({ appSessionId: 'session-1', cwd: '/repo' });
  const overflow = 32;
  instances[0].emitData('x'.repeat(MAX_REPLAY_BYTES + overflow));
  const emitted = MAX_REPLAY_BYTES + overflow;
  const windowStart = overflow;

  const beforeWindow = manager.replaySince(terminal.id, 10);
  assert.equal(beforeWindow.truncated, true);
  assert.equal(beforeWindow.droppedBytes, windowStart - 10);
  assert.equal(Buffer.byteLength(beforeWindow.data), MAX_REPLAY_BYTES);
  assert.equal(beforeWindow.byteOffset, emitted);
  assert.equal(beforeWindow.totalEmittedBytes, emitted);

  const atStart = manager.replaySince(terminal.id, windowStart);
  assert.equal(atStart.truncated, false);
  assert.equal(atStart.droppedBytes, 0);
  assert.equal(Buffer.byteLength(atStart.data), MAX_REPLAY_BYTES);
  assert.equal(atStart.data, 'x'.repeat(MAX_REPLAY_BYTES));

  const midOffset = windowStart + 100;
  const midWindow = manager.replaySince(terminal.id, midOffset);
  assert.equal(midWindow.truncated, false);
  assert.equal(midWindow.droppedBytes, 0);
  assert.equal(Buffer.byteLength(midWindow.data), MAX_REPLAY_BYTES - 100);
  assert.equal(midWindow.data, 'x'.repeat(MAX_REPLAY_BYTES - 100));

  const atHead = manager.replaySince(terminal.id, emitted);
  assert.equal(atHead.data, '');
  assert.equal(atHead.truncated, false);
  assert.equal(atHead.droppedBytes, 0);
  assert.equal(atHead.byteOffset, emitted);

  const fromOrigin = manager.replaySince(terminal.id, 0);
  const subscribed = [];
  manager.subscribe(terminal.id, (event) => subscribed.push(event));
  assert.equal(subscribed[0].kind, 'replay');
  assert.equal(subscribed[0].data, fromOrigin.data);
  assert.equal(subscribed[0].droppedBytes, fromOrigin.droppedBytes);
  assert.equal(subscribed[0].truncated, fromOrigin.truncated);
  assert.equal(subscribed[0].sequence, fromOrigin.sequence);
});

test('terminal manager releases capacity when node-pty fails to load', async () => {
  const manager = createTerminalManager({
    platform: 'darwin',
    randomId: (() => {
      let id = 0;
      return () => `failed-terminal-${++id}`;
    })(),
    fsp: {
      stat: async () => ({ isDirectory: () => true }),
      realpath: async (cwd) => cwd,
    },
    resolveShell: () => ({ file: '/bin/zsh', args: ['-l'] }),
    loadPty: () => {
      throw new Error('node-pty unavailable');
    },
  });

  for (let attempt = 0; attempt < 9; attempt += 1) {
    await assert.rejects(
      manager.create({ appSessionId: 'session-1', cwd: '/repo' }),
      /node-pty unavailable/,
    );
  }
  assert.equal(manager.list().length, 0);
});
