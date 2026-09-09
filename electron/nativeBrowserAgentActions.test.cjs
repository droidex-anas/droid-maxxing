const { EventEmitter } = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createNativeBrowserAgentActions } = require('./nativeBrowserAgentActions.cjs');
const interaction = require('./browserAgentInteraction.cjs');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, reject, resolve };
}

function harness(overrides = {}) {
  const calls = {
    agentApproval: [],
    authentication: [],
    close: [],
    open: [],
    reload: [],
    resize: [],
    originApproval: [],
    scripts: [],
  };
  const contents = new EventEmitter();
  let debuggerAttached = false;
  Object.assign(contents, {
    debugger: {
      attach() {
        debuggerAttached = true;
      },
      isAttached: () => debuggerAttached,
      sendCommand: async () => ({}),
    },
    isDestroyed: () => false,
    getURL: () => 'https://site.test/page',
    setBackgroundThrottling() {},
    executeJavaScript: async (script) => {
      calls.scripts.push(script);
      if (script.includes('__DROIDMAXX_AGENT_CONTEXT')) {
        return { documentId: 'doc-1', snapshotId: 'snapshot-1', urlHash: 'url-1' };
      }
      if (script.includes('__DROIDMAXX_SENSITIVE_FIELD')) return null;
      if (script.includes('__DROIDMAXX_RESOLVE_POINTER')) return { x: 10, y: 12 };
      if (script.includes('__DROIDMAXX_AGENT_ACTION')) {
        if (overrides.execution && !script.includes('"action":"snapshot"')) {
          return overrides.execution.promise;
        }
        return {
          requestId: 'request-1',
          ok: true,
          snapshot: { url: 'https://site.test/page' },
        };
      }
      return undefined;
    },
    navigationHistory: {
      canGoBack: () => true,
      canGoForward: () => false,
      canGoToOffset: () => false,
      getActiveIndex: () => 0,
      getEntryAtIndex: () => undefined,
      goToOffset() {},
    },
    ...overrides.contents,
  });
  const view = {
    webContents: contents,
    getBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
  };
  const entry = {
    browserSessionId: 'browser-1',
    appSessionId: null,
    view,
    attached: false,
    visible: true,
    viewport: { width: 800, height: 600, deviceScaleFactor: 2 },
    networkEvents: [],
    consoleEvents: [],
    documentGeneration: 1,
    agentActionActive: false,
    userNavigationActive: false,
    agentRequest: null,
    pendingAgentNavigation: null,
    approvedHistoryTransition: null,
    authenticationPopupCapability: null,
  };
  let currentEntry = entry;
  const actions = createNativeBrowserAgentActions({
    appName: 'DROIDEX',
    ensureView: () => currentEntry ?? entry,
    getEntry: () => currentEntry,
    restoreForAction: async () => entry,
    openBrowser: async (id, url, viewport) => {
      calls.open.push({ id, url, viewport });
      if (overrides.open) await overrides.open.promise;
    },
    reloadBrowser: async () => {
      calls.reload.push('browser-1');
      if (overrides.reload) await overrides.reload.promise;
    },
    closeBrowser: (id) => {
      calls.close.push(id);
      currentEntry = null;
    },
    resizeBrowser: async (_entry, viewport) => {
      calls.resize.push(viewport);
      if (overrides.resize) await overrides.resize.promise;
    },
    page: { capture: async () => 'image' },
    navigation: {
      authorizeHistoryTransition: async (_entry, _view, url, autonomy) => {
        calls.originApproval.push({ url, autonomy });
        if (overrides.originApproval) await overrides.originApproval.promise;
      },
      consumePendingApproval: async () => false,
      finishAgentAction: (candidate) => {
        candidate.pendingAgentNavigation = null;
        candidate.approvedHistoryTransition = null;
      },
      ...overrides.navigation,
    },
    credentials: {
      authorizeAuthentication: async () => {
        calls.authentication.push('browser-1');
        if (overrides.authentication) await overrides.authentication.promise;
      },
      fillForAgent: async (_entry, _contents, request) => ({
        requestId: request.requestId,
        ok: true,
        snapshot: { url: 'https://site.test/page' },
      }),
      invalidate: (candidate) => {
        candidate.authenticationPopupCapability = null;
      },
    },
    browserSettings: {
      authorizeAgentRequest: async (request) => {
        calls.agentApproval.push(request);
        if (overrides.agentApproval) await overrides.agentApproval.promise;
      },
      authorizeAgentOrigin: async (url, autonomy) => {
        calls.originApproval.push({ url, autonomy });
        if (overrides.originApproval) await overrides.originApproval.promise;
      },
    },
    cursor: overrides.cursor ?? {
      park: () => true,
      show: async () => true,
    },
    interaction,
    safeWebContents: (candidate) => candidate?.webContents ?? null,
    scheduleIdleClose: () => {},
  });
  return { actions, calls, contents, entry, getCurrentEntry: () => currentEntry, view };
}

