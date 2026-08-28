import assert from 'node:assert/strict';
import test from 'node:test';

import { PRE_ACTIVATION_MAX_EVENTS } from '../providerTypes.js';
import type { ProviderRuntimeEvent } from '../providerEvents.js';
import { AcpPreActivationBuffer } from './acpPreActivation.js';

function warning(index: number): ProviderRuntimeEvent {
  return {
    eventId: `evt-${String(index)}`,
    target: { kind: 'session', appSessionId: 'app-1' },
    providerDriverKind: 'grok',
    providerInstanceId: 'grok',
    runtimeGeneration: 1,
    createdAt: 1,
    type: 'warning',
    message: `preactivation-${String(index)}`,
  };
}

test('pre-activation buffer stores events until drain and rejects the overflowing push', () => {
  const buffer = new AcpPreActivationBuffer();
  for (let index = 0; index < PRE_ACTIVATION_MAX_EVENTS; index += 1) {
    assert.equal(buffer.tryPush(warning(index)), true);
  }
  assert.equal(buffer.size, PRE_ACTIVATION_MAX_EVENTS);
  assert.equal(buffer.tryPush(warning(PRE_ACTIVATION_MAX_EVENTS)), false);
  assert.equal(buffer.size, PRE_ACTIVATION_MAX_EVENTS);
  const drained = buffer.drain();
  assert.equal(drained.length, PRE_ACTIVATION_MAX_EVENTS);
  assert.equal(buffer.size, 0);
});
