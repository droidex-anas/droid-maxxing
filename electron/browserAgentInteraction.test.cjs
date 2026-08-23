const assert = require('node:assert/strict');
const test = require('node:test');
const {
  blockBrowserAgentSensitiveTyping,
  executeBrowserAgentInteraction,
} = require('./browserAgentInteraction.cjs');

test('clicks resolve the live selector, show the DROIDEX cursor, and use native input', async () => {
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
      showCursor: async (event) => cursorEvents.push(event),
      viewportBounds: { width: 300, height: 200 },
    },
  );

  assert.equal(result.ok, true);
  assert.deepEqual(cursorEvents, [{ x: 120, y: 84, pressed: true }]);
  assert.deepEqual(inputEvents, [
    { type: 'mouseMove', x: 120, y: 84, movementX: 0, movementY: 0 },
    { type: 'mouseDown', x: 120, y: 84, button: 'left', clickCount: 1 },
    { type: 'mouseUp', x: 120, y: 84, button: 'left', clickCount: 1 },
  ]);
  assert.match(scripts[1], /"action":"snapshot"/);
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

test('scroll uses native wheel input and returns a fresh snapshot', async () => {
  const scripts = [];
  const inputEvents = [];
  const cursorEvents = [];
  const contents = {
    executeJavaScript: async (script) => {
      scripts.push(script);
      return { ok: true };
    },
    sendInputEvent: (event) => inputEvents.push(event),
  };

  await executeBrowserAgentInteraction(
    contents,
    {
      action: 'scroll',
      requestId: 'request-2',
      x: 12.3,
      y: 45.8,
      direction: 'down',
      pixels: 640,
    },
    {
      showCursor: async (event) => cursorEvents.push(event),
      viewportBounds: { width: 300, height: 200 },
    },
  );

  assert.deepEqual(cursorEvents, [{ x: 12, y: 46, pressed: false }]);
  assert.deepEqual(inputEvents, [
    { type: 'mouseWheel', x: 12, y: 46, deltaX: 0, deltaY: 640, canScroll: true },
  ]);
  assert.match(scripts[0], /"action":"snapshot"/);
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