function request(action, fields = {}) {
  return {
    requestId: 'request-1',
    browserSessionId: 'browser-1',
    appSessionId: 'app-1',
    autonomy: 'medium',
    action,
    ...fields,
  };
}

test('open pins agent activity before loading and never attaches the browser view', async () => {
  const open = deferred();
  const { actions, calls, entry } = harness({ open });

  const result = actions.run(
    request('open', { url: 'https://site.test/page', viewport: { width: 900, height: 700 } }),
  );
  await Promise.resolve();

  assert.equal(entry.agentActionActive, true);
  assert.equal(entry.attached, false);
  assert.deepEqual(calls.open, [
    {
      id: 'browser-1',
      url: 'https://site.test/page',
      viewport: { width: 900, height: 700 },
    },
  ]);
  open.resolve();
  assert.equal((await result).ok, true);
  assert.equal(entry.agentActionActive, false);
});

test('close during agent authorization cannot reopen the browser after approval', async () => {
  const agentApproval = deferred();
  const { actions, calls, entry, getCurrentEntry } = harness({ agentApproval });
  const opening = actions.run(request('open', { url: 'https://site.test/page' }));
  await Promise.resolve();

  assert.equal(entry.agentActionActive, true);
  assert.deepEqual(calls.agentApproval, [request('open', { url: 'https://site.test/page' })]);
  assert.deepEqual(calls.open, []);

  await actions.run(request('close'));
  assert.equal(getCurrentEntry(), null);
  agentApproval.resolve();

  await assert.rejects(opening, /browser.*changed while.*authorization/i);
  assert.deepEqual(calls.open, []);
  assert.equal(getCurrentEntry(), null);
});

test('failed agent action releases its pending navigation approval before retry', async () => {
  const open = deferred();
  const { actions, entry } = harness({ open });
  const opening = actions.run(request('open', { url: 'https://site.test/page' }));
  await Promise.resolve();
  entry.pendingAgentNavigation = { promise: Promise.reject(new Error('origin denied')) };
  void entry.pendingAgentNavigation.promise.catch(() => undefined);
  open.reject(new Error('page open failed'));

  await assert.rejects(opening, /page open failed/);
  assert.equal(entry.pendingAgentNavigation, null);
});

test('direct user navigation skips agent policy authorization inside admission', async () => {
  const { actions, calls } = harness();

  await actions.run(request('open', { source: 'user', url: 'https://site.test/page' }));

  assert.deepEqual(calls.agentApproval, []);
  assert.equal(calls.open.length, 1);
});

test('page replacement during authentication approval prevents final agent input', async () => {
  const authentication = deferred();
  const { actions, calls, entry } = harness({ authentication });
  const result = actions.run(request('click', { ref: 'ref-1' }));
  await Promise.resolve();
  await Promise.resolve();
  entry.documentGeneration += 1;
  authentication.resolve();

  await assert.rejects(result, /page changed before the browser action completed/i);
  assert.equal(
    calls.scripts.filter((script) => script.includes('__DROIDMAXX_AGENT_ACTION')).length,
    0,
  );
});

test('authentication approval does not consume the navigation timeout', async (t) => {
  const timers = [];
  t.mock.method(globalThis, 'setTimeout', (callback, timeoutMs) => {
    const timer = { callback, timeoutMs, cleared: false, unref() {} };
    timers.push(timer);
    return timer;
  });
  t.mock.method(globalThis, 'clearTimeout', (timer) => {
    timer.cleared = true;
  });
  const authentication = deferred();
  const { actions, calls } = harness({ authentication });
  const result = actions.run(request('click', { ref: 'ref-1' }));
  while (calls.authentication.length === 0) await Promise.resolve();

  assert.equal(
    timers.some(({ timeoutMs }) => timeoutMs === 7_000),
    false,
  );
  authentication.resolve();

  assert.equal((await result).ok, true);
  const navigationTimer = timers.find(({ timeoutMs }) => timeoutMs === 7_000);
  assert.ok(navigationTimer);
  assert.equal(navigationTimer.cleared, true);
});

