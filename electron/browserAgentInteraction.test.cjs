const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const {
  blockBrowserAgentSensitiveTyping,
  executeBrowserAgentInteraction,
} = require('./browserAgentInteraction.cjs');
const { runWithWebContentsDebugger } = require('./nativeBrowserEmulation.cjs');

const PAGE_CONTEXT = {
  documentId: 'document-1',
  snapshotId: 'document-1:4',
  urlHash: 'url-1',
};

function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function hoverContents(onCommand = async () => ({})) {
  const commands = [];
  const scripts = [];
  let attached = false;
  const contents = {
    debugger: {
      attach() {
        attached = true;
      },
      isAttached: () => attached,
      async sendCommand(name, params) {
        commands.push({ name, params });
        return onCommand(name, params);
      },
    },
    executeJavaScript: async (script) => {
      scripts.push(script);
      if (script.includes('__DROIDMAXX_RESOLVE_POINTER')) return { x: 120, y: 84 };
      if (script.includes('"action":"hover"')) return { requestId: 'request-hover', ok: true };
      return {
        requestId: 'request-hover',
        ok: true,
        snapshot: { url: 'https://example.test/', refs: [] },
      };
    },
    isDestroyed: () => false,
    sendInputEvent() {
      throw new Error('hover must not require a focused BrowserWindow');
    },
  };
  return { commands, contents, scripts };
}

