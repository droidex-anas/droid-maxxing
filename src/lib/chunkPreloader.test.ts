import assert from 'node:assert/strict';
import test from 'node:test';

import {
  __loaderCallsForTest,
  __resetChunkPreloaderForTest,
  bindLazySurfaceIntent,
  cancelIdleLazyWarmup,
  preloadLazySurface,
  scheduleIdleLazyWarmup,
} from './chunkPreloader';

test('preloadLazySurface invokes the loader exactly once', () => {
  __resetChunkPreloaderForTest({
    loaders: {
      settings: () => Promise.resolve({ default: () => null }),
    },
  });
  preloadLazySurface('settings');
  preloadLazySurface('settings');
  assert.equal(__loaderCallsForTest().get('settings'), 1);
});

test('intent binding preloads once and cleans up listeners', () => {
  let loads = 0;
  __resetChunkPreloaderForTest({
    loaders: {
      files: () => {
        loads += 1;
        return Promise.resolve({ default: () => null });
      },
    },
  });
  const element = new EventTarget() as HTMLElement;
  const cleanup = bindLazySurfaceIntent('files', element);
  element.dispatchEvent(new Event('pointerenter'));
  assert.equal(loads, 1);
  cleanup();
  element.dispatchEvent(new Event('pointerenter'));
  assert.equal(loads, 1);
});

test('failed preloads allow a later retry for intent and idle triggers', async () => {
  let attempts = 0;
  __resetChunkPreloaderForTest({
    loaders: {
      settings: () => {
        attempts += 1;
        return Promise.reject(new Error('network'));
      },
    },
  });
  preloadLazySurface('settings');
  await Promise.resolve();
  preloadLazySurface('settings');
  await Promise.resolve();
  assert.equal(attempts, 2);
});

test('idle warm-up schedules once', () => {
  __resetChunkPreloaderForTest({
    loaders: {
      settings: () => Promise.resolve({ default: () => null }),
      commandPalette: () => Promise.resolve({ default: () => null }),
      files: () => Promise.resolve({ default: () => null }),
      terminal: () => Promise.resolve({ default: () => null }),
      review: () => Promise.resolve({ default: () => null }),
      browser: () => Promise.resolve({ default: () => null }),
    },
  });
  let idleRuns = 0;
  let idleCallback: (() => void) | null = null;
  (globalThis as { requestIdleCallback?: unknown }).requestIdleCallback = (
    callback: () => void,
  ) => {
    idleRuns += 1;
    idleCallback = callback;
    return idleRuns;
  };
  try {
    scheduleIdleLazyWarmup();
    scheduleIdleLazyWarmup();
    assert.equal(idleRuns, 1);
    idleCallback?.();
    assert.equal(__loaderCallsForTest().get('settings'), 1);
  } finally {
    delete (globalThis as { requestIdleCallback?: unknown }).requestIdleCallback;
  }
});

test('idle warm-up cancellation prevents warm-up', () => {
  __resetChunkPreloaderForTest({
    loaders: {
      settings: () => Promise.resolve({ default: () => null }),
    },
  });
  let idleCallback: (() => void) | null = null;
  (globalThis as { requestIdleCallback?: unknown }).requestIdleCallback = (
    callback: () => void,
  ) => {
    idleCallback = callback;
    return 1;
  };
  try {
    scheduleIdleLazyWarmup();
    cancelIdleLazyWarmup();
    idleCallback?.();
    assert.equal(__loaderCallsForTest().size, 0);
  } finally {
    delete (globalThis as { requestIdleCallback?: unknown }).requestIdleCallback;
  }
});