test('navigation that wins the action race returns a fresh snapshot', async () => {
  const execution = deferred();
  const { actions, contents } = harness({ execution });
  const result = actions.run(request('click', { ref: 'ref-1' }));
  while (contents.listenerCount('did-start-navigation') === 0) await Promise.resolve();
  contents.emit('did-start-navigation', {}, 'https://site.test/next', false, true);
  contents.emit('did-finish-load');
  execution.resolve({
    requestId: 'request-1',
    ok: true,
    snapshot: { url: 'https://site.test/stale' },
  });

  assert.deepEqual(await result, {
    requestId: 'request-1',
    ok: true,
    snapshot: {
      url: 'https://site.test/page',
      canGoBack: true,
      canGoForward: false,
    },
  });
});

test('an interaction that resolves mid-navigation re-snapshots the new page', async () => {
  const execution = deferred();
  const { actions, contents } = harness({ execution });
  const result = actions.run(request('click', { ref: 'ref-1' }));
  while (contents.listenerCount('did-start-navigation') === 0) await Promise.resolve();
  contents.emit('did-start-navigation', {}, 'https://site.test/next', false, true);
  execution.resolve({
    requestId: 'request-1',
    ok: true,
    snapshot: { url: 'https://site.test/stale' },
  });
  await new Promise((resolve) => setImmediate(resolve));
  contents.emit('did-finish-load');

  assert.deepEqual(await result, {
    requestId: 'request-1',
    ok: true,
    snapshot: {
      url: 'https://site.test/page',
      canGoBack: true,
      canGoForward: false,
    },
  });
});

test('a failed agent action clears the approved authentication popup capability', async () => {
  const execution = deferred();
  const { actions, calls, entry } = harness({ execution });
  entry.authenticationPopupCapability = { targetUrl: 'https://site.test/page' };
  const result = actions.run(request('click', { ref: 'ref-1' }));
  while (!calls.scripts.some((script) => script.includes('"nativeInputPhase":"prepare"'))) {
    await Promise.resolve();
  }
  execution.reject(new Error('click failed'));

  await assert.rejects(result, /click failed/);
  assert.equal(entry.authenticationPopupCapability, null);
});

test('a navigation timeout holds the reservation until the interaction settles', async (t) => {
  const timers = [];
  t.mock.method(globalThis, 'setTimeout', (callback, timeoutMs) => {
    const timer = { callback, timeoutMs, cleared: false, unref() {} };
    timers.push(timer);
    return timer;
  });
  t.mock.method(globalThis, 'clearTimeout', (timer) => {
    timer.cleared = true;
  });
  const execution = deferred();
  const { actions, calls, entry } = harness({ execution });
  const result = actions.run(request('click', { ref: 'ref-1' }));
  while (!calls.scripts.some((script) => script.includes('"nativeInputPhase":"prepare"'))) {
    await Promise.resolve();
  }
  timers.find(({ timeoutMs }) => timeoutMs === 7_000).callback();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(entry.agentActionActive, true);
  execution.resolve({ requestId: 'request-1', ok: true, snapshot: {} });

  await assert.rejects(result, /navigation timed out/i);
  assert.equal(entry.agentActionActive, false);
});

test('reload timeout rejects instead of returning a stale snapshot', async (t) => {
  const timers = [];
  t.mock.method(globalThis, 'setTimeout', (callback, timeoutMs) => {
    const timer = { callback, timeoutMs, cleared: false, unref() {} };
    timers.push(timer);
    return timer;
  });
  t.mock.method(globalThis, 'clearTimeout', (timer) => {
    timer.cleared = true;
  });
  const { actions, calls } = harness();
  const reload = actions.run(request('reload'));
  while (calls.reload.length === 0) await Promise.resolve();

  const navigationTimer = timers.find(({ timeoutMs }) => timeoutMs === 7_000);
  assert.ok(navigationTimer);
  navigationTimer.callback();

  await assert.rejects(reload, /navigation timed out/i);
});

test('a visible pane without an active run parks the cursor instead of blocking input', async () => {
  const cursorCalls = [];
  const { actions, entry } = harness({
    cursor: {
      park: () => (cursorCalls.push('park'), true),
      show: async () => (cursorCalls.push('show'), false),
    },
  });
  entry.attached = true;
  entry.agentCursorActive = false;

  const result = await actions.run(request('hover', { x: 10, y: 12 }));

  assert.equal(result.ok, true);
  assert.deepEqual(cursorCalls, ['park']);
});

test('resize delegates semantic viewport handling without attaching', async () => {
  const { actions, calls, entry } = harness();
  const viewport = { width: 640, height: 480, deviceScaleFactor: 2 };

  assert.deepEqual(await actions.run(request('resize', { viewport })), {
    requestId: 'request-1',
    ok: true,
  });
  assert.deepEqual(calls.resize, [viewport]);
  assert.equal(entry.attached, false);
});

