const test = require('node:test');
const assert = require('node:assert/strict');
const { createNativeBrowserBudget, CAPTURE_SCROLL_SCRIPT } = require('./nativeBrowserBudget.cjs');
const { createNativeBrowserEviction } = require('./nativeBrowserEviction.cjs');

function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function createView(overrides = {}) {
  const contents = {
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
    executeJavaScript: async () => ({ x: 12, y: 34 }),
    getURL: () => 'https://example.test/live',
    ...overrides,
  };
  return { contents, view: { webContents: contents } };
}

function createEntry(overrides = {}) {
  const { contents, view } = createView();
  return {
    contents,
    entry: {
      browserSessionId: 'browser-1',
      view,
      targetUrl: 'https://example.test/target',
      loadingUrl: null,
      attached: false,
      agentActionActive: false,
      userNavigationActive: false,
      captureActivityCount: 0,
      loadingPromise: null,
      documentGeneration: 1,
      lastUsedAt: 0,
      idleTimer: null,
      serialized: null,
      viewCloseReason: null,
      viewport: { width: 1200, height: 800, deviceScaleFactor: 2 },
      state: { designMode: false, pencilMode: false },
      ...overrides,
    },
  };
}

function createHarness(entry, overrides = {}) {
  const closed = [];
  const loads = [];
  const failures = [];
  const budget =
    overrides.budget ?? createNativeBrowserBudget({ maxLive: 1, idleMs: 0, now: () => 42 });
  const eviction = createNativeBrowserEviction({
    budget,
    entries: () => [entry],
    closeEntry(target, forget) {
      closed.push({ target, forget });
      target.view = null;
    },
    loadUrl(target, url, options) {
      loads.push({ target, url, options });
      return overrides.loadUrl?.(target, url, options) ?? Promise.resolve({ ok: true });
    },
    reportFailure(target, url, message) {
      failures.push({ target, url, message });
    },
  });
  return { budget, closed, eviction, failures, loads };
}

async function withFakeTimers(run) {
  const previousSetTimeout = globalThis.setTimeout;
  const previousClearTimeout = globalThis.clearTimeout;
  const timers = [];
  globalThis.setTimeout = (callback, timeoutMs) => {
    const timer = { callback, timeoutMs, cleared: false };
    timers.push(timer);
    return timer;
  };
  globalThis.clearTimeout = (timer) => {
    if (timer) timer.cleared = true;
  };

  try {
    await run(timers);
  } finally {
    globalThis.setTimeout = previousSetTimeout;
    globalThis.clearTimeout = previousClearTimeout;
  }
}

test('idle scheduling uses one deterministic timer and evicts an unchanged hidden view', async () => {
  await withFakeTimers(async (timers) => {
    const { contents, entry } = createEntry();
    const budget = createNativeBrowserBudget({ maxLive: 2, idleMs: 25, now: () => 42 });
    const { closed, eviction } = createHarness(entry, { budget });

    eviction.schedule(entry);
    assert.equal(timers.length, 1);
    assert.equal(timers[0].timeoutMs, 25);
    assert.equal(entry.idleTimer, timers[0]);

    timers[0].callback();
    await Promise.resolve();
    await Promise.resolve();

    assert.deepEqual(entry.serialized, {
      url: 'https://example.test/live',
      scroll: { x: 12, y: 34 },
      viewport: { width: 1200, height: 800, deviceScaleFactor: 2 },
      state: { designMode: false, pencilMode: false },
      evictedAt: 42,
    });
    assert.equal(entry.viewCloseReason, 'evict');
    assert.equal(entry.view, null);
    assert.equal(closed.length, 1);
    assert.equal(closed[0].forget, false);
    assert.equal(contents.destroyed, false);
  });
});

test('touch cancels the idle timer before refreshing an entry', async () => {
  await withFakeTimers(async (timers) => {
    const { entry } = createEntry();
    const budget = createNativeBrowserBudget({ maxLive: 2, idleMs: 25 });
    const { eviction } = createHarness(entry, { budget });

    eviction.schedule(entry);
    const idleTimer = timers[0];
    assert.equal(idleTimer.cleared, false);

    eviction.touch(entry);

    assert.equal(idleTimer.cleared, true);
    assert.equal(entry.idleTimer, null);
  });
});

