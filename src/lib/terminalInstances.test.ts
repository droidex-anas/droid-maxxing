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
      clientWidth: 400,
      clientHeight: 300,
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

function deps(overrides: Partial<TerminalInstanceDeps> = {}) {
  const terminal = new FakeTerminal();
  const events: Array<(event: unknown) => void> = [];
  const killed: string[] = [];
  const base: TerminalInstanceDeps = {
    loadXterm: async () => ({
      Terminal: function () {
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

test('release disposes the xterm and kills the PTY once', async () => {
  fakeDom();
  const d = deps();
  acquireTerminalInstance('tab-c', { appSessionId: 's1', cwd: '/w' }, d.base);
  await new Promise((r) => setTimeout(r, 0));
  await releaseTerminalInstance('tab-c');
  await releaseTerminalInstance('tab-c');
  assert.equal(d.terminal.disposed, true);
  assert.deepEqual(d.killed, ['pty-1']);
  assert.equal(peekTerminalInstance('tab-c'), undefined);
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
