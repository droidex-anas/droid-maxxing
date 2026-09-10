import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserDesignReferences } from './BrowserDesignReferences.js';
import { BrowserSessionManager, type BrowserRuntime } from './BrowserSessionManager.js';
import type { BrowserSnapshot, BrowserState } from './types.js';

test('browser actions execute in request order within one managed session', async () => {
  const runtime = new ControlledRuntime();
  const manager = new BrowserSessionManager({ runtimeFactory: () => runtime });
  await manager.open({ appSessionId: 'chat-1', url: 'https://example.test' });

  const typeResult = deferred<BrowserSnapshot>();
  runtime.nextTypeResult = typeResult;
  const first = manager.type('chat-1', 'first');
  await runtime.typeStarted.promise;
  const second = manager.keypress('chat-1', 'Enter');
  await Promise.resolve();

  assert.deepEqual(runtime.actions, ['open', 'type:first']);

  const firstRejected = assert.rejects(first, /superseded/);
  typeResult.resolve(snapshot('https://example.test/typed'));
  await firstRejected;
  await second;

  assert.deepEqual(runtime.actions, ['open', 'type:first', 'keypress:Enter']);
  assert.equal(manager.state('chat-1')?.url, 'https://example.test/keypressed');
});

test("a resize queued behind a click commits the click's page with the new viewport", async () => {
  const runtime = new ControlledRuntime();
  const manager = new BrowserSessionManager({ runtimeFactory: () => runtime });
  await manager.open({ appSessionId: 'chat-1', url: 'https://example.test' });

  const clickResult = deferred<BrowserSnapshot>();
  runtime.nextClickResult = clickResult;
  const clicked = manager.click({ appSessionId: 'chat-1', x: 1, y: 1 });
  await runtime.clickStarted.promise;
  const resized = manager.resizeViewport({
    appSessionId: 'chat-1',
    viewport: { width: 390, height: 844, deviceScaleFactor: 2 },
    viewportMode: 'mobile',
  });
  clickResult.resolve(snapshot('https://example.test/clicked'));

  // The resize lands behind the click and supersedes its return value; the
  // committed state must still describe the page the click navigated to.
  await assert.rejects(clicked, /superseded/);
  await resized;

  assert.equal(manager.state('chat-1')?.url, 'https://example.test/clicked');
  assert.deepEqual(manager.state('chat-1')?.viewport, {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
  });
});

test('close invalidates active and queued actions before a replacement is created', async () => {
  const runtimes: ControlledRuntime[] = [];
  const updates: string[] = [];
  const manager = new BrowserSessionManager({
    emit: (event) => {
      if (event.type === 'browser.updated') updates.push(event.state.url);
    },
    runtimeFactory: () => {
      const runtime = new ControlledRuntime();
      runtimes.push(runtime);
      return runtime;
    },
  });
  const firstState = await manager.open({
    appSessionId: 'chat-1',
    url: 'https://old.example.test',
  });
  const oldRuntime = runtimes[0];
  assert.ok(oldRuntime);

  const lateTypeResult = deferred<BrowserSnapshot>();
  oldRuntime.nextTypeResult = lateTypeResult;
  const active = manager.type('chat-1', 'late');
  await oldRuntime.typeStarted.promise;
  const queued = manager.keypress('chat-1', 'Enter');
  const closing = manager.close('chat-1');

  await Promise.all([
    assert.rejects(active, /Browser session closed/),
    assert.rejects(queued, /Browser session closed/),
    closing,
  ]);
  assert.deepEqual(oldRuntime.actions, ['open', 'type:late', 'close']);

  const replacementState = await manager.open({
    appSessionId: 'chat-1',
    url: 'https://new.example.test',
  });
  assert.notEqual(replacementState.browserSessionId, firstState.browserSessionId);
  assert.equal(runtimes.length, 2);
  const updateCount = updates.length;

  lateTypeResult.resolve(snapshot('https://old.example.test/stale'));
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(updates.length, updateCount);
  assert.equal(manager.state('chat-1')?.url, 'https://new.example.test');
});

test('a newer navigation rejects an older update still awaiting design cleanup', async (t) => {
  const runtime = new ControlledRuntime();
  const updates: string[] = [];
  const manager = new BrowserSessionManager({
    emit: (event) => {
      if (event.type === 'browser.updated') updates.push(event.state.url);
    },
    runtimeFactory: () => runtime,
  });
  await manager.open({ appSessionId: 'chat-1', url: 'https://example.test' });
  const cleanupStarted = deferred<void>();
  const finishCleanup = deferred<void>();
  t.mock.method(BrowserDesignReferences.prototype, 'navigate', async (url: string) => {
    if (!url.endsWith('/slow')) return;
    cleanupStarted.resolve();
    await finishCleanup.promise;
  });
  const slowResult = deferred<BrowserSnapshot>();
  runtime.nextTypeResult = slowResult;

  const staleUpdate = manager.type('chat-1', 'slow');
  slowResult.resolve(snapshot('https://example.test/slow'));
  await cleanupStarted.promise;
  await manager.keypress('chat-1', 'Enter');
  finishCleanup.resolve();

  await assert.rejects(staleUpdate, /superseded/);
  assert.equal(manager.state('chat-1')?.url, 'https://example.test/keypressed');
  assert.deepEqual(updates, ['https://example.test', 'https://example.test/keypressed']);
});

