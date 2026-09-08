import assert from 'node:assert/strict';
import test from 'node:test';

import { SessionBrowser } from './SessionBrowser.js';
import type { ServerEvent } from './protocol.js';
import { FakeBrowserSessionManager } from './testing/browserCharacterizationSupport.js';

test('restore reports a missing chat identity through browser error events', async () => {
  const events: ServerEvent[] = [];
  const browser = new SessionBrowser({
    browsers: new FakeBrowserSessionManager(() => undefined),
    emit: (event) => events.push(event),
    getAutonomy: () => undefined,
    sendPrompt: () => Promise.resolve(),
  });
  await browser.handle({
    type: 'browser.restore',
    state: {
      browserSessionId: 'browser-1',
      appSessionId: '',
      url: 'https://example.test',
      viewport: { width: 1200, height: 800, deviceScaleFactor: 1 },
      viewportMode: 'fit',
      scroll: { x: 0, y: 0 },
    },
  });
  assert.deepEqual(
    events.map((event) => event.type),
    ['browser.error', 'error'],
  );

  events.length = 0;
  await browser.handle({ type: 'browser.restore' } as never);
  assert.deepEqual(
    events.map((event) => event.type),
    ['browser.error', 'error'],
  );
});

test('shutdown rejects pending native browser work and blocks future requests', async () => {
  const events: ServerEvent[] = [];
  const sessionBrowser = new SessionBrowser({
    browsers: new FakeBrowserSessionManager(() => undefined),
    emit: (event) => events.push(event),
    getAutonomy: () => 'high',
    sendPrompt: () => Promise.resolve(),
  });
  const runtime = sessionBrowser.createRuntime(
    'browser-1',
    { width: 1200, height: 800, deviceScaleFactor: 2 },
    'app-1',
  );

  const pending = runtime.snapshot();
  const pendingRejection = assert.rejects(
    pending,
    /DROIDEX browser stopped before the action completed/,
  );
  const nativeRequest = events.find(
    (event): event is Extract<ServerEvent, { type: 'browser.native.request' }> =>
      event.type === 'browser.native.request',
  )?.request;
  assert.ok(nativeRequest);
  assert.equal(nativeRequest.autonomy, 'high');

  sessionBrowser.shutdown();
  sessionBrowser.shutdown();
  await pendingRejection;

  const lateResult = sessionBrowser.handle({
    type: 'browser.native.result',
    result: { ...nativeRequest, ok: true },
  });
  assert.notEqual(lateResult, false);
  await lateResult;
  await assert.rejects(runtime.snapshot(), /DROIDEX browser stopped before the action completed/);
});
