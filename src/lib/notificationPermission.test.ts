import test from 'node:test';
import assert from 'node:assert/strict';
import { requestNotificationPermission } from './notificationPermission';

function replaceNotification(value: unknown): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'Notification');
  Object.defineProperty(globalThis, 'Notification', {
    configurable: true,
    writable: true,
    value,
  });
  return () => {
    if (descriptor) Object.defineProperty(globalThis, 'Notification', descriptor);
    else Reflect.deleteProperty(globalThis, 'Notification');
  };
}

for (const permission of ['granted', 'denied'] as const) {
  test(`returns existing ${permission} permission without prompting`, async () => {
    let prompted = false;
    const restore = replaceNotification({
      permission,
      requestPermission: async () => {
        prompted = true;
        return 'default';
      },
    });
    try {
      assert.equal(await requestNotificationPermission(), permission);
      assert.equal(prompted, false);
    } finally {
      restore();
    }
  });
}

test('returns denied from the browser permission prompt', async () => {
  const restore = replaceNotification({
    permission: 'default',
    requestPermission: async () => 'denied',
  });
  try {
    assert.equal(await requestNotificationPermission(), 'denied');
  } finally {
    restore();
  }
});

test('preserves a dismissed browser permission prompt', async () => {
  const restore = replaceNotification({
    permission: 'default',
    requestPermission: async () => 'default',
  });
  try {
    assert.equal(await requestNotificationPermission(), 'default');
  } finally {
    restore();
  }
});

test('reports unsupported when the API is absent', async () => {
  const restore = replaceNotification(undefined);
  try {
    assert.equal(await requestNotificationPermission(), 'unsupported');
  } finally {
    restore();
  }
});

test('reports unsupported when requesting notification permission rejects', async () => {
  const restore = replaceNotification({
    permission: 'default',
    requestPermission: async () => {
      throw new Error('permission request failed');
    },
  });
  try {
    assert.equal(await requestNotificationPermission(), 'unsupported');
  } finally {
    restore();
  }
});
