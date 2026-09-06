const assert = require('node:assert/strict');
const test = require('node:test');
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

function hoverContents(onMouseMoved = async () => ({})) {
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
        return onMouseMoved();
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

test('clicks resolve live refs and run in the isolated page without stealing app focus', async () => {
  const scripts = [];
  const inputEvents = [];
  const cursorEvents = [];
  const contents = {
    executeJavaScript: async (script) => {
      scripts.push(script);
      if (script.includes('__DROIDMAXX_RESOLVE_POINTER')) return { x: 120, y: 84 };
      return { requestId: 'request-1', ok: true };
    },
    sendInputEvent: (event) => inputEvents.push(event),
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

  assert.equal(result.ok, true);
  assert.deepEqual(cursorEvents, [{ x: 120, y: 84, pressed: true }]);
  assert.deepEqual(inputEvents, []);
  assert.match(scripts[1], /"action":"click"/);
  assert.match(scripts[1], /"x":120/);
  assert.match(scripts[1], /"__droidexContext":\{"documentId":"document-1"/);
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

test('scroll uses the isolated live scroller and returns a fresh snapshot', async () => {
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
      selector: '#results',
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
  assert.match(scripts[1], /"action":"scroll"/);
  assert.match(scripts[1], /"selector":"#results"/);
});

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
