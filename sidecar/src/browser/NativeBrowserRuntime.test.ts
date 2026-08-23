import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeBrowserRuntime } from './NativeBrowserRuntime.js';
import type { BrowserNativeRequest } from '../protocol.js';

test('NativeBrowserRuntime sends live requests with application and browser session context', async () => {
  const requests: BrowserNativeRequest[] = [];
  const runtime = new NativeBrowserRuntime({
    appSessionId: 'app-session-one',
    browserSessionId: 'browser-one',
    viewport: { width: 900, height: 700, deviceScaleFactor: 2 },
    nextRequestId: () => `req-${requests.length + 1}`,
    request: async (request) => {
      requests.push(request);
      return {
        requestId: request.requestId,
        appSessionId: request.appSessionId,
        browserSessionId: request.browserSessionId,
        ok: true,
        snapshot: {
          url: request.url ?? 'https://example.com/',
          title: 'Example',
          scroll: { x: 0, y: 0 },
          refs: [],
        },
      };
    },
  });

  const snapshot = await runtime.open('https://example.com/', 'user');
  await runtime.reload('user');
  await runtime.goBack();
  await runtime.goForward();
  await runtime.click(12, 34, '#submit', '@b-snapshot-submit');
  await runtime.hover(56, 78, '#account', '@b-snapshot-account');
  await runtime.selectOption('#country', 'Canada', '@b-snapshot-country');
  await runtime.scroll({
    direction: 'down',
    pixels: 600,
    x: 50,
    y: 100,
    selector: '#results',
    ref: '@b-snapshot-results',
  });

  assert.equal(snapshot.url, 'https://example.com/');
  assert.deepEqual(
    requests.map((request) => request.action),
    ['open', 'reload', 'goBack', 'goForward', 'click', 'hover', 'selectOption', 'scroll'],
  );
  assert.equal(requests[0].appSessionId, 'app-session-one');
  assert.equal(requests[0].browserSessionId, 'browser-one');
  assert.equal(requests[0].source, 'user');
  assert.equal(requests[1].source, 'user');
  assert.deepEqual(requests[0].viewport, { width: 900, height: 700, deviceScaleFactor: 2 });
  assert.deepEqual(
    { x: requests[4].x, y: requests[4].y, selector: requests[4].selector, ref: requests[4].ref },
    { x: 12, y: 34, selector: '#submit', ref: '@b-snapshot-submit' },
  );
  assert.deepEqual(
    { x: requests[5].x, y: requests[5].y, selector: requests[5].selector, ref: requests[5].ref },
    { x: 56, y: 78, selector: '#account', ref: '@b-snapshot-account' },
  );
  assert.deepEqual(
    { selector: requests[6].selector, text: requests[6].text, ref: requests[6].ref },
    { selector: '#country', text: 'Canada', ref: '@b-snapshot-country' },
  );
  assert.deepEqual(
    { selector: requests[7].selector, ref: requests[7].ref },
    { selector: '#results', ref: '@b-snapshot-results' },
  );
});

test('open fails when navigation returns no fresh DOM snapshot', async () => {
  const runtime = new NativeBrowserRuntime({
    appSessionId: 'app-session-one',
    browserSessionId: 'browser-one',
    viewport: { width: 900, height: 700, deviceScaleFactor: 2 },
    request: async (request) => ({
      requestId: request.requestId,
      appSessionId: request.appSessionId,
      browserSessionId: request.browserSessionId,
      ok: true,
    }),
  });

  await assert.rejects(
    runtime.open('https://example.com/'),
    /action completed without a fresh page snapshot/,
  );
});

test('open rejects an early about:blank snapshot instead of fabricating success', async () => {
  const runtime = new NativeBrowserRuntime({
    appSessionId: 'app-session-one',
    browserSessionId: 'browser-one',
    viewport: { width: 900, height: 700, deviceScaleFactor: 2 },
    request: async (request) => ({
      requestId: request.requestId,
      appSessionId: request.appSessionId,
      browserSessionId: request.browserSessionId,
      ok: true,
      snapshot: {
        url: 'about:blank',
        title: 'Stale renderer',
        scroll: { x: 80, y: 120 },
        refs: [],
      },
    }),
  });

  await assert.rejects(
    runtime.open('https://example.com/account'),
    /action completed without a fresh page snapshot/,
  );
});

test('reload rejects about:blank instead of reporting the last committed page as fresh', async () => {
  let action: BrowserNativeRequest['action'] = 'open';
  const runtime = new NativeBrowserRuntime({
    appSessionId: 'app-session-one',
    browserSessionId: 'browser-one',
    viewport: { width: 900, height: 700, deviceScaleFactor: 2 },
    request: async (request) => {
      action = request.action;
      return {
        requestId: request.requestId,
        appSessionId: request.appSessionId,
        browserSessionId: request.browserSessionId,
        ok: true,
        snapshot: {
          url: action === 'open' ? 'https://example.com/account' : 'about:blank',
          scroll: { x: 0, y: 0 },
          refs: [],
        },
      };
    },
  });

  await runtime.open('https://example.com/account');
  await assert.rejects(runtime.reload(), /invalid page snapshot/);
});

