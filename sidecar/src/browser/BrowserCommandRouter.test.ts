import assert from 'node:assert/strict';
import test from 'node:test';
import type { ServerEvent } from '../protocol.js';
import { BrowserCommandRouter, type BrowserCommands } from './BrowserCommandRouter.js';

test('native results settle only the request for the exact app and browser session', async () => {
  const events: ServerEvent[] = [];
  const router = createRouter(events);
  const request = {
    requestId: 'request-1',
    appSessionId: 'app-1',
    browserSessionId: 'browser-1',
    action: 'reload' as const,
  };

  let settled = false;
  const result = router.requestNative(request).then((value) => {
    settled = true;
    return value;
  });

  assert.deepEqual(events.at(-1), {
    type: 'browser.native.request',
    request: { ...request, autonomy: 'high' },
  });

  await router.handle({
    type: 'browser.native.result',
    result: { ...request, appSessionId: 'another-app', ok: true },
  });
  await router.handle({
    type: 'browser.native.result',
    result: { ...request, browserSessionId: 'replacement-browser', ok: true },
  });
  await Promise.resolve();
  assert.equal(settled, false);

  const expected = { ...request, ok: true };
  await router.handle({ type: 'browser.native.result', result: expected });
  assert.deepEqual(await result, expected);
});

test('closing a browser rejects its active requests without affecting another browser', async () => {
  const events: ServerEvent[] = [];
  const router = createRouter(events);
  const activeRequest = {
    requestId: 'active-request',
    appSessionId: 'app-1',
    browserSessionId: 'browser-1',
    action: 'reload' as const,
  };
  const otherRequest = {
    requestId: 'other-request',
    appSessionId: 'app-2',
    browserSessionId: 'browser-2',
    action: 'snapshot' as const,
  };
  const closeRequest = {
    requestId: 'close-request',
    appSessionId: 'app-1',
    browserSessionId: 'browser-1',
    action: 'close' as const,
  };

  const active = router.requestNative(activeRequest);
  const activeRejected = assert.rejects(
    active,
    /Browser session closed before the action completed/,
  );
  const other = router.requestNative(otherRequest);
  const close = router.requestNative(closeRequest);

  await activeRejected;
  assert.deepEqual(events.at(-1), {
    type: 'browser.native.request',
    request: closeRequest,
  });

  const otherResult = { ...otherRequest, ok: true };
  const closeResult = { ...closeRequest, ok: true };
  await router.handle({ type: 'browser.native.result', result: otherResult });
  await router.handle({ type: 'browser.native.result', result: closeResult });
  assert.deepEqual(await other, otherResult);
  assert.deepEqual(await close, closeResult);
});

test('shutdown rejects pending native requests and ignores their late results', async () => {
  const events: ServerEvent[] = [];
  const router = createRouter(events);
  const request = {
    requestId: 'pending-request',
    appSessionId: 'app-1',
    browserSessionId: 'browser-1',
    action: 'snapshot' as const,
  };
  const pending = router.requestNative(request);
  const rejected = assert.rejects(pending, /DROIDEX browser stopped before the action completed/);

  router.shutdown();

  await rejected;
  assert.equal(
    await router.handle({
      type: 'browser.native.result',
      result: { ...request, ok: true },
    }),
    true,
  );
});

function createRouter(events: ServerEvent[]): BrowserCommandRouter {
  return new BrowserCommandRouter({
    browsers: unusedBrowserCommands(),
    emit: (event) => events.push(event),
    getAutonomy: () => 'high',
    sendPrompt: () => Promise.resolve(),
  });
}

function unusedBrowserCommands(): BrowserCommands {
  const unused = (): never => {
    throw new Error('Browser command was not expected in this test.');
  };
  return {
    open: unused,
    restore: unused,
    close: unused,
    closeAll: unused,
    reload: unused,
    refresh: unused,
    resizeViewport: unused,
    click: unused,
    type: unused,
    keypress: unused,
    scroll: unused,
    screenshot: unused,
    inspectPoint: unused,
    addReference: unused,
    designPrompt: unused,
  };
}
