import assert from 'node:assert/strict';
import test from 'node:test';
import {
  acquireTerminalInstance,
  peekTerminalInstance,
  releaseTerminalInstance,
  releaseTerminalInstancesExcept,
  type TerminalInstanceDeps,
} from './terminalInstances';

class FakeTerminal {
  writes: string[] = [];
  disposed = false;
  opened: HTMLElement | null = null;
  cols = 80;
  rows = 24;
  options: Record<string, unknown> = {};
  dataHandler: ((data: string) => void) | null = null;
  loadAddon() {}
  attachCustomKeyEventHandler() {}
  open(host: HTMLElement) {
    this.opened = host;
  }
  write(data: string) {
    this.writes.push(data);
  }
  onData(handler: (data: string) => void) {
    this.dataHandler = handler;
  }
  focus() {}
  dispose() {
    this.disposed = true;
  }
  getSelection() {
    return '';
  }
  clear() {}
  reset() {}
}

function fakeDom() {
  const doc = {
    visibilityState: 'visible',
    createElement: () => ({
      isConnected: false,
      className: '',
      clientWidth: 400,
      clientHeight: 300,
      setAttribute() {},
      remove() {
        this.isConnected = false;
      },
    }),
    addEventListener() {},
    removeEventListener() {},
  };
  (globalThis as { document?: unknown }).document = doc;
  return doc;
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function deps(overrides: Partial<TerminalInstanceDeps> = {}) {
  const terminal = new FakeTerminal();
  const events: Array<(event: unknown) => void> = [];
  const killed: string[] = [];
  const base: TerminalInstanceDeps = {
    loadXterm: async () => ({
      Terminal: function (options: Record<string, unknown>) {
        terminal.options = { ...options };
        return terminal;
      } as never,
      FitAddon: function () {
        return { fit() {} };
      } as never,
    }),
    ensureTerminal: async (_tabId, existingId) => ({
      id: existingId ?? 'pty-1',
      appSessionId: 's1',
      cwd: '/w',
      shell: '/bin/zsh',
      cols: 80,
      rows: 24,
    }),
    closeTerminal: async (_tabId, id) => {
      if (id) killed.push(id);
    },
    subscribe: () => ({
      onEvent: (handler) => {
        events.push(handler);
        return () => {};
      },
      postInput() {},
      close() {},
    }),
    unsubscribe: async () => {},
    resize: async () => {},
    scheduleFrame: (cb) => {
      cb();
      return 1;
    },
    cancelFrame: () => {},
    ...overrides,
  };
  return { base, terminal, events, killed };
}

test('acquire is idempotent per tab and creates one PTY', async () => {
  fakeDom();
  const d = deps();
  const a = acquireTerminalInstance('tab-a', { appSessionId: 's1', cwd: '/w' }, d.base);
  const b = acquireTerminalInstance('tab-a', { appSessionId: 's1', cwd: '/w' }, d.base);
  assert.equal(a, b);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(a.getState().terminalId, 'pty-1');
  assert.equal(a.getState().status, 'running');
  await releaseTerminalInstance('tab-a');
});

test('output while detached is buffered and flushed on attach', async () => {
  fakeDom();
  const d = deps();
  const inst = acquireTerminalInstance('tab-b', { appSessionId: 's1', cwd: '/w' }, d.base);
  await new Promise((r) => setTimeout(r, 0));
  d.events[0]({ kind: 'data', data: 'hello' });
  assert.deepEqual(d.terminal.writes, []);
  const host = {
    appendChild: (el: { isConnected: boolean }) => {
      el.isConnected = true;
    },
  };
  inst.attach(host as unknown as HTMLElement);
  assert.deepEqual(d.terminal.writes, ['hello']);
  await releaseTerminalInstance('tab-b');
});

test('releaseTerminalInstancesExcept drops tabs that disappeared', async () => {
  fakeDom();
  const d = deps();
  acquireTerminalInstance('keep', { appSessionId: 's1', cwd: '/w' }, d.base);
  acquireTerminalInstance('gone', { appSessionId: 's2', cwd: '/w' }, d.base);
  await new Promise((r) => setTimeout(r, 0));
  await releaseTerminalInstancesExcept(new Set(['keep']));
  assert.ok(peekTerminalInstance('keep'));
  assert.equal(peekTerminalInstance('gone'), undefined);
  await releaseTerminalInstance('keep');
});

test('restart replaces an exited PTY', async () => {
  fakeDom();
  let n = 0;
  const d = deps({
    ensureTerminal: async (_tab, existing) => ({
      id: existing ?? `pty-${++n}`,
      appSessionId: 's1',
      cwd: '/w',
      shell: '/bin/zsh',
      cols: 80,
      rows: 24,
    }),
  });
  const inst = acquireTerminalInstance('tab-d', { appSessionId: 's1', cwd: '/w' }, d.base);
  await new Promise((r) => setTimeout(r, 0));
  d.events[0]({ kind: 'exit', exitCode: 0 });
  assert.equal(inst.getState().status, 'exited');
  await inst.restart();
  assert.equal(inst.getState().terminalId, 'pty-2');
  assert.equal(inst.getState().status, 'running');
  assert.deepEqual(d.killed, ['pty-1']);
  await releaseTerminalInstance('tab-d');
});

test('release during the initial connect kills the PTY once and leaves no subscription', async () => {
  fakeDom();
  const deferred = createDeferred<{
    id: string;
    appSessionId: string;
    cwd: string;
    shell: string;
    cols: number;
    rows: number;
  }>();
  let subscribeCount = 0;
  let channelCloseCount = 0;
  const d = deps({
    ensureTerminal: () => deferred.promise,
    subscribe: () => {
      subscribeCount += 1;
      return {
        onEvent: () => () => {},
        postInput() {},
        close() {
          channelCloseCount += 1;
        },
      };
    },
  });
  acquireTerminalInstance('tab-race-release', { appSessionId: 's1', cwd: '/w' }, d.base);
  await new Promise((r) => setTimeout(r, 0));
  const releasePromise = releaseTerminalInstance('tab-race-release');
  deferred.resolve({
    id: 'pty-1',
    appSessionId: 's1',
    cwd: '/w',
    shell: '/bin/zsh',
    cols: 80,
    rows: 24,
  });
  await releasePromise;
  await releaseTerminalInstance('tab-race-release');
  assert.equal(d.terminal.disposed, true);
  assert.deepEqual(d.killed, ['pty-1']);
  assert.equal(subscribeCount - channelCloseCount, 0);
  assert.equal(peekTerminalInstance('tab-race-release'), undefined);
});

test('restart during the initial connect ends with exactly one live subscription', async () => {
  fakeDom();
  const deferred = createDeferred<{
    id: string;
    appSessionId: string;
    cwd: string;
    shell: string;
    cols: number;
    rows: number;
  }>();
  let ensureCalls = 0;
  let subscribeCount = 0;
  let channelCloseCount = 0;
  let latestHandler: ((event: unknown) => void) | null = null;
  const d = deps({
    ensureTerminal: (_tabId, existingId) => {
      ensureCalls += 1;
      if (ensureCalls === 1) return deferred.promise;
      return Promise.resolve({
        id: existingId ?? 'pty-2',
        appSessionId: 's1',
        cwd: '/w',
        shell: '/bin/zsh',
        cols: 80,
        rows: 24,
      });
    },
    subscribe: () => {
      subscribeCount += 1;
      return {
        onEvent: (handler) => {
          latestHandler = handler;
          return () => {};
        },
        postInput() {},
        close() {
          channelCloseCount += 1;
        },
      };
    },
  });
  const inst = acquireTerminalInstance(
    'tab-race-restart',
    { appSessionId: 's1', cwd: '/w' },
    d.base,
  );
  await new Promise((r) => setTimeout(r, 0));
  const restartPromise = inst.restart();
  deferred.resolve({
    id: 'pty-1',
    appSessionId: 's1',
    cwd: '/w',
    shell: '/bin/zsh',
    cols: 80,
    rows: 24,
  });
  await restartPromise;
  assert.equal(subscribeCount - channelCloseCount, 1);
  assert.equal(inst.getState().status, 'running');
  const host = {
    appendChild: (el: { isConnected: boolean }) => {
      el.isConnected = true;
    },
  };
  inst.attach(host as unknown as HTMLElement);
  latestHandler?.({ kind: 'data', data: 'hi' });
  assert.equal(d.terminal.writes.length, 1);
  await releaseTerminalInstance('tab-race-restart');
});

test('a theme set before xterm loads is applied when it is constructed', async () => {
  fakeDom();
  const loaded = createDeferred<void>();
  const d = deps();
  const base = d.base;
  const instance = acquireTerminalInstance(
    'tab-theme',
    { appSessionId: 's1', cwd: '/w' },
    {
      ...base,
      loadXterm: async () => {
        await loaded.promise;
        return base.loadXterm();
      },
    },
  );
  instance.setTheme({ background: '#101010' });
  loaded.resolve();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(d.terminal.options.theme, { background: '#101010' });

  instance.setTheme({ background: '#ffffff' });
  assert.deepEqual(d.terminal.options.theme, { background: '#ffffff' });
  await releaseTerminalInstance('tab-theme');
});

test('failed initialization and restart report errors and remain retryable', async () => {
  fakeDom();
  let loads = 0;
  let connects = 0;
  const initialLoad = createDeferred<void>();
  const d = deps();
  const instance = acquireTerminalInstance(
    'tab-retry-errors',
    { appSessionId: 's1', cwd: '/w' },
    {
      ...d.base,
      loadXterm: async () => {
        if (++loads === 1) {
          await initialLoad.promise;
          throw new Error('xterm failed to load');
        }
        return d.base.loadXterm();
      },
      ensureTerminal: async (...args) => {
        if (++connects === 1) throw new Error('bridge down');
        return d.base.ensureTerminal(...args);
      },
    },
  );
  initialLoad.resolve();
  await instance.restart();
  assert.equal(loads, 2);
  assert.equal(instance.getState().status, 'error');
  assert.equal(instance.getState().error, 'bridge down');

  await instance.restart();
  assert.equal(instance.getState().status, 'running');
  assert.equal(instance.getState().error, '');
  assert.equal(loads, 2);
  await releaseTerminalInstance('tab-retry-errors');
  assert.equal(d.terminal.disposed, true);
  assert.deepEqual(d.killed, ['pty-1']);
});

test('local pump truncation surfaces the trimmed banner and clears on restart', async () => {
  fakeDom();
  const d = deps();
  const inst = acquireTerminalInstance('tab-trim', { appSessionId: 's1', cwd: '/w' }, d.base);
  await new Promise((r) => setTimeout(r, 0));
  // Detached: the pump buffers and caps at 2 MiB, dropping the earliest bytes.
  d.events[0]({ kind: 'data', data: 'x'.repeat(3 * 1024 * 1024) });
  assert.equal(inst.getState().truncated, true);
  let updates = 0;
  const unsubscribe = inst.subscribe(() => {
    updates++;
  });
  d.events[0]({ kind: 'data', data: 'more output' });
  assert.equal(updates, 0);
  unsubscribe();
  await inst.restart();
  assert.equal(inst.getState().truncated, false);
  d.events.at(-1)?.({ kind: 'data', data: 'short' });
  assert.equal(inst.getState().truncated, false);
  await releaseTerminalInstance('tab-trim');
});

test('concurrent restarts share teardown and release waits for that teardown', async () => {
  fakeDom();
  const closing = createDeferred<void>();
  const closeStarted = createDeferred<void>();
  const connected = createDeferred<void>();
  let creates = 0;
  const d = deps({
    ensureTerminal: async () => ({
      id: `pty-${++creates}`,
      appSessionId: 's1',
      cwd: '/w',
      shell: '/bin/zsh',
      cols: 80,
      rows: 24,
    }),
    subscribe: () => {
      connected.resolve();
      return { onEvent: () => () => {}, postInput() {}, close() {} };
    },
    closeTerminal: async (_tab, id) => {
      if (id) d.killed.push(id);
      closeStarted.resolve();
      await closing.promise;
    },
  });
  const instance = acquireTerminalInstance(
    'tab-double-restart',
    { appSessionId: 's1', cwd: '/w' },
    d.base,
  );
  await connected.promise;
  const first = instance.restart();
  await closeStarted.promise;
  const second = instance.restart();
  assert.equal(first, second);
  const released = releaseTerminalInstance('tab-double-restart');
  closing.resolve();
  await Promise.all([first, second, released]);
  assert.equal(creates, 1);
  assert.deepEqual(d.killed, ['pty-1']);
  assert.equal(d.terminal.disposed, true);
});
