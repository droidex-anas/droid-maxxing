import assert from 'node:assert/strict';
import test from 'node:test';

import { SessionBrowser, type SessionBrowsers } from './SessionBrowser.js';
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

test('a design prompt waits for the reference command that arrived before it', async () => {
  const events: ServerEvent[] = [];
  const order: string[] = [];
  const storedIds: string[] = [];
  let releaseAddReference!: () => void;
  const addReferenceStarted = new Promise<void>((resolve) => {
    releaseAddReference = resolve;
  });
  const browsers = {
    async addReference(_appSessionId: string, input: { id?: string }) {
      await addReferenceStarted;
      if (input.id) storedIds.push(input.id);
      order.push('addReference');
      return {} as never;
    },
    async designPrompt(input: { referenceIds: string[] }) {
      order.push('designPrompt');
      const missing = input.referenceIds.filter((id) => !storedIds.includes(id));
      if (missing.length > 0) throw new Error(`Unknown design reference ${missing.join(', ')}.`);
      return { path: '/tmp/pack.md', prompt: 'design prompt' };
    },
  } as unknown as SessionBrowsers;
  const browser = new SessionBrowser({
    browsers,
    emit: (event) => events.push(event),
    getAutonomy: () => undefined,
    sendPrompt: () => Promise.resolve(),
  });

  const added = browser.handle({
    type: 'browser.design.addReference',
    appSessionId: 'app-1',
    reference: { id: '@ref-1', anchor: { id: '@ref-1', kind: 'element', label: 'Save' } },
  } as never);
  const prompted = browser.handle({
    type: 'browser.design.sendPrompt',
    appSessionId: 'app-1',
    instruction: 'Make it blue',
    referenceIds: ['@ref-1'],
  } as never);
  releaseAddReference();
  await Promise.all([added, prompted]);

  assert.deepEqual(order, ['addReference', 'designPrompt']);
  assert.deepEqual(
    events.filter((event) => event.type === 'browser.error'),
    [],
  );
});

test('a rejected design action is reported without rejecting or blocking the queue', async (t) => {
  const events: ServerEvent[] = [];
  const prompts: string[] = [];
  const browsers = new FakeBrowserSessionManager(() => undefined);
  t.mock.method(browsers, 'designPrompt', async () => ({
    path: '/tmp/pack.md',
    prompt: 'design prompt',
  }));
  const browser = new SessionBrowser({
    browsers,
    emit: (event) => events.push(event),
    getAutonomy: () => undefined,
    sendPrompt: async (_appSessionId, prompt) => {
      prompts.push(prompt);
    },
  });

  const added = browser.handle({
    type: 'browser.design.addReference',
    appSessionId: 'app-1',
    reference: {
      id: '@ref-1',
      anchor: {
        id: '@ref-1',
        kind: 'element',
        label: 'Save',
        box: { x: 0, y: 0, width: 10, height: 10 },
      },
      url: 'https://example.test',
      viewport: { width: 1200, height: 800, deviceScaleFactor: 1 },
      scroll: { x: 0, y: 0 },
      createdAt: '2026-01-01T00:00:00.000Z',
    },
  });
  const prompted = browser.handle({
    type: 'browser.design.sendPrompt',
    appSessionId: 'app-1',
    instruction: 'Make it blue',
    referenceIds: ['@ref-1'],
  });
  await Promise.all([added, prompted]);

  assert.deepEqual(events, [
    {
      type: 'browser.error',
      appSessionId: 'app-1',
      message: 'FakeBrowserSessionManager does not implement addReference.',
    },
    {
      type: 'error',
      code: 'browser.error',
      appSessionId: 'app-1',
      message: 'FakeBrowserSessionManager does not implement addReference.',
    },
  ]);
  assert.deepEqual(prompts, ['design prompt']);
});
