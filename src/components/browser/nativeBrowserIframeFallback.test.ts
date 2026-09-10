import assert from 'node:assert/strict';
import test from 'node:test';
import { performIframeRequest } from './nativeBrowserIframeFallback';

test('iframe navigation errors and timeouts fail without publishing a loaded URL', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { setTimeout, clearTimeout },
  });
  t.after(() => {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  });
  for (const failure of ['error', 'timeout', 'disconnected']) {
    const listeners = new Map<string, EventListener>();
    const frame = {
      isConnected: failure !== 'disconnected',
      src: '',
      addEventListener: (name: string, listener: EventListener) => listeners.set(name, listener),
      removeEventListener: (name: string) => listeners.delete(name),
    } as unknown as HTMLIFrameElement;
    const result = performIframeRequest(
      {
        requestId: 'request',
        appSessionId: 'chat',
        browserSessionId: 'browser',
        action: 'open',
        url: 'https://example.test/',
      },
      {
        currentUrl: 'about:blank',
        iframe: { current: frame },
        onLoaded: () => assert.fail('failed navigation must not report success'),
      },
    );
    if (failure === 'error') listeners.get('error')?.(new Event('error'));
    if (failure === 'timeout') t.mock.timers.tick(5_000);
    const response = await result;
    assert.equal(response.ok, false);
    assert.match(response.error ?? '', /failed|timed out|disconnected/);
    assert.equal(response.snapshot, undefined);
    assert.equal(listeners.size, 0);
  }
});
