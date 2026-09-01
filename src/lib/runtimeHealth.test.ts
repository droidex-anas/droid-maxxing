import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';

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

const HEALTHY = {
  lifecycle: 'healthy' as const,
  processAlive: true,
  bridgeResponsive: true,
  lastHeartbeatAt: 1,
  restartCount: 0,
};

beforeEach(() => {
  resetRuntimeHealthForTests();
});

afterEach(() => {
  resetRuntimeHealthForTests();
});

test('browser and Vite keep send available when no sidecar supervisor exists', () => {
  assert.equal(getRuntimeHealth().lifecycle, 'starting');
  assert.equal(getRuntimeHealth().transport, 'disconnected');
  assert.equal(canRunAgents(), true);

  const restoreWindow = replaceGlobal('window', {});
  try {
    assert.equal(canRunAgents(), true);
  } finally {
    restoreWindow();
  }
});

test('a window without sidecarStatus is still unsupervised', () => {
  const restoreWindow = replaceGlobal('window', {
    droidControl: {
      bridgeInfo: async () => ({ port: 1, token: '' }),
    },
  });
  try {
    assert.equal(canRunAgents(), true);
  } finally {
    restoreWindow();
  }
});

test('Electron with a sidecar supervisor blocks send until the runtime is healthy', () => {
  const restoreWindow = replaceGlobal('window', {
    droidControl: {
      sidecarStatus: async () => HEALTHY,
      onSidecarStatus: () => () => undefined,
    },
  });
  try {
    assert.equal(canRunAgents(), false);
    applySidecarStatus(HEALTHY);
    assert.equal(canRunAgents(), false);
    setTransportHealth('connected');
    assert.equal(canRunAgents(), true);
  } finally {
    restoreWindow();
  }
});

test('agents cannot run while the transport is down after a prior connection', () => {
  applySidecarStatus(HEALTHY);
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

test('degraded sidecar still allows send while the transport is up', () => {
  applySidecarStatus({
    ...HEALTHY,
    lifecycle: 'degraded',
    reason: 'heartbeat stale',
  });
  setTransportHealth('connected');
  assert.equal(canRunAgents(), true);
  applySidecarStatus({
    lifecycle: 'restarting',
    processAlive: false,
    bridgeResponsive: false,
    lastHeartbeatAt: 1,
    restartCount: 1,
  });
  assert.equal(canRunAgents(), false);
});

test('rejected sidecar status falls back without an unhandled rejection', async () => {
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
    assert.equal(canRunAgents(), false);
  } finally {
    process.off('unhandledRejection', onUnhandled);
    restoreWindow();
  }
});
