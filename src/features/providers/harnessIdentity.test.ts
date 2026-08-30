import assert from 'node:assert/strict';
import test from 'node:test';

import { HARNESS_DISPLAY_NAME, HARNESS_ORDER, isProviderInstanceId } from './harnessIdentity.js';

test('harness order is Droid first then the registered CLIs', () => {
  assert.deepEqual(HARNESS_ORDER, ['droid', 'codex', 'claude', 'cursor', 'grok']);
  assert.equal(HARNESS_DISPLAY_NAME.droid, 'Droid');
  assert.equal(isProviderInstanceId('grok'), true);
  assert.equal(isProviderInstanceId('factory'), false);
});