test('closing a session rejects an update still awaiting design cleanup', async (t) => {
  const runtime = new ControlledRuntime();
  const updates: string[] = [];
  const manager = new BrowserSessionManager({
    emit: (event) => {
      if (event.type === 'browser.updated') updates.push(event.state.url);
    },
    runtimeFactory: () => runtime,
  });
  await manager.open({ appSessionId: 'chat-1', url: 'https://example.test' });
  const cleanupStarted = deferred<void>();
  const finishCleanup = deferred<void>();
  t.mock.method(BrowserDesignReferences.prototype, 'navigate', async (url: string) => {
    if (!url.endsWith('/slow')) return;
    cleanupStarted.resolve();
    await finishCleanup.promise;
  });
  const slowResult = deferred<BrowserSnapshot>();
  runtime.nextTypeResult = slowResult;

  const staleUpdate = manager.type('chat-1', 'slow');
  slowResult.resolve(snapshot('https://example.test/slow'));
  await cleanupStarted.promise;
  await manager.close('chat-1');
  finishCleanup.resolve();

  await assert.rejects(staleUpdate, /superseded/);
  assert.equal(manager.state('chat-1'), undefined);
  assert.deepEqual(updates, ['https://example.test']);
});

test('a saved screenshot cannot publish over a same-URL page or a replacement session', async (t) => {
  const url = 'https://example.test/reloaded';
  for (const transition of ['reload', 'open', 'replace'] as const) {
    await t.test(transition, async (t) => {
      const updates: BrowserState[] = [];
      const manager = new BrowserSessionManager({
        runtimeFactory: () => new ControlledRuntime(),
        emit: (event) => {
          if (event.type === 'browser.updated') updates.push(event.state);
        },
      });
      await manager.open({ appSessionId: 'chat-1', url });
      const saveStarted = deferred<void>();
      const finishSave = deferred<string>();
      t.mock.method(BrowserDesignReferences.prototype, 'saveImage', async () => {
        saveStarted.resolve();
        return finishSave.promise;
      });

      const captured = manager.screenshot('chat-1');
      await saveStarted.promise;
      if (transition === 'reload') {
        await manager.reload('chat-1');
      } else {
        if (transition === 'replace') await manager.close('chat-1');
        await manager.open({ appSessionId: 'chat-1', url });
      }
      const current = manager.state('chat-1');
      const updateCount = updates.length;
      finishSave.resolve('/tmp/old-document.png');
      await captured;

      assert.equal(manager.state('chat-1'), current);
      assert.equal(manager.state('chat-1')?.screenshotPath, undefined);
      assert.equal(updates.length, updateCount);
    });
  }
});

class ControlledRuntime implements BrowserRuntime {
  readonly actions: string[] = [];
  readonly typeStarted = deferred<void>();
  readonly clickStarted = deferred<void>();
  nextTypeResult?: Deferred<BrowserSnapshot>;
  nextClickResult?: Deferred<BrowserSnapshot>;

  async open(url: string): Promise<BrowserSnapshot> {
    this.actions.push('open');
    return snapshot(url);
  }

  async reload(): Promise<BrowserSnapshot> {
    return snapshot('https://example.test/reloaded');
  }

  async goBack(): Promise<BrowserSnapshot> {
    return snapshot('https://example.test/back');
  }

  async goForward(): Promise<BrowserSnapshot> {
    return snapshot('https://example.test/forward');
  }

  async setViewport(): Promise<void> {}

  async screenshot(): Promise<string> {
    return '';
  }

  async capture(): Promise<string> {
    return '';
  }

  async snapshot(): Promise<BrowserSnapshot> {
    return snapshot('https://example.test');
  }

  async click(): Promise<BrowserSnapshot> {
    this.clickStarted.resolve();
    return this.nextClickResult?.promise ?? snapshot('https://example.test/clicked');
  }

  async hover(): Promise<BrowserSnapshot> {
    return snapshot('https://example.test/hovered');
  }

  async selectOption(): Promise<BrowserSnapshot> {
    return snapshot('https://example.test/selected');
  }

  async type(text: string): Promise<BrowserSnapshot> {
    this.actions.push(`type:${text}`);
    this.typeStarted.resolve();
    return this.nextTypeResult?.promise ?? snapshot('https://example.test/typed');
  }

  async keypress(key: string): Promise<BrowserSnapshot> {
    this.actions.push(`keypress:${key}`);
    return snapshot('https://example.test/keypressed');
  }

  async scroll(): Promise<BrowserSnapshot> {
    return snapshot('https://example.test/scrolled');
  }

  async inspect(selector: string) {
    return {
      selector,
      tagName: 'button',
      attributes: {},
      box: { x: 0, y: 0, width: 1, height: 1 },
      html: '<button></button>',
    };
  }

  async network() {
    return [];
  }

  async console() {
    return [];
  }

  async close(): Promise<void> {
    this.actions.push('close');
  }
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let settle: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return {
    promise,
    resolve(value: T): void {
      if (!settle) throw new Error('Deferred promise was not initialized.');
      settle(value);
    },
  };
}

function snapshot(url: string): BrowserSnapshot {
  return {
    url,
    scroll: { x: 0, y: 0 },
    refs: [],
    canGoBack: false,
    canGoForward: false,
  };
}
