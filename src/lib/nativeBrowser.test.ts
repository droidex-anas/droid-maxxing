import assert from 'node:assert/strict';
import test from 'node:test';
import { runNativeBrowserAgentAction } from './nativeBrowser';

test('an approval-capable action remains pending past the normal transport timeout', async () => {
  const globals = globalThis as typeof globalThis & { window?: unknown };
  const previousWindow = globals.window;
  let resolveAction: ((value: Record<string, unknown>) => void) | undefined;
  const timers: Array<{ active: boolean; callback: () => void; delay: number }> = [];
  globals.window = {
    droidControl: {
      nativeBrowserAgentAction: () =>
        new Promise((resolve) => {
          resolveAction = resolve;
        }),
    },
    setTimeout: (callback: () => void, delay: number) => {
      timers.push({ active: true, callback, delay });
      return timers.length;
    },
    clearTimeout: (timer: number) => {
      const record = timers[timer - 1];
      if (record) record.active = false;
    },
  };

  try {
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

    const timeout = timers.at(-1);
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
  } finally {
    if (previousWindow === undefined) delete globals.window;
    else globals.window = previousWindow;
  }
});

test('non-interactive actions retain the bounded transport timeout', async () => {
  const globals = globalThis as typeof globalThis & { window?: unknown };
  const previousWindow = globals.window;
  const timers: Array<{ active: boolean; callback: () => void; delay: number }> = [];
  globals.window = {
    droidControl: { nativeBrowserAgentAction: () => new Promise(() => {}) },
    setTimeout: (callback: () => void, delay: number) => {
      timers.push({ active: true, callback, delay });
      return timers.length;
    },
    clearTimeout: (timer: number) => {
      const record = timers[timer - 1];
      if (record) record.active = false;
    },
  };

  try {
    const action = runNativeBrowserAgentAction({
      requestId: 'snapshot-request',
      appSessionId: 'app-1',
      browserSessionId: 'browser-1',
      action: 'snapshot',
    });
    const timeout = timers.at(-1);
    assert.ok(timeout);
    assert.equal(timeout.delay, 10_000);
    timeout.callback();
    await assert.rejects(action, /snapshot timed out/);
  } finally {
    if (previousWindow === undefined) delete globals.window;
    else globals.window = previousWindow;
  }
});

test('simple pointer, typing, selection, scroll, and non-Enter key actions use the short timeout', async () => {
  const globals = globalThis as typeof globalThis & { window?: unknown };
  const previousWindow = globals.window;
  const timers: Array<{ callback: () => void; delay: number }> = [];
  globals.window = {
    droidControl: { nativeBrowserAgentAction: () => new Promise(() => {}) },
    setTimeout: (callback: () => void, delay: number) => {
      timers.push({ callback, delay });
      return timers.length;
    },
    clearTimeout: () => {},
  };

  try {
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
      timers.map(({ delay }) => delay),
      [10_000, 10_000, 10_000, 10_000, 10_000],
    );
    timers.forEach(({ callback }) => callback());
    await Promise.all(pending.map((promise) => assert.rejects(promise, /timed out/)));
  } finally {
    if (previousWindow === undefined) delete globals.window;
    else globals.window = previousWindow;
  }
});

test('Enter and saved-login actions retain the approval timeout', async () => {
  const globals = globalThis as typeof globalThis & { window?: unknown };
  const previousWindow = globals.window;
  const timers: Array<{ callback: () => void; delay: number }> = [];
  globals.window = {
    droidControl: { nativeBrowserAgentAction: () => new Promise(() => {}) },
    setTimeout: (callback: () => void, delay: number) => {
      timers.push({ callback, delay });
      return timers.length;
    },
    clearTimeout: () => {},
  };

  try {
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
    ];

    assert.deepEqual(
      timers.map(({ delay }) => delay),
      [180_000, 180_000],
    );
    timers.forEach(({ callback }) => callback());
    await Promise.all(pending.map((promise) => assert.rejects(promise, /timed out/)));
  } finally {
    if (previousWindow === undefined) delete globals.window;
    else globals.window = previousWindow;
  }
});