test('active browser work is excluded from eviction', async (t) => {
  for (const [name, activeState] of [
    ['agent action', { agentActionActive: true }],
    ['capture', { captureActivityCount: 1 }],
    ['navigation approval', { pendingAgentNavigation: { promise: Promise.resolve() } }],
  ]) {
    await t.test(name, async () => {
      let captureCount = 0;
      const { entry } = createEntry(activeState);
      entry.view.webContents.executeJavaScript = async () => {
        captureCount += 1;
        return { x: 0, y: 0 };
      };
      const { closed, eviction } = createHarness(entry);

      await eviction.evictUnattached();

      assert.equal(captureCount, 0);
      assert.equal(entry.serialized, null);
      assert.equal(closed.length, 0);
    });
  }
});

test('browser work that starts during scroll capture cancels the pending eviction', async (t) => {
  for (const [name, activate] of [
    ['agent action', (entry) => (entry.agentActionActive = true)],
    ['capture', (entry) => (entry.captureActivityCount = 1)],
    [
      'navigation approval',
      (entry) => (entry.pendingAgentNavigation = { promise: Promise.resolve() }),
    ],
  ]) {
    await t.test(name, async () => {
      const captured = deferred();
      const { entry } = createEntry();
      entry.view.webContents.executeJavaScript = () => captured.promise;
      const { closed, eviction } = createHarness(entry);

      const pending = eviction.evictUnattached();
      activate(entry);
      captured.resolve({ x: 8, y: 13 });
      await pending;

      assert.equal(entry.serialized, null);
      assert.equal(entry.viewCloseReason, null);
      assert.equal(closed.length, 0);
    });
  }
});

test('pending eviction cannot settle after its entry identity changes', async (t) => {
  const cases = [
    {
      name: 'touch',
      invalidate: ({ entry, eviction }) => eviction.touch(entry),
    },
    {
      name: 'attachment',
      invalidate: ({ entry }) => (entry.attached = true),
    },
    {
      name: 'view replacement',
      invalidate: ({ entry }) => (entry.view = createView().view),
    },
    {
      name: 'document replacement',
      invalidate: ({ entry }) => (entry.documentGeneration += 1),
    },
    {
      name: 'view close',
      invalidate: ({ contents }) => (contents.destroyed = true),
    },
  ];

  for (const { name, invalidate } of cases) {
    await t.test(name, async () => {
      const captured = deferred();
      const { contents, entry } = createEntry();
      entry.view.webContents.executeJavaScript = (script) => {
        assert.equal(script, CAPTURE_SCROLL_SCRIPT);
        return captured.promise;
      };
      const { closed, eviction } = createHarness(entry);

      const pending = eviction.evictUnattached();
      invalidate({ contents, entry, eviction });
      captured.resolve({ x: 21, y: 34 });
      await pending;

      assert.equal(entry.serialized, null);
      assert.equal(entry.viewCloseReason, null);
      assert.equal(closed.length, 0);
    });
  }
});

test('restore cannot clear or scroll a snapshot after its identity becomes stale', async (t) => {
  const cases = [
    {
      name: 'view replacement',
      invalidate: ({ entry }) => (entry.view = createView().view),
    },
    {
      name: 'snapshot replacement',
      invalidate: ({ entry }) => {
        entry.serialized = { ...entry.serialized, url: 'https://example.test/newer' };
      },
    },
    {
      name: 'view close',
      invalidate: ({ contents }) => (contents.destroyed = true),
    },
  ];

  for (const { name, invalidate } of cases) {
    await t.test(name, async () => {
      const loaded = deferred();
      const restoredScripts = [];
      const snapshot = {
        url: 'https://example.test/restored',
        scroll: { x: 5, y: 8 },
        viewport: { width: 900, height: 700, deviceScaleFactor: 1 },
        state: { designMode: true, pencilMode: false },
        evictedAt: 1,
      };
      const { contents, entry } = createEntry({ serialized: snapshot });
      contents.executeJavaScript = async (script) => {
        restoredScripts.push(script);
      };
      const { closed, eviction, failures, loads } = createHarness(entry, {
        loadUrl: () => loaded.promise,
      });

      const pending = eviction.restore(entry);
      invalidate({ contents, entry });
      loaded.resolve({ ok: true });

      assert.equal(await pending, false);
      assert.equal(loads.length, 1);
      assert.deepEqual(loads[0].options, { force: true });
      assert.deepEqual(restoredScripts, []);
      assert.equal(closed.length, 0);
      assert.deepEqual(failures, []);
      assert.notEqual(entry.serialized, null);
    });
  }
});