test('click validates in preload and uses one focus-neutral Chromium mouse sequence', async () => {
  const commands = [];
  const scripts = [];
  const cursorEvents = [];
  let attached = false;
  const contents = {
    debugger: {
      attach() {
        attached = true;
      },
      isAttached: () => attached,
      async sendCommand(name, params) {
        commands.push({ name, params });
      },
    },
    executeJavaScript: async (script) => {
      scripts.push(script);
      if (script.includes('__DROIDMAXX_RESOLVE_POINTER')) return { x: 120, y: 84 };
      if (script.includes('"nativeInputPhase":"complete"')) {
        return {
          requestId: 'request-1',
          ok: true,
          snapshot: { url: 'https://example.test/', refs: [] },
        };
      }
      return { requestId: 'request-1', ok: true };
    },
    isDestroyed: () => false,
    sendInputEvent() {
      throw new Error('click must not require a focused BrowserWindow');
    },
  };

  const result = await executeBrowserAgentInteraction(
    contents,
    { requestId: 'request-1', action: 'click', selector: '#continue' },
    {
      showCursor: async (event) => {
        cursorEvents.push(event);
        return true;
      },
      pageContext: PAGE_CONTEXT,
      viewportBounds: { width: 300, height: 200 },
    },
  );

  assert.equal(result.snapshot.url, 'https://example.test/');
  assert.deepEqual(cursorEvents, [{ x: 120, y: 84, pressed: true }]);
  assert.deepEqual(commands, [
    {
      name: 'Input.dispatchMouseEvent',
      params: {
        type: 'mouseMoved',
        x: 120,
        y: 84,
        button: 'none',
        buttons: 0,
        clickCount: 0,
        pointerType: 'mouse',
      },
    },
    {
      name: 'Input.dispatchMouseEvent',
      params: {
        type: 'mousePressed',
        x: 120,
        y: 84,
        button: 'left',
        buttons: 1,
        clickCount: 1,
        pointerType: 'mouse',
      },
    },
    {
      name: 'Input.dispatchMouseEvent',
      params: {
        type: 'mouseReleased',
        x: 120,
        y: 84,
        button: 'left',
        buttons: 0,
        clickCount: 1,
        pointerType: 'mouse',
      },
    },
  ]);
  const clickScripts = scripts.filter(
    (script) => script.includes('__DROIDMAXX_AGENT_ACTION') && script.includes('"action":"click"'),
  );
  assert.equal(clickScripts.length, 3);
  assert.match(clickScripts[0], /"nativeInputPhase":"prepare"/);
  assert.match(clickScripts[0], /"__droidexContext":\{"documentId":"document-1"/);
  assert.match(clickScripts[1], /"nativeInputPhase":"complete"/);
  assert.match(clickScripts[2], /"nativeInputPhase":"cancel"/);
});

test('click sends no press after the page changes during Chromium pointer movement', async () => {
  let current = true;
  const commands = [];
  const scripts = [];
  let attached = false;
  const contents = {
    debugger: {
      attach() {
        attached = true;
      },
      isAttached: () => attached,
      async sendCommand(name, params) {
        commands.push({ name, params });
        current = false;
      },
    },
    executeJavaScript: async (script) => {
      scripts.push(script);
      if (script.includes('__DROIDMAXX_RESOLVE_POINTER')) return { x: 120, y: 84 };
      return { requestId: 'request-stale-move', ok: true };
    },
    isDestroyed: () => false,
  };

  await assert.rejects(
    executeBrowserAgentInteraction(
      contents,
      { requestId: 'request-stale-move', action: 'click', selector: '#continue' },
      {
        isCurrent: () => current,
        showCursor: async () => true,
        pageContext: PAGE_CONTEXT,
        viewportBounds: { width: 300, height: 200 },
      },
    ),
    /page changed before the browser action completed/i,
  );

  assert.deepEqual(
    commands.map((command) => command.params.type),
    ['mouseMoved'],
  );
  assert.equal(
    scripts.filter((script) => script.includes('"nativeInputPhase":"complete"')).length,
    0,
  );
  assert.equal(
    scripts.filter((script) => script.includes('"nativeInputPhase":"cancel"')).length,
    0,
  );
});

test('click releases a pressed button without clicking after the page changes', async () => {
  let current = true;
  const commands = [];
  const scripts = [];
  let attached = false;
  const contents = {
    debugger: {
      attach() {
        attached = true;
      },
      isAttached: () => attached,
      async sendCommand(name, params) {
        commands.push({ name, params });
        if (params.type === 'mousePressed') current = false;
      },
    },
    executeJavaScript: async (script) => {
      scripts.push(script);
      if (script.includes('__DROIDMAXX_RESOLVE_POINTER')) return { x: 120, y: 84 };
      return { requestId: 'request-stale-press', ok: true };
    },
    isDestroyed: () => false,
  };

  await assert.rejects(
    executeBrowserAgentInteraction(
      contents,
      { requestId: 'request-stale-press', action: 'click', selector: '#continue' },
      {
        isCurrent: () => current,
        showCursor: async () => true,
        pageContext: PAGE_CONTEXT,
        viewportBounds: { width: 300, height: 200 },
      },
    ),
    /page changed before the browser action completed/i,
  );

  assert.deepEqual(
    commands.map((command) => [command.params.type, command.params.clickCount]),
    [
      ['mouseMoved', 0],
      ['mousePressed', 1],
      ['mouseReleased', 0],
    ],
  );
  assert.equal(
    scripts.filter((script) => script.includes('"nativeInputPhase":"complete"')).length,
    0,
  );
  assert.equal(
    scripts.filter((script) => script.includes('"nativeInputPhase":"cancel"')).length,
    1,
  );
});

test('hover uses one focus-neutral Chromium mouse move and returns its resulting snapshot', async () => {
  const { commands, contents, scripts } = hoverContents();

  const result = await executeBrowserAgentInteraction(
    contents,
    { requestId: 'request-hover', action: 'hover', selector: '#account' },
    {
      isCurrent: () => true,
      showCursor: async () => true,
      pageContext: PAGE_CONTEXT,
      viewportBounds: { width: 300, height: 200 },
    },
  );

  assert.deepEqual(commands, [
    {
      name: 'Input.dispatchMouseEvent',
      params: {
        type: 'mouseMoved',
        x: 120,
        y: 84,
        button: 'none',
        buttons: 0,
        clickCount: 0,
        pointerType: 'mouse',
      },
    },
  ]);
  assert.equal(result.snapshot.url, 'https://example.test/');
  assert.equal(
    scripts.filter(
      (script) =>
        script.includes('__DROIDMAXX_AGENT_ACTION') && script.includes('"action":"hover"'),
    ).length,
    1,
  );
  assert.equal(scripts.filter((script) => script.includes('"action":"snapshot"')).length, 1);
});

test('hover sends no snapshot request after the page changes during Chromium dispatch', async () => {
  let current = true;
  const { contents, scripts } = hoverContents(async () => {
    current = false;
    return {};
  });

  await assert.rejects(
    executeBrowserAgentInteraction(
      contents,
      { requestId: 'request-hover', action: 'hover', selector: '#account' },
      {
        isCurrent: () => current,
        showCursor: async () => true,
        pageContext: PAGE_CONTEXT,
        viewportBounds: { width: 300, height: 200 },
      },
    ),
    /page changed before the browser action completed/i,
  );
  assert.equal(scripts.filter((script) => script.includes('"action":"snapshot"')).length, 0);
});

test('queued hover rechecks the page before validation or Chromium dispatch', async () => {
  const debuggerStarted = deferred();
  const releaseDebugger = deferred();
  const cursorPlaced = deferred();
  let current = true;
  const { commands, contents, scripts } = hoverContents();
  const blocker = runWithWebContentsDebugger(contents, async () => {
    debuggerStarted.resolve();
    await releaseDebugger.promise;
  });
  await debuggerStarted.promise;

  const action = executeBrowserAgentInteraction(
    contents,
    { requestId: 'request-hover', action: 'hover', selector: '#account' },
    {
      isCurrent: () => current,
      showCursor: async () => {
        cursorPlaced.resolve();
        return true;
      },
      pageContext: PAGE_CONTEXT,
      viewportBounds: { width: 300, height: 200 },
    },
  );
  await cursorPlaced.promise;
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
  current = false;
  releaseDebugger.resolve();
  await blocker;

  await assert.rejects(action, /page changed before the browser action completed/i);
  assert.deepEqual(commands, []);
  assert.equal(scripts.filter((script) => script.includes('__DROIDMAXX_AGENT_ACTION')).length, 0);
});

test('agent-authored text cannot enter password or one-time-code fields', async () => {
  const contents = {
    executeJavaScript: async () => ({ kind: 'one-time code' }),
  };

  await assert.rejects(
    blockBrowserAgentSensitiveTyping(contents, { action: 'type' }),
    /one-time code field/,
  );
});

for (const selector of ['#results', undefined]) {
  test(`scroll preserves its ref target ${selector ? 'with' : 'without'} a selector`, async () => {
    const scripts = [];
    const inputEvents = [];
    const cursorEvents = [];
    const contents = {
      executeJavaScript: async (script) => {
        scripts.push(script);
        if (script.includes('__DROIDMAXX_RESOLVE_POINTER')) return { x: 12, y: 46 };
        return { ok: true };
      },
      sendInputEvent: (event) => inputEvents.push(event),
    };

    await executeBrowserAgentInteraction(
      contents,
      {
        action: 'scroll',
        requestId: 'request-2',
        ref: '@b-current-results',
        selector,
        x: 12.3,
        y: 45.8,
        direction: 'down',
        pixels: 640,
      },
      {
        showCursor: async (event) => {
          cursorEvents.push(event);
          return true;
        },
        pageContext: PAGE_CONTEXT,
        viewportBounds: { width: 300, height: 200 },
      },
    );

    assert.deepEqual(cursorEvents, [{ x: 12, y: 46, pressed: false }]);
    assert.deepEqual(inputEvents, []);
    const sent = vm.runInNewContext(scripts.at(-1), {
      window: { __DROIDMAXX_AGENT_ACTION: (request) => request },
    });
    assert.match(scripts[0], /__DROIDMAXX_RESOLVE_POINTER/);
    assert.match(scripts[0], /"ref":"@b-current-results"/);
    assert.match(scripts[0], /"x":12.3/);
    assert.match(scripts[0], /"y":45.8/);
    assert.equal(sent.action, 'scroll');
    assert.equal(sent.ref, '@b-current-results');
    assert.equal(sent.selector, selector);
    assert.equal(sent.x, 12);
    assert.equal(sent.y, 46);
  });
}

test('untargeted scroll uses the live native viewport center instead of emulated dimensions', async () => {
  const inputEvents = [];
  const cursorEvents = [];
  const contents = {
    executeJavaScript: async () => ({ ok: true }),
    sendInputEvent: (event) => inputEvents.push(event),
  };

  await executeBrowserAgentInteraction(
    contents,
    { action: 'scroll', requestId: 'request-live-scroll', direction: 'down', pixels: 500 },
    {
      showCursor: async (event) => {
        cursorEvents.push(event);
        return true;
      },
      viewportBounds: { width: 523, height: 792 },
    },
  );

  assert.deepEqual(cursorEvents, [{ x: 262, y: 396, pressed: false }]);
  assert.deepEqual(inputEvents, []);
});

test('navigation invalidates a click while cursor placement is pending', async () => {
  const inputEvents = [];
  let resolveCursor;
  let current = true;
  const cursorPlaced = new Promise((resolve) => {
    resolveCursor = resolve;
  });
  const contents = {
    executeJavaScript: async (script) =>
      script.includes('__DROIDMAXX_RESOLVE_POINTER') ? { x: 120, y: 84 } : { ok: true },
    sendInputEvent: (event) => inputEvents.push(event),
  };

  const action = executeBrowserAgentInteraction(
    contents,
    { requestId: 'request-navigation-race', action: 'click', selector: '#continue' },
    {
      isCurrent: () => current,
      showCursor: () => cursorPlaced,
      viewportBounds: { width: 300, height: 200 },
    },
  );
  current = false;
  resolveCursor(true);

  await assert.rejects(action, /page changed before the browser action completed/);
  assert.deepEqual(inputEvents, []);
});

test('navigation invalidates typing and keypresses before page code can receive them', async () => {
  const scripts = [];
  const contents = {
    executeJavaScript: async (script) => {
      scripts.push(script);
      return { ok: true };
    },
  };

  for (const request of [
    { requestId: 'request-type-race', action: 'type', text: 'hello' },
    { requestId: 'request-enter-race', action: 'keypress', key: 'Enter' },
  ]) {
    await assert.rejects(
      executeBrowserAgentInteraction(contents, request, {
        isCurrent: () => false,
        viewportBounds: { width: 300, height: 200 },
      }),
      /page changed before the browser action completed/,
    );
  }

  assert.deepEqual(scripts, []);
});

test('keypress reaches the page as a trusted Chromium key event', async () => {
  const { commands, contents, scripts } = hoverContents();

  const result = await executeBrowserAgentInteraction(
    contents,
    { requestId: 'request-tab', action: 'keypress', key: 'Tab' },
    {
      isCurrent: () => true,
      pageContext: PAGE_CONTEXT,
      viewportBounds: { width: 300, height: 200 },
    },
  );

  assert.deepEqual(
    commands.map(({ name, params }) => [name, params.type, params.windowsVirtualKeyCode]),
    [
      ['Input.dispatchKeyEvent', 'rawKeyDown', 9],
      ['Input.dispatchKeyEvent', 'keyUp', 9],
    ],
  );
  assert.equal(result.snapshot.url, 'https://example.test/');
  assert.equal(scripts.filter((script) => script.includes('"action":"snapshot"')).length, 1);
});

test('cancellation during keydown skips Enter submission and preserves cancellation if keyup fails', async () => {
  const keyDownStarted = deferred();
  const keyDownFinished = deferred();
  let current = true;
  const { commands, contents, scripts } = hoverContents(async (_name, params) => {
    if (params.type === 'rawKeyDown') {
      keyDownStarted.resolve();
      await keyDownFinished.promise;
    }
    if (params.type === 'keyUp') throw new Error('key release failed');
  });
  const action = executeBrowserAgentInteraction(
    contents,
    { requestId: 'request-enter-race', action: 'keypress', key: 'Enter' },
    { isCurrent: () => current, pageContext: PAGE_CONTEXT },
  );
  const rejected = assert.rejects(action, /page changed before the browser action completed/i);
  await keyDownStarted.promise;
  current = false;
  keyDownFinished.resolve();
  await rejected;

  assert.deepEqual(
    commands.map(({ name, params }) => [name, params.type, params.windowsVirtualKeyCode]),
    [
      ['Input.dispatchKeyEvent', 'rawKeyDown', 13],
      ['Input.dispatchKeyEvent', 'keyUp', 13],
    ],
  );
  assert.equal(scripts.length, 1);
  assert.match(scripts[0], /"action":"keypress"/);
});

test('failed character dispatch releases the key without masking the dispatch error', async () => {
  const dispatchError = new Error('character dispatch failed');
  const { commands, contents, scripts } = hoverContents(async (_name, params) => {
    if (params.type === 'char') throw dispatchError;
    if (params.type === 'keyUp') throw new Error('key release failed');
  });
  await assert.rejects(
    executeBrowserAgentInteraction(
      contents,
      { requestId: 'request-enter-error', action: 'keypress', key: 'Enter' },
      { isCurrent: () => true, pageContext: PAGE_CONTEXT },
    ),
    (error) => error === dispatchError,
  );
  assert.deepEqual(
    commands.map(({ params }) => params.type),
    ['rawKeyDown', 'char', 'keyUp'],
  );
  assert.equal(scripts.length, 1);
});

test('native input is blocked when the exact point is outside the live viewport', async () => {
  const inputEvents = [];
  const contents = {
    executeJavaScript: async () => ({ x: 300, y: 40 }),
    sendInputEvent: (event) => inputEvents.push(event),
  };

  await assert.rejects(
    executeBrowserAgentInteraction(
      contents,
      { requestId: 'request-3', action: 'click', selector: '#stale' },
      { showCursor: async () => true, viewportBounds: { width: 300, height: 200 } },
    ),
    /outside the live browser viewport/,
  );
  assert.deepEqual(inputEvents, []);
});

test('visible native input is blocked when the trusted cursor cannot be placed', async () => {
  const inputEvents = [];
  const contents = {
    executeJavaScript: async () => ({ x: 120, y: 84 }),
    sendInputEvent: (event) => inputEvents.push(event),
  };

  await assert.rejects(
    executeBrowserAgentInteraction(
      contents,
      { requestId: 'request-4', action: 'click', selector: '#continue' },
      { showCursor: async () => false, viewportBounds: { width: 300, height: 200 } },
    ),
    /could not place the trusted agent cursor/,
  );
  assert.deepEqual(inputEvents, []);
});

test('visible native input is blocked without a trusted cursor controller', async () => {
  const inputEvents = [];
  const contents = {
    executeJavaScript: async () => ({ x: 120, y: 84 }),
    sendInputEvent: (event) => inputEvents.push(event),
  };

  await assert.rejects(
    executeBrowserAgentInteraction(
      contents,
      { requestId: 'request-without-cursor', action: 'click', selector: '#continue' },
      { viewportBounds: { width: 300, height: 200 } },
    ),
    /could not place the trusted agent cursor/,
  );
  assert.deepEqual(inputEvents, []);
});
