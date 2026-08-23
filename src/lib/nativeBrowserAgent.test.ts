import assert from 'node:assert/strict';
import test from 'node:test';
import type { BrowserNativeRequest } from '../types/bridge';
import { performNativeBrowserRequest, registerNativeBrowserController } from './nativeBrowserAgent';

test('native browser requests run through Electron without a mounted Browser controller', async () => {
  const requests: unknown[] = [];
  const globals = globalThis as typeof globalThis & { window?: unknown };
  const previousWindow = globals.window;
  globals.window = {
    setTimeout,
    clearTimeout,
    droidControl: {
      nativeBrowserAgentAction: async (request: BrowserNativeRequest) => {
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
      },
    },
  };

  try {
    const result = await performNativeBrowserRequest({
      requestId: 'request-1',
      appSessionId: 'app-1',
      browserSessionId: 'browser-1',
      action: 'network',
    });

    assert.equal(requests.length, 1);
    assert.equal(result.ok, true);
    assert.equal(result.appSessionId, 'app-1');
    assert.equal(result.networkEvents?.[0]?.status, 200);
  } finally {
    if (previousWindow === undefined) delete globals.window;
    else globals.window = previousWindow;
  }
});

test('open waits briefly for a visible Browser controller to mount', async () => {
  const desktopRequests: unknown[] = [];
  const controllerRequests: unknown[] = [];
  const globals = globalThis as typeof globalThis & { window?: unknown };
  const previousWindow = globals.window;
  globals.window = {
    setTimeout,
    clearTimeout,
    droidControl: {
      nativeBrowserAgentAction: async (request: BrowserNativeRequest) => {
        desktopRequests.push(request);
        return { ...request, ok: true };
      },
    },
  };

  let unregister = () => {};
  try {
    setTimeout(() => {
      unregister = registerNativeBrowserController({
        perform: async (request) => {
          controllerRequests.push(request);
          return { requestId: request.requestId, appSessionId: request.appSessionId, ok: true };
        },
      });
    }, 0);

    const result = await performNativeBrowserRequest(
      {
        requestId: 'request-open',
        appSessionId: 'app-1',
        browserSessionId: 'browser-1',
        action: 'open',
        url: 'https://example.com',
      },
      { timeoutMs: 100 },
    );

    assert.equal(result.ok, true);
    assert.equal(controllerRequests.length, 1);
    assert.equal(desktopRequests.length, 0);
  } finally {
    unregister();
    if (previousWindow === undefined) delete globals.window;
    else globals.window = previousWindow;
  }
});

test('open falls back to Electron when no Browser controller mounts', async () => {
  const requests: unknown[] = [];
  const globals = globalThis as typeof globalThis & { window?: unknown };
  const previousWindow = globals.window;
  globals.window = {
    setTimeout,
    clearTimeout,
    droidControl: {
      nativeBrowserAgentAction: async (request: BrowserNativeRequest) => {
        requests.push(request);
        return { ...request, ok: true };
      },
    },
  };

  try {
    const result = await performNativeBrowserRequest(
      {
        requestId: 'request-open-fallback',
        appSessionId: 'app-1',
        browserSessionId: 'browser-1',
        action: 'open',
        url: 'https://example.com',
      },
      { timeoutMs: 1 },
    );

    assert.equal(result.ok, true);
    assert.equal(requests.length, 1);
  } finally {
    if (previousWindow === undefined) delete globals.window;
    else globals.window = previousWindow;
  }
});

test('main-process policy denial is preserved for visible browser execution', async () => {
  const controllerRequests: unknown[] = [];
  const desktopRequests: unknown[] = [];
  const globals = globalThis as typeof globalThis & { window?: unknown };
  const previousWindow = globals.window;
  globals.window = {
    setTimeout,
    clearTimeout,
    droidControl: {
      nativeBrowserAgentAction: async (request: BrowserNativeRequest) => {
        desktopRequests.push(request);
        throw new Error('Agent browser access is disabled in Settings > Browser.');
      },
    },
  };
  const unregister = registerNativeBrowserController({
    perform: async (request) => {
      controllerRequests.push(request);
      throw new Error('Agent browser access is disabled in Settings > Browser.');
    },
  });

  try {
    await assert.rejects(
      performNativeBrowserRequest({
        requestId: 'request-denied',
        appSessionId: 'app-1',
        browserSessionId: 'browser-1',
        action: 'snapshot',
      }),
      /disabled in Settings > Browser/,
    );
    assert.equal(controllerRequests.length, 1);
    assert.equal(desktopRequests.length, 0);
  } finally {
    unregister();
    if (previousWindow === undefined) delete globals.window;
    else globals.window = previousWindow;
  }
});

test('background requests bypass a mounted controller for a different visible chat', async () => {
  const controllerRequests: BrowserNativeRequest[] = [];
  const desktopRequests: BrowserNativeRequest[] = [];
  const globals = globalThis as typeof globalThis & { window?: unknown };
  const previousWindow = globals.window;
  globals.window = {
    setTimeout,
    clearTimeout,
    droidControl: {
      nativeBrowserAgentAction: async (request: BrowserNativeRequest) => {
        desktopRequests.push(request);
        return { ...request, ok: true };
      },
    },
  };
  const unregister = registerNativeBrowserController({
    perform: async (request) => {
      controllerRequests.push(request);
      return { ...request, ok: true };
    },
  });

  try {
    const request: BrowserNativeRequest = {
      requestId: 'background-request',
      appSessionId: 'background-chat',
      browserSessionId: 'background-browser',
      action: 'snapshot',
    };
    const result = await performNativeBrowserRequest(request, { surface: 'background' });

    assert.equal(result.ok, true);
    assert.deepEqual(desktopRequests, [request]);
    assert.deepEqual(controllerRequests, []);
  } finally {
    unregister();
    if (previousWindow === undefined) delete globals.window;
    else globals.window = previousWindow;
  }
});
