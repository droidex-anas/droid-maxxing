const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function createDomPort() {
  const messageListeners = [];
  return {
    started: false,
    closed: false,
    posted: [],
    start() {
      this.started = true;
    },
    addEventListener(type, listener) {
      if (type === 'message') messageListeners.push(listener);
    },
    postMessage(data) {
      this.posted.push(data);
    },
    close() {
      this.closed = true;
    },
    deliver(data) {
      for (const listener of messageListeners) listener({ data });
    },
  };
}

function loadApi(invokeResult) {
  const calls = [];
  const listeners = [];
  const removedListeners = [];
  const posts = [];
  const channels = [];
  let api;
  const ipcRenderer = {
    invoke(channel, payload) {
      calls.push({ channel, payload });
      return Promise.resolve(invokeResult);
    },
    on(channel, listener) {
      listeners.push({ channel, listener });
    },
    removeListener(channel, listener) {
      removedListeners.push({ channel, listener });
    },
    postMessage(channel, payload, ports) {
      posts.push({ channel, payload, ports });
    },
  };
  const source = readFileSync(path.join(__dirname, 'preload.cjs'), 'utf8');
  vm.runInNewContext(source, {
    Buffer,
    MessageChannel: class MessageChannel {
      constructor() {
        this.port1 = createDomPort();
        this.port2 = createDomPort();
        channels.push(this);
      }
    },
    require(name) {
      if (name !== 'electron') throw new Error(`Unexpected preload dependency: ${name}`);
      return {
        contextBridge: {
          exposeInMainWorld(_name, exposed) {
            api = exposed;
          },
        },
        ipcRenderer,
      };
    },
  });
  return { api, calls, listeners, removedListeners, posts, channels };
}

test('notification IPC returns the main-process delivery result unchanged', async () => {
  const expected = { shown: false, reason: 'failed', message: 'disabled' };
  const { api, calls } = loadApi(expected);

  assert.deepEqual(
    await api.notify('DROIDEX', 'Finished', { silent: true, appSessionId: 'app-1' }),
    expected,
  );
  assert.equal(calls[0].channel, 'notify');
  assert.equal(calls[0].payload.title, 'DROIDEX');
  assert.equal(calls[0].payload.body, 'Finished');
  assert.equal(calls[0].payload.silent, true);
  assert.equal(calls[0].payload.appSessionId, 'app-1');
});

test('native browser IPC carries browserSessionId', async () => {
  const { api, calls } = loadApi();

  await api.nativeBrowserOpen('browser-1', 'https://example.test');

  assert.equal(calls[0].channel, 'native-browser-open');
  assert.equal(calls[0].payload.browserSessionId, 'browser-1');
  assert.equal(calls[0].payload.url, 'https://example.test');
  assert.equal('sessionId' in calls[0].payload, false);
});

test('git turn baseline IPC carries its provisional owner', async () => {
  const { api, calls } = loadApi();

  await api.gitMarkTurnStart('/repo', 'client-1');

  assert.equal(calls[0].channel, 'git-mark-turn-start');
  assert.equal(calls[0].payload.dir, '/repo');
  assert.equal(calls[0].payload.ownerId, 'client-1');
});

test('git turn baseline adoption IPC correlates client and app session identities', async () => {
  const { api, calls } = loadApi();

  await api.gitAdoptTurnBaseline('/repo', 'client-1', 'app-1');

  assert.equal(calls[0].channel, 'git-adopt-turn-baseline');
  assert.equal(calls[0].payload.dir, '/repo');
  assert.equal(calls[0].payload.clientRef, 'client-1');
  assert.equal(calls[0].payload.appSessionId, 'app-1');
});

test('app icon IPC carries the selected mode', async () => {
  const { api, calls } = loadApi();

  await api.setAppIcon('dark');
  await api.setAppIcon('system');

  assert.equal(calls[0].channel, 'app-set-icon');
  assert.equal(calls[0].payload.mode, 'dark');
  assert.equal(calls[1].channel, 'app-set-icon');
  assert.equal(calls[1].payload.mode, 'system');
});

test('app update download does not accept a renderer-supplied URL', async () => {
  const { api, calls } = loadApi();

  await api.downloadAppUpdate();

  assert.equal(calls[0].channel, 'app-download-update');
  assert.equal(calls[0].payload, undefined);
});

test('automatic diagnostics preference uses closed IPC payloads', async () => {
  const { api, calls } = loadApi();

  await api.getAutomaticDiagnostics();
  await api.setAutomaticDiagnostics(false);

  assert.deepEqual(calls[0], { channel: 'diagnostics-preference-get', payload: undefined });
  assert.equal(calls[1].channel, 'diagnostics-preference-set');
  assert.equal(calls[1].payload.enabled, false);
});

