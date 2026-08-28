import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applySidecarStatus,
  canRunAgents,
  getRuntimeHealth,
  resetRuntimeHealthForTests,
  setTransportHealth,
  subscribeRuntimeHealth,
} from './runtimeHealth';

function replaceGlobal(name: string, value: unknown): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  return () => {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  };
}

test('agents cannot run while the transport is down after a prior connection', () => {
  applySidecarStatus({
    lifecycle: 'healthy',
    processAlive: true,
    bridgeResponsive: true,
    lastHeartbeatAt: 1,
    restartCount: 0,
  });
  setTransportHealth('connected');
  assert.equal(getRuntimeHealth().transport, 'connected');
  assert.equal(canRunAgents(), true);
  const seen: boolean[] = [];
  const stop = subscribeRuntimeHealth(() => {
    seen.push(canRunAgents());
  });
  setTransportHealth('disconnected');
  stop();
  assert.equal(canRunAgents(), false);
  assert.deepEqual(seen, [false]);
});

test('rejected sidecar status falls back without an unhandled rejection', async () => {
  resetRuntimeHealthForTests();
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  const restoreWindow = replaceGlobal('window', {
    droidControl: {
      sidecarStatus: async () => {
        throw new Error('sidecar restart in progress');
      },
      onSidecarStatus: () => () => undefined,
    },
  });
  try {
    await new Promise<void>((resolve) => {
      const stop = subscribeRuntimeHealth(() => {
        if (getRuntimeHealth().lifecycle === 'recovery-required') {
          stop();
          resolve();
        }
      });
    });
    assert.equal(unhandled.length, 0);
    const health = getRuntimeHealth();
    assert.equal(health.lifecycle, 'recovery-required');
    assert.equal(health.processAlive, false);
    assert.equal(health.bridgeResponsive, false);
    assert.match(health.reason ?? '', /sidecar restart in progress/);
  } finally {
    process.off('unhandledRejection', onUnhandled);
    restoreWindow();
    resetRuntimeHealthForTests();
  }
});
