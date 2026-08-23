import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { retryNativeBrowserAttach } from './NativeBrowserSurface';

const source = fs.readFileSync(new URL('./NativeBrowserSurface.tsx', import.meta.url), 'utf8');

test('iframe lifecycle uses callback refs instead of callback dependencies', () => {
  assert.match(source, /onSelection: \(selection\) => onSelectionRef\.current\(selection\)/);
  assert.match(source, /onLoadedRef\.current\(\{/);
  assert.match(
    source,
    /}, \[browserKey, designMode, native, pencilMode, url, visibleBrowserSessionId\]\);/,
  );
});

test('visible agent actions pass their live surface bounds to the main process', () => {
  assert.match(source, /runNativeBrowserAgentAction\(request, undefined, visibleBounds\)/);
  assert.doesNotMatch(source, /request\.action === 'open' \? visibleBounds/);
  assert.doesNotMatch(
    source,
    /if \(visibleBounds && request\.action !== 'open'\)[\s\S]*?setNativeBrowserBounds/,
  );
});

test('agent actions do not repeat design-state IPC already owned by the settings effect', () => {
  assert.doesNotMatch(source, /await syncNativeDesignState\(/);
});

test('native surface attachment retries twice before surfacing the failure', async () => {
  const scheduled: { callback: () => void; delayMs: number }[] = [];
  const failures: unknown[] = [];
  let attempts = 0;

  retryNativeBrowserAttach({
    attach: async () => {
      attempts += 1;
      throw new Error('attach unavailable');
    },
    onAttached: () => assert.fail('attach must not succeed'),
    onFailed: (error) => failures.push(error),
    schedule: (callback, delayMs) => {
      scheduled.push({ callback, delayMs });
      return scheduled.length as unknown as ReturnType<typeof setTimeout>;
    },
  });

  await Promise.resolve();
  assert.equal(attempts, 1);
  assert.deepEqual(
    scheduled.map(({ delayMs }) => delayMs),
    [100],
  );
  scheduled.shift()?.callback();
  await Promise.resolve();
  assert.equal(attempts, 2);
  assert.deepEqual(
    scheduled.map(({ delayMs }) => delayMs),
    [300],
  );
  scheduled.shift()?.callback();
  await Promise.resolve();

  assert.equal(attempts, 3);
  assert.equal(failures.length, 1);
  assert.match(String(failures[0]), /attach unavailable/);
});

test('native surface attachment cleanup cancels a scheduled retry', async () => {
  let scheduledCallback: (() => void) | undefined;
  let cancelled = false;
  let attempts = 0;
  const stop = retryNativeBrowserAttach({
    attach: async () => {
      attempts += 1;
      throw new Error('attach unavailable');
    },
    onAttached: () => assert.fail('attach must not succeed'),
    onFailed: () => assert.fail('disposed retries must not surface failures'),
    schedule: (callback) => {
      scheduledCallback = callback;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    },
    cancel: () => {
      cancelled = true;
    },
  });

  await Promise.resolve();
  stop();
  scheduledCallback?.();
  await Promise.resolve();

  assert.equal(cancelled, true);
  assert.equal(attempts, 1);
});
