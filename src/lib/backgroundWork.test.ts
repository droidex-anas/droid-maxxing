import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveBackgroundWorkTier } from './backgroundWork';

test('visible documents stay interactive even on battery', () => {
  assert.equal(
    resolveBackgroundWorkTier({ documentVisible: true, windowVisible: true, onBattery: true }),
    'interactive',
  );
});

test('hidden windows pause informational work; battery deepens the tier', () => {
  assert.equal(
    resolveBackgroundWorkTier({ documentVisible: false, windowVisible: true, onBattery: false }),
    'hidden',
  );
  assert.equal(
    resolveBackgroundWorkTier({ documentVisible: true, windowVisible: false, onBattery: true }),
    'low-power',
  );
});
