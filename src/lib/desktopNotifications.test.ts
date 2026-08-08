import test from 'node:test';
import assert from 'node:assert/strict';
import { notify } from './desktop';

function replaceGlobal(name: string, value: unknown): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  return () => {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  };
}

test('notify returns the desktop bridge delivery result', async () => {
  const expected = { shown: false, reason: 'timeout' };
  const restore = replaceGlobal('window', {
    droidControl: { notify: async () => expected },
  });
  try {
    assert.deepEqual(await notify('DROIDEX', 'Finished'), expected);
  } finally {
    restore();
  }
});

test('notify reports unsupported when the desktop bridge is absent', async () => {
  const restore = replaceGlobal('window', undefined);
  try {
    assert.deepEqual(await notify('DROIDEX', 'Finished'), {
      shown: false,
      reason: 'unsupported',
    });
  } finally {
    restore();
  }
});
