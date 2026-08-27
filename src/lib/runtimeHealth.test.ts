import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applySidecarStatus,
  canRunAgents,
  getRuntimeHealth,
  setTransportHealth,
  subscribeRuntimeHealth,
} from './runtimeHealth';

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