test('hardware acceleration preference uses closed IPC payloads', async () => {
  const { api, calls } = loadApi();

  await api.getHardwareAcceleration();
  await api.setHardwareAcceleration(false);

  assert.deepEqual(calls[0], {
    channel: 'hardware-acceleration-preference-get',
    payload: undefined,
  });
  assert.equal(calls[1].channel, 'hardware-acceleration-preference-set');
  assert.equal(calls[1].payload.enabled, false);
});

test('GitHub setup IPC accepts no renderer-controlled command payload', async () => {
  const expected = { ok: true };
  const { api, calls } = loadApi(expected);

  assert.deepEqual(await api.githubInstall(), expected);
  assert.deepEqual(await api.githubAuthenticate(), expected);
  assert.deepEqual(await api.githubCancelSetup(), expected);
  assert.deepEqual(calls[0], { channel: 'github-install', payload: undefined });
  assert.deepEqual(calls[1], { channel: 'github-authenticate', payload: undefined });
  assert.deepEqual(calls[2], { channel: 'github-cancel-setup', payload: undefined });
});

test('GitHub device codes use a removable trusted event subscription', () => {
  const received = [];
  const { api, listeners, removedListeners } = loadApi();

  const unsubscribe = api.onGithubAuthCode((payload) => received.push(payload));
  assert.equal(listeners.length, 1);
  assert.equal(listeners[0].channel, 'github-auth-code');

  listeners[0].listener({}, { code: 'ABCD-7HJK' });
  assert.deepEqual(received, [{ code: 'ABCD-7HJK' }]);

  unsubscribe();
  assert.equal(removedListeners.length, 1);
  assert.equal(removedListeners[0].channel, 'github-auth-code');
  assert.equal(removedListeners[0].listener, listeners[0].listener);
});

test('performance metrics IPC carries no payload', async () => {
  const { api, calls } = loadApi();

  await api.getPerformanceMetrics();

  assert.equal(calls[0].channel, 'get-performance-metrics');
  assert.equal(calls[0].payload, undefined);
});

test('system idle time IPC carries no renderer-controlled payload', async () => {
  const { api, calls } = loadApi(75);

  assert.equal(await api.systemIdleTime(), 75);
  assert.deepEqual(calls[0], { channel: 'system-idle-time', payload: undefined });
});

test('terminal subscribe transfers one MessagePort and posts input without invoke', () => {
  const { api, calls, posts, channels } = loadApi();
  const channel = api.terminalSubscribe('pty-1');
  const rendererPort = channels[0].port2;

  assert.equal(posts.length, 1);
  assert.equal(posts[0].channel, 'terminal-subscribe');
  assert.equal(posts[0].payload.id, 'pty-1');
  assert.equal(posts[0].ports[0], channels[0].port1);
  assert.equal(
    calls.some(
      (call) => call.channel === 'terminal-write' || call.channel === 'terminal-subscribe',
    ),
    false,
  );

  const received = [];
  channel.onEvent((event) => received.push(event));
  rendererPort.deliver({
    kind: 'data',
    data: 'hi',
    sequence: 1,
    byteOffset: 2,
  });
  assert.equal(received.length, 1);
  assert.equal(received[0].kind, 'data');
  assert.equal(received[0].data, 'hi');
  assert.equal(received[0].sequence, 1);
  assert.equal(received[0].byteOffset, 2);
  assert.equal(rendererPort.posted[0].type, 'ack');
  assert.equal(rendererPort.posted[0].bytes, 2);

  channel.postInput('x');
  assert.equal(rendererPort.posted[1].type, 'input');
  assert.equal(rendererPort.posted[1].data, 'x');
});

test('preload queues stay bounded before a consumer attaches and report dropped bytes', () => {
  const { api, channels } = loadApi();
  const channel = api.terminalSubscribe('pty-1');
  const rendererPort = channels[0].port2;
  const chunk = 'x'.repeat(64 * 1024);
  const flood = 40;

  for (let index = 0; index < flood; index += 1) {
    rendererPort.deliver({
      kind: 'data',
      data: chunk,
      sequence: index + 1,
      byteOffset: (index + 1) * chunk.length,
    });
  }

  const received = [];
  channel.onEvent((event) => received.push(event));
  const queuedBytes = received.reduce(
    (total, payload) => total + Buffer.byteLength(payload.data || '', 'utf8'),
    0,
  );
  assert.ok(queuedBytes <= 2 * 1024 * 1024);
  assert.ok(received.some((payload) => payload.truncated === true && payload.droppedBytes > 0));
  assert.ok(received.length < flood);
});
