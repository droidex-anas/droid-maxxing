import assert from 'node:assert/strict';
import test from 'node:test';

import type { ServerEvent } from './protocol.js';
import {
  nativeSnapshot,
  nativeSuccess,
  observeNativeBrowserTimeouts,
} from './testing/browserCharacterizationSupport.js';
import { FakeFactorySession } from './testing/fakeFactoryRuntime.js';
import {
  createNativeBrowserTestContext,
  createSessionManagerTestContext,
} from './testing/sessionManagerTestContext.js';

type NativeBrowserRequestEvent = Extract<ServerEvent, { type: 'browser.native.request' }>;

function nativeRequests(events: ServerEvent[]): NativeBrowserRequestEvent[] {
  return events.filter(
    (event): event is NativeBrowserRequestEvent => event.type === 'browser.native.request',
  );
}

test('[B1] Browser command routing', { concurrency: false }, async () => {
  const h = createSessionManagerTestContext();
  const viewport = { width: 1024, height: 768, deviceScaleFactor: 1 };
  const resizedViewport = { width: 1280, height: 720, deviceScaleFactor: 2 };

  try {
    await h.handle({
      type: 'browser.open',
      appSessionId: 'app-b1',
      url: 'https://example.test',
      source: 'user',
      viewport,
      viewportMode: 'custom',
    });

    assert.deepEqual(h.browsers.calls.at(-1), {
      target: 'browser',
      method: 'open',
      args: [
        {
          type: 'browser.open',
          appSessionId: 'app-b1',
          url: 'https://example.test',
          source: 'user',
          viewport,
          viewportMode: 'custom',
        },
      ],
    });
    assert.deepEqual(h.events.at(-1), {
      type: 'browser.updated',
      state: {
        browserSessionId: 'browser-app-b1',
        appSessionId: 'app-b1',
        url: 'https://example.test',
        viewport,
        viewportMode: 'custom',
        scroll: { x: 0, y: 0 },
        refs: [],
      },
    });

    await h.handle({
      type: 'browser.open',
      appSessionId: 'app-b1',
      url: 'https://example.test/reopened-viewport',
      viewport: resizedViewport,
    });

    assert.deepEqual(h.events.at(-1), {
      type: 'browser.updated',
      state: {
        browserSessionId: 'browser-app-b1',
        appSessionId: 'app-b1',
        url: 'https://example.test/reopened-viewport',
        viewport: resizedViewport,
        viewportMode: 'custom',
        scroll: { x: 0, y: 0 },
        refs: [],
      },
    });

    await h.handle({
      type: 'browser.open',
      appSessionId: 'app-b1',
      url: 'https://example.test/reopened-mode',
      viewportMode: 'mobile',
    });

    assert.deepEqual(h.events.at(-1), {
      type: 'browser.updated',
      state: {
        browserSessionId: 'browser-app-b1',
        appSessionId: 'app-b1',
        url: 'https://example.test/reopened-mode',
        viewport: resizedViewport,
        viewportMode: 'mobile',
        scroll: { x: 0, y: 0 },
        refs: [],
      },
    });

    await h.handle({
      type: 'browser.open',
      appSessionId: 'app-b1',
      url: 'https://example.test/reopened',
    });

    assert.deepEqual(h.events.at(-1), {
      type: 'browser.updated',
      state: {
        browserSessionId: 'browser-app-b1',
        appSessionId: 'app-b1',
        url: 'https://example.test/reopened',
        viewport: resizedViewport,
        viewportMode: 'mobile',
        scroll: { x: 0, y: 0 },
        refs: [],
      },
    });

    await h.handle({
      type: 'browser.open',
      appSessionId: 'app-b1-default',
      url: 'https://example.test/default',
    });

    assert.deepEqual(h.events.at(-1), {
      type: 'browser.updated',
      state: {
        browserSessionId: 'browser-app-b1-default',
        appSessionId: 'app-b1-default',
        url: 'https://example.test/default',
        viewport: { width: 1200, height: 800, deviceScaleFactor: 2 },
        viewportMode: 'fit',
        scroll: { x: 0, y: 0 },
        refs: [],
      },
    });

    await h.handle({ type: 'browser.reload', appSessionId: 'missing' });

    assert.equal(
      h.events.some(
        (event) =>
          event.type === 'browser.error' &&
          event.appSessionId === 'missing' &&
          event.message === 'Browser session is not open yet.',
      ),
      true,
    );

    await h.handle({
      type: 'browser.restore',
      state: {
        browserSessionId: 'browser-restored',
        appSessionId: 'app-restored',
        url: 'https://restored.example.test',
        viewport,
        viewportMode: 'custom',
        scroll: { x: 0, y: 18 },
      },
    });
    assert.deepEqual(h.browsers.calls.at(-1), {
      target: 'browser',
      method: 'restore',
      args: [
        {
          browserSessionId: 'browser-restored',
          appSessionId: 'app-restored',
          url: 'https://restored.example.test',
          viewport,
          viewportMode: 'custom',
          scroll: { x: 0, y: 18 },
        },
      ],
    });
  } finally {
    await h.dispose();
  }
});

