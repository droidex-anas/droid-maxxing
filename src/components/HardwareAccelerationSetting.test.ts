import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  getHardwareAcceleration,
  isHardwareAccelerationSettingAvailable,
  setHardwareAcceleration,
} from '../lib/hardwareAcceleration.js';
import { HardwareAccelerationSetting } from './HardwareAccelerationSetting.js';

const g = globalThis as { window?: { droidControl?: Record<string, unknown> } };

afterEach(() => {
  delete g.window;
});

test('hardware acceleration setting is absent without the desktop bridge', () => {
  const html = renderToStaticMarkup(createElement(HardwareAccelerationSetting));
  assert.equal(html, '');
  assert.equal(isHardwareAccelerationSettingAvailable(), false);
});

test('hardware acceleration setting communicates the restart requirement', () => {
  g.window = {
    droidControl: {
      getHardwareAcceleration: async () => ({ enabled: true }),
      setHardwareAcceleration: async (enabled: boolean) => ({ enabled }),
      relaunchApp: async () => undefined,
    },
  };

  const html = renderToStaticMarkup(createElement(HardwareAccelerationSetting));
  assert.match(html, /Hardware acceleration/);
  assert.match(html, /Changes take effect after you restart DROIDEX/);
  assert.match(html, /aria-label="Hardware acceleration"/);
});

test('hardware acceleration bridge rejects missing desktop methods', async () => {
  await assert.rejects(getHardwareAcceleration, /only available in the DROIDEX app/i);
  await assert.rejects(() => setHardwareAcceleration(false), /only available in the DROIDEX app/i);
});

test('hardware acceleration bridge reads persisted preference responses', async () => {
  g.window = {
    droidControl: {
      getHardwareAcceleration: async () => ({ enabled: false }),
      setHardwareAcceleration: async (enabled: boolean) => ({ enabled }),
    },
  };

  assert.deepEqual(await getHardwareAcceleration(), { enabled: false });
  assert.deepEqual(await setHardwareAcceleration(true), { enabled: true });
});
