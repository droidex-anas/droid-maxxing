import assert from 'node:assert/strict';
import test from 'node:test';
import type { BrowserNativeRequest } from '../types/bridge';
import { performNativeBrowserRequest, registerNativeBrowserController } from './nativeBrowserAgent';

interface FakeTimer {
  active: boolean;
  callback: () => void;
  delayMs: number;
}

function fakeBrowserWindow(
  nativeBrowserAgentAction?: (request: BrowserNativeRequest) => Promise<unknown>,
) {
  const timers: FakeTimer[] = [];
  const value: Record<string, unknown> = {
    setTimeout: (callback: () => void, delayMs: number) => {
      timers.push({ active: true, callback, delayMs });
      return timers.length;
    },
    clearTimeout: (timer: number) => {
      const record = timers[timer - 1];
      if (record) record.active = false;
    },
  };
  if (nativeBrowserAgentAction) value.droidControl = { nativeBrowserAgentAction };
  return { timers, value };
}

async function withBrowserWindow(run: () => Promise<void>, value: unknown): Promise<void> {
  const globals = globalThis as typeof globalThis & { window?: unknown };
  const previousWindow = globals.window;
  globals.window = value;
  try {
    await run();
  } finally {
    if (previousWindow === undefined) delete globals.window;
    else globals.window = previousWindow;
  }
}

test('desktop browser requests use Electron immediately without a mounted surface', async () => {
  const requests: BrowserNativeRequest[] = [];
  const fake = fakeBrowserWindow(async (request) => {
    requests.push(request);
    return {
      requestId: request.requestId,
      appSessionId: request.appSessionId,
      browserSessionId: request.browserSessionId,
      ok: true,
      networkEvents: [
        {
          timestamp: 1,
          method: 'GET',
          url: 'https://example.com/api',
          status: 200,
        },
      ],
    };
  });

  await withBrowserWindow(async () => {
    const result = await performNativeBrowserRequest({
      requestId: 'request-1',
      appSessionId: 'app-1',
      browserSessionId: 'browser-1',
      action: 'network',
    });

    assert.equal(result.ok, true);
    assert.equal(result.networkEvents?.[0]?.status, 200);
    assert.equal(fake.timers.length, 1);
    assert.equal(fake.timers[0]?.delayMs, 10_000);
    assert.equal(fake.timers[0]?.active, false);
    assert.equal(requests.length, 1);
  }, fake.value);
});

test('desktop requests bypass a mounted renderer controller', async () => {
  const desktopRequests: BrowserNativeRequest[] = [];
  const controllerRequests: BrowserNativeRequest[] = [];
  const fake = fakeBrowserWindow(async (request) => {
    desktopRequests.push(request);
    return { ...request, ok: true };
  });
  const unregister = registerNativeBrowserController({
    perform: async (request) => {
      controllerRequests.push(request);
      return { ...request, ok: true };
    },
  });

  try {
    await withBrowserWindow(async () => {
      const request: BrowserNativeRequest = {
        requestId: 'desktop-request',
        appSessionId: 'app-1',
        browserSessionId: 'browser-1',
        action: 'snapshot',
      };
      const result = await performNativeBrowserRequest(request);

      assert.equal(result.ok, true);
      assert.deepEqual(desktopRequests, [request]);
      assert.deepEqual(controllerRequests, []);
    }, fake.value);
  } finally {
    unregister();
  }
});

test('iframe requests wait deterministically for their renderer controller', async () => {
  const controllerRequests: BrowserNativeRequest[] = [];
  const fake = fakeBrowserWindow();
  let unregister = () => {};

  try {
    await withBrowserWindow(async () => {
      const request: BrowserNativeRequest = {
        requestId: 'iframe-request',
        appSessionId: 'app-1',
        browserSessionId: 'browser-1',
        action: 'snapshot',
      };
      const pending = performNativeBrowserRequest(request, { timeoutMs: 100 });
      unregister = registerNativeBrowserController({
        perform: async (received) => {
          controllerRequests.push(received);
          return { ...received, ok: true };
        },
      });

      const result = await pending;
      assert.equal(result.ok, true);
      assert.deepEqual(controllerRequests, [request]);
      assert.equal(fake.timers[0]?.active, false);
    }, fake.value);
  } finally {
    unregister();
  }
});

test('background requests never target a mounted renderer controller', async () => {
  const controllerRequests: BrowserNativeRequest[] = [];
  const fake = fakeBrowserWindow();
  const unregister = registerNativeBrowserController({
    perform: async (request) => {
      controllerRequests.push(request);
      return { ...request, ok: true };
    },
  });

  try {
    await withBrowserWindow(async () => {
      const result = await performNativeBrowserRequest(
        {
          requestId: 'background-request',
          appSessionId: 'background-chat',
          browserSessionId: 'background-browser',
          action: 'snapshot',
        },
        { surface: 'background' },
      );

      assert.equal(result.ok, false);
      assert.match(result.error ?? '', /native browser is only available/i);
      assert.deepEqual(controllerRequests, []);
    }, fake.value);
  } finally {
    unregister();
  }
});

test('desktop policy failures remain visible in the browser result', async () => {
  const fake = fakeBrowserWindow(async () => {
    throw new Error('Agent browser access is disabled in Settings > Browser.');
  });

  await withBrowserWindow(async () => {
    const result = await performNativeBrowserRequest({
      requestId: 'request-denied',
      appSessionId: 'app-1',
      browserSessionId: 'browser-1',
      action: 'snapshot',
    });

    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /disabled in Settings > Browser/);
  }, fake.value);
});
