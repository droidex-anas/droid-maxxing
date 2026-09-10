import assert from 'node:assert/strict';
import test from 'node:test';
import { attachNativeBrowser, runNativeBrowserAgentAction } from './nativeBrowser';

interface FakeTimer {
  active: boolean;
  callback: () => void;
  delay: number;
}

function fakeBrowserWindow(nativeBrowserAgentAction: () => Promise<unknown>) {
  const timers: FakeTimer[] = [];
  const canceled: string[] = [];
  return {
    canceled,
    timers,
    value: {
      droidControl: {
        nativeBrowserAgentAction,
        nativeBrowserAgentActionCancel: async (_browserSessionId: string, requestId: string) => {
          canceled.push(requestId);
          return true;
        },
      },
      setTimeout: (callback: () => void, delay: number) => {
        timers.push({ active: true, callback, delay });
        return timers.length;
      },
      clearTimeout: (timer: number) => {
        const record = timers[timer - 1];
        if (record) record.active = false;
      },
    },
  };
}

async function withBrowserWindow(run: () => Promise<void>, value: unknown): Promise<void> {
  const globals = globalThis as typeof globalThis & { window?: unknown };
  const previousWindow = globals.window;
  globals.window = value;
  try {
    await run();
  } finally {
    if (previousWindow === undefined) delete globals.window;
    else globals.window = previousWindow;
  }
}

test('desktop operations fail clearly if the bridge disappears after availability detection', async () => {
  let reads = 0;
  const value = {
    get droidControl() {
      reads += 1;
      return reads === 1 ? {} : undefined;
    },
  };

  await withBrowserWindow(async () => {
    await assert.rejects(
      attachNativeBrowser('browser-1', { x: 0, y: 0, width: 800, height: 600 }),
      /DROIDEX desktop bridge is unavailable/,
    );
  }, value);
});

test('an approval-capable action remains pending past the normal transport timeout', async () => {
  let resolveAction: ((value: Record<string, unknown>) => void) | undefined;
  const fake = fakeBrowserWindow(
    () =>
      new Promise((resolve) => {
        resolveAction = resolve;
      }),
  );

  await withBrowserWindow(async () => {
    let settled = false;
    const action = runNativeBrowserAgentAction({
      requestId: 'approval-request',
      appSessionId: 'app-1',
      browserSessionId: 'browser-1',
      action: 'click',
      selector: '#continue-with-google',
    }).finally(() => {
      settled = true;
    });

    const timeout = fake.timers.at(-1);
    assert.ok(timeout);
    assert.ok(timeout.delay > 10_000);
    assert.equal(settled, false);

    resolveAction?.({
      requestId: 'approval-request',
      appSessionId: 'app-1',
      browserSessionId: 'browser-1',
      ok: true,
    });
    assert.equal((await action).ok, true);
  }, fake.value);
});

test('non-interactive actions retain the bounded transport timeout', async () => {
  const fake = fakeBrowserWindow(() => new Promise(() => {}));

  await withBrowserWindow(async () => {
    const action = runNativeBrowserAgentAction({
      requestId: 'snapshot-request',
      appSessionId: 'app-1',
      browserSessionId: 'browser-1',
      action: 'snapshot',
    });
    const timeout = fake.timers.at(-1);
    assert.ok(timeout);
    assert.equal(timeout.delay, 10_000);
    timeout.callback();
    await assert.rejects(action, /snapshot timed out/);
    assert.deepEqual(fake.canceled, ['snapshot-request']);
  }, fake.value);
});

test('simple actions use the short timeout', async () => {
  const fake = fakeBrowserWindow(() => new Promise(() => {}));

  await withBrowserWindow(async () => {
    const actions = [
      { action: 'hover' as const, x: 1, y: 2 },
      { action: 'type' as const, text: 'hello' },
      { action: 'selectOption' as const, selector: '#country', text: 'CA' },
      { action: 'scroll' as const, direction: 'down' as const },
      { action: 'keypress' as const, key: 'Tab' },
    ];
    const pending = actions.map((action, index) =>
      runNativeBrowserAgentAction({
        requestId: `short-${index}`,
        appSessionId: 'app-1',
        browserSessionId: 'browser-1',
        ...action,
      }),
    );

    assert.deepEqual(
      fake.timers.map(({ delay }) => delay),
      [10_000, 10_000, 10_000, 10_000, 10_000],
    );
    fake.timers.forEach(({ callback }) => callback());
    await Promise.all(pending.map((promise) => assert.rejects(promise, /timed out/)));
  }, fake.value);
});

test('Enter and saved-login actions retain the approval timeout', async () => {
  const fake = fakeBrowserWindow(() => new Promise(() => {}));

  await withBrowserWindow(async () => {
    const pending = [
      runNativeBrowserAgentAction({
        requestId: 'enter',
        appSessionId: 'app-1',
        browserSessionId: 'browser-1',
        action: 'keypress',
        key: 'Enter',
      }),
      runNativeBrowserAgentAction({
        requestId: 'login',
        appSessionId: 'app-1',
        browserSessionId: 'browser-1',
        action: 'fillCredentials',
      }),
      runNativeBrowserAgentAction({
        requestId: 'reload',
        appSessionId: 'app-1',
        browserSessionId: 'browser-1',
        action: 'reload',
      }),
    ];

    assert.deepEqual(
      fake.timers.map(({ delay }) => delay),
      [180_000, 180_000, 180_000],
    );
    fake.timers.forEach(({ callback }) => callback());
    await Promise.all(pending.map((promise) => assert.rejects(promise, /timed out/)));
  }, fake.value);
});