test('[B2] Native request and result correlation', { concurrency: false }, async () => {
  const timeouts = observeNativeBrowserTimeouts();
  const h = createNativeBrowserTestContext();

  try {
    let opened = false;
    const open = h.handle({
      type: 'browser.open',
      appSessionId: 'app-b2',
      url: 'https://example.test',
    });
    void open.then(() => {
      opened = true;
    });
    await Promise.resolve();
    const request = nativeRequests(h.events).at(-1)?.request;
    assert.ok(request);
    assert.match(
      request.requestId,
      /^browser-native-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    assert.ok(
      (timeouts.currentDelay() ?? 0) > 120_000,
      'approval-capable navigation must outlive the app permission prompt',
    );

    await h.handle({
      type: 'browser.native.result',
      result: {
        requestId: 'unknown',
        appSessionId: 'app-b2',
        browserSessionId: 'browser-b2',
        ok: true,
      },
    });
    assert.equal(opened, false);

    await h.handle({
      type: 'browser.native.result',
      result: {
        ...nativeSuccess(request, nativeSnapshot('https://wrong-chat.example.test')),
        appSessionId: 'wrong-app-session',
      },
    });
    assert.equal(opened, false);

    await h.handle({
      type: 'browser.native.result',
      result: {
        ...nativeSuccess(request, nativeSnapshot('https://replacement.example.test')),
        browserSessionId: 'replacement-browser-session',
      },
    });
    assert.equal(opened, false);

    await h.handle({
      type: 'browser.native.result',
      result: nativeSuccess(request, nativeSnapshot('https://example.test')),
    });
    await open;
    assert.equal(opened, true);
    assert.equal(
      h.events.some(
        (event) =>
          event.type === 'browser.updated' &&
          event.state.appSessionId === 'app-b2' &&
          event.state.url === 'https://example.test',
      ),
      true,
    );

    const reload = h.handle({ type: 'browser.reload', appSessionId: 'app-b2' });
    await Promise.resolve();
    const timedOutRequest = nativeRequests(h.events).at(-1)?.request;
    assert.ok(timedOutRequest);
    assert.ok(
      (timeouts.currentDelay() ?? Number.POSITIVE_INFINITY) < 60_000,
      'non-interactive reload must fail promptly instead of waiting for an approval window',
    );
    timeouts.fireCurrent();
    await reload;
    assert.equal(
      h.events.some(
        (event) =>
          event.type === 'browser.error' &&
          event.appSessionId === 'app-b2' &&
          /DROIDEX browser did not respond to reload within \d+ms\./.test(event.message),
      ),
      true,
    );

    const eventCountBeforeLateResult = h.events.length;
    await h.handle({
      type: 'browser.native.result',
      result: nativeSuccess(timedOutRequest, nativeSnapshot('https://example.test/reloaded')),
    });
    assert.equal(h.events.length, eventCountBeforeLateResult);

    const close = h.handle({ type: 'browser.close', appSessionId: 'app-b2' });
    await Promise.resolve();
    const closeRequest = nativeRequests(h.events).at(-1)?.request;
    assert.ok(closeRequest);
    await h.handle({ type: 'browser.native.result', result: nativeSuccess(closeRequest) });
    await close;
  } finally {
    await h.dispose();
    timeouts.restore();
  }
});

test(
  'closing a native browser invalidates its pending action',
  { concurrency: false },
  async () => {
    const h = createNativeBrowserTestContext();

    try {
      const open = h.handle({
        type: 'browser.open',
        appSessionId: 'app-close-race',
        url: 'https://example.test',
      });
      await Promise.resolve();
      const openRequest = nativeRequests(h.events).at(-1)?.request;
      assert.ok(openRequest);
      await h.handle({
        type: 'browser.native.result',
        result: nativeSuccess(openRequest, nativeSnapshot('https://example.test')),
      });
      await open;

      const reload = h.handle({ type: 'browser.reload', appSessionId: 'app-close-race' });
      await Promise.resolve();
      const reloadRequest = nativeRequests(h.events).at(-1)?.request;
      assert.ok(reloadRequest);

      const close = h.handle({ type: 'browser.close', appSessionId: 'app-close-race' });
      await Promise.resolve();
      await reload;
      const closeRequest = nativeRequests(h.events).at(-1)?.request;
      assert.ok(closeRequest);
      assert.equal(closeRequest.action, 'close');
      assert.equal(
        h.events.some(
          (event) =>
            event.type === 'browser.error' &&
            event.appSessionId === 'app-close-race' &&
            event.message === 'Browser session closed before the action completed.',
        ),
        true,
      );

      const eventCountBeforeLateResult = h.events.length;
      await h.handle({
        type: 'browser.native.result',
        result: nativeSuccess(reloadRequest, nativeSnapshot('https://example.test/stale')),
      });
      assert.equal(h.events.length, eventCountBeforeLateResult);

      await h.handle({ type: 'browser.native.result', result: nativeSuccess(closeRequest) });
      await close;
    } finally {
      await h.dispose();
    }
  },
);

test('[B3] Browser continuity across compaction', { concurrency: false }, async () => {
  const h = createSessionManagerTestContext();
  const appSessionId = 'provider-1';

  try {
    await h.create({
      sessionPurpose: 'chat',
      clientRef: 'b3',
      title: 'Browser continuity',
      goal: 'go',
      interactionMode: 'auto',
      autonomy: 'low',
    });
    await h.waitForIdle();
    h.provider.session(appSessionId).nextCompactResult = {
      newSessionId: 'provider-2',
      removedCount: 1,
    };
    h.runtime.loadQueue.set('provider-2', [new FakeFactorySession('provider-2', {}, h.calls)]);

    await h.handle({
      type: 'browser.open',
      appSessionId: appSessionId,
      url: 'https://example.test',
    });
    await h.handle({ type: 'session.compact', appSessionId: appSessionId });
    const browserUpdatesBeforeReload = h.events.filter((event) => event.type === 'browser.updated');
    await h.handle({ type: 'browser.reload', appSessionId: appSessionId });

    assert.deepEqual(
      h.browsers.calls
        .filter((call) => call.target === 'browser')
        .map((call) => [call.method, call.args[0]]),
      [
        ['open', { type: 'browser.open', appSessionId: appSessionId, url: 'https://example.test' }],
        ['reload', appSessionId],
      ],
    );
    assert.equal(
      h.events.some(
        (event) =>
          event.type === 'session.updated' &&
          event.session.appSessionId === appSessionId &&
          event.session.providerSessionId === 'provider-2',
      ),
      true,
    );
    const browserUpdates = h.events.filter(
      (event): event is Extract<ServerEvent, { type: 'browser.updated' }> =>
        event.type === 'browser.updated',
    );
    assert.equal(browserUpdates.length > browserUpdatesBeforeReload.length, true);
    assert.equal(browserUpdates.at(-1)?.state.appSessionId, appSessionId);

    await h.handle({ type: 'session.close', appSessionId: appSessionId });
    assert.equal(
      h.calls.filter(
        (call) =>
          call.target === 'cleanup' &&
          call.method === 'browser.close' &&
          call.args[0] === appSessionId,
      ).length,
      1,
    );
  } finally {
    await h.dispose();
  }

  const shutdown = createSessionManagerTestContext();
  let shutdownDisposed = false;
  try {
    await shutdown.create({
      sessionPurpose: 'chat',
      clientRef: 'b3-shutdown',
      title: 'Browser shutdown',
      goal: 'go',
      interactionMode: 'auto',
      autonomy: 'low',
    });
    await shutdown.handle({
      type: 'browser.open',
      appSessionId: 'provider-1',
      url: 'https://example.test/shutdown',
    });
    await shutdown.dispose();
    shutdownDisposed = true;
    assert.equal(
      shutdown.calls.filter(
        (call) =>
          call.target === 'cleanup' &&
          call.method === 'browser.close' &&
          call.args[0] === 'provider-1',
      ).length,
      1,
    );
  } finally {
    if (!shutdownDisposed) await shutdown.dispose();
  }
});
