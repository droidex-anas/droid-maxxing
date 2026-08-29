import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PRE_ACTIVATION_MAX_BYTES,
  PRE_ACTIVATION_MAX_EVENTS,
  SessionPreActivationBuffer,
} from './sessionPreActivationBuffer.js';
import {
  serializedProviderEventBytes,
  type ProviderRuntimeEvent,
} from './providers/providerEvents.js';

function warning(index: number, message = `preactivation-${String(index)}`): ProviderRuntimeEvent {
  return {
    eventId: `evt-${String(index)}`,
    target: { kind: 'session', appSessionId: 'app-1' },
    providerDriverKind: 'droid',
    providerInstanceId: 'droid',
    runtimeGeneration: 1,
    createdAt: 1,
    type: 'warning',
    message,
  };
}

test('exact 512-event boundary activates and the 513th overflows', () => {
  const buffer = new SessionPreActivationBuffer();
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

test('byte bound uses serialized UTF-8 bytes and overflows at 1,048,576 + 1', () => {
  const buffer = new SessionPreActivationBuffer();
  const small = warning(0, 'é');
  assert.equal(buffer.tryPush(small), true);
  const remaining = PRE_ACTIVATION_MAX_BYTES - buffer.bytes;
  const over = warning(1, 'é'.repeat(Math.ceil((remaining + 1) / 2)));
  assert.ok(serializedProviderEventBytes(over) > remaining);
  assert.equal(buffer.tryPush(over), false);
  assert.equal(buffer.size, 1);
  assert.ok(buffer.bytes <= PRE_ACTIVATION_MAX_BYTES);
});

test('close-before-activation drain discards the buffer', () => {
  const buffer = new SessionPreActivationBuffer();
  assert.equal(buffer.tryPush(warning(0)), true);
  assert.equal(buffer.tryPush(warning(1)), true);
  assert.equal(buffer.drain().length, 2);
  assert.equal(buffer.size, 0);
  assert.equal(buffer.bytes, 0);
});