test('direct user resize skips agent policy without granting navigation trust', async () => {
  const resize = deferred();
  const { actions, calls, entry } = harness({ resize });
  const resizing = actions.run(
    request('resize', {
      source: 'user',
      viewport: { width: 640, height: 480, deviceScaleFactor: 2 },
    }),
  );
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(calls.agentApproval, []);
  assert.equal(entry.userNavigationActive, false);
  assert.equal(entry.agentActionActive, true);

  resize.resolve();
  await resizing;
});

test('browser sessions stay bound to their owning app session', async () => {
  const { actions, entry } = harness();
  entry.appSessionId = 'another-app';

  await assert.rejects(actions.run(request('snapshot')), /belongs to a different DROIDEX chat/i);
});

test('overlapping browser operations are rejected without clearing the active operation', async () => {
  const open = deferred();
  const { actions, entry } = harness({ open });
  const active = actions.run(request('open', { url: 'https://site.test/page' }));
  await Promise.resolve();

  await assert.rejects(actions.run(request('snapshot')), /browser operation is already active/i);
  assert.equal(entry.agentActionActive, true);
  open.resolve();
  await active;
});

test('history navigation is canceled when the page changes during origin approval', async () => {
  const originApproval = deferred();
  let historyNavigations = 0;
  const { actions, calls, contents, entry } = harness({
    originApproval,
    contents: {
      navigationHistory: {
        canGoBack: () => true,
        canGoForward: () => false,
        canGoToOffset: () => true,
        getActiveIndex: () => 1,
        getEntryAtIndex: () => ({ url: 'https://other.test/page' }),
        goToOffset: () => {
          historyNavigations += 1;
        },
      },
    },
  });
  const navigation = actions.run(request('goBack'));
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(calls.originApproval, [{ url: 'https://other.test/page', autonomy: 'medium' }]);
  entry.documentGeneration += 1;
  originApproval.resolve();

  await assert.rejects(navigation, /page changed before the browser action completed/i);
  assert.equal(historyNavigations, 0);
  contents.emit('destroyed');
});

test('history approval does not consume or detach the navigation timeout', async (t) => {
  const timers = [];
  t.mock.method(globalThis, 'setTimeout', (callback, timeoutMs) => {
    const timer = { callback, timeoutMs, cleared: false, unref() {} };
    timers.push(timer);
    return timer;
  });
  t.mock.method(globalThis, 'clearTimeout', (timer) => {
    timer.cleared = true;
  });
  const originApproval = deferred();
  let historyNavigations = 0;
  const { actions, calls, contents, entry } = harness({
    originApproval,
    contents: {
      navigationHistory: {
        canGoBack: () => true,
        canGoForward: () => false,
        canGoToOffset: () => true,
        getActiveIndex: () => 1,
        getEntryAtIndex: () => ({ url: 'https://other.test/page' }),
        goToOffset: () => {
          historyNavigations += 1;
        },
      },
    },
  });
  const result = actions.run(request('goBack'));
  while (calls.originApproval.length === 0) await Promise.resolve();

  assert.equal(
    timers.some(({ timeoutMs }) => timeoutMs === 7_000),
    false,
  );
  assert.equal(entry.agentActionActive, true);
  originApproval.resolve();
  while (historyNavigations === 0) await Promise.resolve();

  const navigationTimer = timers.find(({ timeoutMs }) => timeoutMs === 7_000);
  assert.ok(navigationTimer);
  assert.equal(entry.agentActionActive, true);
  contents.emit('did-start-navigation', {}, 'https://other.test/page', false, true);
  contents.emit('did-finish-load');

  assert.equal((await result).ok, true);
  assert.equal(navigationTimer.cleared, true);
  assert.equal(entry.agentActionActive, false);
});

test('open rejects a replacement view instead of snapshotting the wrong page', async () => {
  const open = deferred();
  const { actions, entry } = harness({ open });
  const result = actions.run(request('open', { url: 'https://site.test/page' }));
  await Promise.resolve();
  entry.view = {
    webContents: {
      isDestroyed: () => false,
      getURL: () => 'https://wrong.test/page',
      executeJavaScript: async () => ({
        requestId: 'request-1',
        ok: true,
        snapshot: { url: 'https://wrong.test/page' },
      }),
      navigationHistory: { canGoBack: () => false, canGoForward: () => false },
      setBackgroundThrottling() {},
    },
  };
  open.resolve();

  await assert.rejects(result, /browser view changed while the page was opening/i);
});