test('a second open cannot reuse metadata from the previous page', async () => {
  const runtime = new NativeBrowserRuntime({
    appSessionId: 'app-session-one',
    browserSessionId: 'browser-one',
    viewport: { width: 900, height: 700, deviceScaleFactor: 2 },
    request: async (request) => ({
      requestId: request.requestId,
      appSessionId: request.appSessionId,
      browserSessionId: request.browserSessionId,
      ok: true,
      snapshot:
        request.url === 'https://example.com/first'
          ? {
              url: request.url,
              title: 'First page',
              scroll: { x: 40, y: 80 },
              refs: [],
              canGoBack: true,
              canGoForward: true,
            }
          : undefined,
    }),
  });

  await runtime.open('https://example.com/first');
  await assert.rejects(
    runtime.open('https://example.com/second'),
    /action completed without a fresh page snapshot/,
  );
});

test('reload without a snapshot fails without reusing stale page metadata', async () => {
  const runtime = new NativeBrowserRuntime({
    appSessionId: 'app-session-one',
    browserSessionId: 'browser-one',
    viewport: { width: 900, height: 700, deviceScaleFactor: 2 },
    request: async (request) => ({
      requestId: request.requestId,
      appSessionId: request.appSessionId,
      browserSessionId: request.browserSessionId,
      ok: true,
      snapshot:
        request.action === 'open'
          ? {
              url: 'https://example.com/current',
              scroll: { x: 0, y: 0 },
              refs: [],
            }
          : undefined,
    }),
  });

  await runtime.open('https://example.com/current');
  await assert.rejects(runtime.reload(), /navigation completed without a fresh page snapshot/);
  await assert.rejects(runtime.snapshot(), /action completed without a fresh page snapshot/);
  await assert.rejects(runtime.fillCredentials(), /action completed without a fresh page snapshot/);
});

test('history navigation never reuses a stale page snapshot', async () => {
  const runtime = new NativeBrowserRuntime({
    appSessionId: 'app-session-one',
    browserSessionId: 'browser-one',
    viewport: { width: 900, height: 700, deviceScaleFactor: 2 },
    request: async (request) => ({
      requestId: request.requestId,
      appSessionId: request.appSessionId,
      browserSessionId: request.browserSessionId,
      ok: true,
      snapshot:
        request.action === 'open'
          ? {
              url: 'https://example.com/current',
              scroll: { x: 0, y: 0 },
              refs: [
                {
                  ref: '@b-current',
                  selector: '#current',
                  tagName: 'main',
                  box: { x: 0, y: 0, width: 100, height: 100 },
                },
              ],
            }
          : undefined,
    }),
  });

  await runtime.open('https://example.com/current');
  await assert.rejects(runtime.goBack(), /navigation completed without a fresh page snapshot/);
});

test('resize and diagnostic requests use dedicated native actions', async () => {
  const requests: BrowserNativeRequest[] = [];
  const runtime = new NativeBrowserRuntime({
    appSessionId: 'app-session-one',
    browserSessionId: 'browser-one',
    viewport: { width: 900, height: 700, deviceScaleFactor: 2 },
    request: async (request) => {
      requests.push(request);
      return {
        requestId: request.requestId,
        appSessionId: request.appSessionId,
        browserSessionId: request.browserSessionId,
        ok: true,
        inspection:
          request.action === 'inspect'
            ? {
                selector: '#frame',
                tagName: 'iframe',
                attributes: { src: 'https://video.example/embed' },
                box: { x: 0, y: 0, width: 640, height: 360 },
                html: '<iframe src="https://video.example/embed"></iframe>',
              }
            : undefined,
        networkEvents:
          request.action === 'network'
            ? [{ timestamp: 1, method: 'GET', url: 'https://example.com/api', status: 200 }]
            : undefined,
        consoleEvents:
          request.action === 'console'
            ? [{ timestamp: 2, level: 3, message: 'frame failed' }]
            : undefined,
      };
    },
  });

  await runtime.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  const inspection = await runtime.inspect('#frame');
  const network = await runtime.network(true);
  const consoleEvents = await runtime.console(true);

  assert.equal(inspection.tagName, 'iframe');
  assert.equal(network[0]?.status, 200);
  assert.equal(consoleEvents[0]?.message, 'frame failed');
  assert.deepEqual(
    requests.map((request) => request.action),
    ['resize', 'inspect', 'network', 'console'],
  );
  assert.equal(requests[2]?.clearNetworkLog, true);
  assert.equal(requests[3]?.clearConsoleLog, true);
});
