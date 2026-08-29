import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { droidSessionConfiguration } from './sessionConfiguration';

test('automatic update checks start before CLI environment detection and repeat while enabled', async () => {
  const module = (await import('./appUpdate')) as unknown as {
    startAutomaticAppUpdateChecks?: (
      check: () => void,
      schedule: (callback: () => void, intervalMs: number) => number,
      cancel: (handle: number) => void,
    ) => () => void;
  };
  assert.equal(typeof module.startAutomaticAppUpdateChecks, 'function');
  if (!module.startAutomaticAppUpdateChecks) return;
  let checks = 0;
  let scheduled: (() => void) | undefined;
  let intervalMs = 0;
  let cancelled = 0;
  const stop = module.startAutomaticAppUpdateChecks(
    () => {
      checks += 1;
    },
    (callback, interval) => {
      scheduled = callback;
      intervalMs = interval;
      return 17;
    },
    (handle) => {
      cancelled = handle;
    },
  );

  assert.equal(checks, 1);
  assert.equal(intervalMs, 4 * 60 * 60 * 1_000);
  scheduled?.();
  assert.equal(checks, 2);
  stop();
  assert.equal(cancelled, 17);
});

test('waiting on an update during active work carries that approval to the next launch check', async () => {
  const module = (await import('./appUpdate')) as unknown as {
    prepareAppUpdateRequest?: (
      hasActiveWork: boolean,
      confirmRestart: () => boolean,
      storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
    ) => boolean;
    consumeDeferredAppUpdate?: (
      updateAvailable: boolean,
      storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
    ) => boolean;
  };
  assert.equal(typeof module.prepareAppUpdateRequest, 'function');
  assert.equal(typeof module.consumeDeferredAppUpdate, 'function');
  if (!module.prepareAppUpdateRequest || !module.consumeDeferredAppUpdate) return;
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };

  assert.equal(
    module.prepareAppUpdateRequest(true, () => false, storage),
    false,
  );
  assert.equal(module.consumeDeferredAppUpdate(false, storage), false);
  assert.equal(module.consumeDeferredAppUpdate(true, storage), true);
  assert.equal(module.consumeDeferredAppUpdate(true, storage), false);
});

test('an idle app installs immediately without showing a restart warning', async () => {
  const module = (await import('./appUpdate')) as unknown as {
    prepareAppUpdateRequest?: (
      hasActiveWork: boolean,
      confirmRestart: () => boolean,
      storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
    ) => boolean;
  };
  assert.equal(typeof module.prepareAppUpdateRequest, 'function');
  if (!module.prepareAppUpdateRequest) return;
  let prompted = false;
  const values = new Map([['droidex.app-update.deferred', '1']]);
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };

  assert.equal(
    module.prepareAppUpdateRequest(
      false,
      () => {
        prompted = true;
        return false;
      },
      storage,
    ),
    true,
  );
  assert.equal(prompted, false);
  assert.equal(values.has('droidex.app-update.deferred'), false);
});

test('only the launch check may resume a deferred update', async () => {
  const module = (await import('./appUpdate')) as unknown as {
    checkForAppUpdateAutomatically?: (
      resumeDeferred: boolean,
      check: () => Promise<{
        current: string;
        latest: string;
        updateAvailable: boolean;
        arch: string;
        platform: string;
        installMode: 'automatic';
      }>,
      install: () => Promise<void>,
      storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
    ) => Promise<void>;
  };
  assert.equal(typeof module.checkForAppUpdateAutomatically, 'function');
  if (!module.checkForAppUpdateAutomatically) return;
  const values = new Map([['droidex.app-update.deferred', '1']]);
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
  let installs = 0;
  const check = async () => ({
    current: '1.1.3',
    latest: '1.1.4',
    updateAvailable: true,
    arch: 'arm64',
    platform: 'darwin',
    installMode: 'automatic' as const,
  });
  const install = async () => {
    installs += 1;
  };

  await module.checkForAppUpdateAutomatically(false, check, install, storage);
  assert.equal(installs, 0);
  assert.equal(values.get('droidex.app-update.deferred'), '1');
  await module.checkForAppUpdateAutomatically(true, check, install, storage);
  assert.equal(installs, 1);
  assert.equal(values.has('droidex.app-update.deferred'), false);
});

test('new agent work is blocked for the full automatic update transaction', async () => {
  const updateModule = await import('./appUpdate');
  const commands = await import('./commands');
  const previousWindow = globalThis.window;
  let finishDownload: (() => void) | undefined;
  const download = new Promise<null>((resolve) => {
    finishDownload = () => {
      resolve(null);
    };
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      droidControl: {
        downloadAppUpdate: () => download,
      },
    },
  });

  try {
    const installing = updateModule.startAppUpdate({
      current: '1.1.3',
      latest: '1.1.4',
      updateAvailable: true,
      arch: 'arm64',
      platform: 'darwin',
      installMode: 'automatic',
    });
    assert.equal(updateModule.isAppUpdateInstalling(), true);
    assert.throws(
      () =>
        commands.createSession({
          clientRef: 'blocked',
          title: 'Blocked during update',
          goal: 'Do not send',
          sessionPurpose: 'chat',
          configuration: droidSessionConfiguration({
            modelId: 'model-default',
            interactionMode: 'auto',
            autonomy: 'off',
          }),
        }),
      /new agent work is paused until restart/,
    );
    finishDownload?.();
    await installing;
    assert.equal(updateModule.isAppUpdateInstalling(), false);
  } finally {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: previousWindow,
    });
  }
});

test('sidebar download button only appears for a discovered update', async () => {
  const module = (await import('../components/SidebarAppUpdateButton')) as unknown as {
    AppUpdateButtonView?: (props: {
      latest: string | null;
      downloading: boolean;
      onStart: () => void;
    }) => ReturnType<typeof createElement> | null;
  };
  assert.equal(typeof module.AppUpdateButtonView, 'function');
  if (!module.AppUpdateButtonView) return;

  assert.equal(
    renderToStaticMarkup(
      createElement(module.AppUpdateButtonView, {
        latest: null,
        downloading: false,
        onStart: () => undefined,
      }),
    ),
    '',
  );
  const html = renderToStaticMarkup(
    createElement(module.AppUpdateButtonView, {
      latest: '1.1.4',
      downloading: false,
      onStart: () => undefined,
    }),
  );
  assert.match(html, /Review DROIDEX 1\.1\.4 update/);
  assert.match(html, /<button/);
  assert.match(html, /lucide-download/);
});
