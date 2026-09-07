const assert = require('node:assert/strict');
const test = require('node:test');
const { registerBrowserRendererIpc } = require('./browserRendererIpc.cjs');

function harness() {
  const handlers = new Map();
  const authorized = [];
  const calls = [];
  const methodOwner = (owner) =>
    new Proxy(
      {},
      {
        get:
          (_target, method) =>
          (...args) => {
            calls.push({ owner, method, args });
            if (owner === 'settings' && method === 'validateRequest') return args[0]?.action;
            return { owner, method };
          },
      },
    );
  const browserSettings = methodOwner('settings');
  const browserPrompts = methodOwner('prompts');
  const nativeBrowser = methodOwner('native');

  registerBrowserRendererIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    assertMainRenderer: (event) => authorized.push(event),
    browserSettings,
    browserPrompts,
    nativeBrowser,
  });
  return { authorized, browserSettings, calls, handlers };
}

test('every DROIDEX browser renderer command authenticates the main frame', async () => {
  const { authorized, handlers } = harness();
  const event = { sender: 'renderer' };

  for (const [channel, handler] of handlers) {
    const payload =
      channel === 'native-browser-agent-action'
        ? {
            request: {
              source: 'user',
              action: 'open',
              appSessionId: 'app-1',
              browserSessionId: 'browser-1',
            },
          }
        : {};
    await handler(event, payload);
  }

  assert.equal(handlers.size, 21);
  assert.equal(authorized.length, handlers.size);
  assert.ok(authorized.every((authorizedEvent) => authorizedEvent === event));
});

test('agent action validation precedes native browser admission', async () => {
  const { calls, handlers } = harness();
  const request = {
    requestId: 'request-1',
    appSessionId: 'app-1',
    browserSessionId: 'browser-1',
    source: 'agent',
    action: 'click',
  };

  const result = await handlers.get('native-browser-agent-action')({}, { request, bounds: {} });

  assert.deepEqual(calls.slice(0, 2), [
    { owner: 'settings', method: 'validateRequest', args: [request] },
    { owner: 'native', method: 'runAgentAction', args: [request] },
  ]);
  assert.deepEqual(result, {
    owner: 'native',
    method: 'runAgentAction',
    appSessionId: 'app-1',
    browserSessionId: 'browser-1',
  });
});

test('browser presentation carries run state without changing navigation authorization', async () => {
  const { calls, handlers } = harness();
  await handlers.get('native-browser-visible')(
    {},
    {
      browserSessionId: 'browser-1',
      visible: true,
      agentCursorActive: false,
    },
  );
  assert.deepEqual(calls, [
    { owner: 'native', method: 'setVisible', args: ['browser-1', true, false] },
  ]);
});

test('physical user navigation does not invoke agent origin authorization', async () => {
  const { calls, handlers } = harness();
  const request = {
    requestId: 'request-2',
    appSessionId: 'app-1',
    browserSessionId: 'browser-1',
    source: 'user',
    action: 'open',
  };

  await handlers.get('native-browser-agent-action')({}, { request });

  assert.deepEqual(calls, [
    { owner: 'settings', method: 'validateRequest', args: [request] },
    { owner: 'native', method: 'runAgentAction', args: [request] },
  ]);
});

test('renderer input cannot label agent pointer actions as direct user navigation', async () => {
  const { handlers } = harness();
  const request = {
    requestId: 'request-3',
    appSessionId: 'app-1',
    browserSessionId: 'browser-1',
    source: 'user',
    action: 'click',
  };

  await assert.rejects(
    handlers.get('native-browser-agent-action')({}, { request }),
    /cannot claim direct user navigation/,
  );
});
