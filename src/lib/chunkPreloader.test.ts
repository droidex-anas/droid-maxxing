import assert from 'node:assert/strict';
import test from 'node:test';

import {
  bindLazySurfaceIntent,
  cancelIdleLazyWarmup,
  preloadLazySurface,
  resetChunkPreloaderForTest,
  scheduleIdleLazyWarmup,
  warmedLazySurfacesForTest,
} from './chunkPreloader';

test('preloadLazySurface warms a chunk exactly once', () => {
  resetChunkPreloaderForTest();
  preloadLazySurface('settings');
  preloadLazySurface('settings');
  assert.ok(warmedLazySurfacesForTest().has('settings'));
  assert.equal(warmedLazySurfacesForTest().size, 1);
});

test('intent binding preloads once and cleans up listeners', () => {
  resetChunkPreloaderForTest();
  const element = new EventTarget() as HTMLElement;
  const cleanup = bindLazySurfaceIntent('files', element);
  element.dispatchEvent(new Event('pointerenter'));
  assert.ok(warmedLazySurfacesForTest().has('files'));
  cleanup();
  element.dispatchEvent(new Event('pointerenter'));
  assert.equal(warmedLazySurfacesForTest().size, 1);
});

test('idle warm-up schedules once', () => {
  resetChunkPreloaderForTest();
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
    assert.ok(warmedLazySurfacesForTest().size > 0);
  } finally {
    delete (globalThis as { requestIdleCallback?: unknown }).requestIdleCallback;
  }
});

test('idle warm-up cancellation prevents warm-up', () => {
  resetChunkPreloaderForTest();
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
    assert.equal(warmedLazySurfacesForTest().size, 0);
  } finally {
    delete (globalThis as { requestIdleCallback?: unknown }).requestIdleCallback;
  }
});
