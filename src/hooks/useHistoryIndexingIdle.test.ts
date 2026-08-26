import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldRunHistoryBackfill } from './useHistoryIndexingIdle';

test('history backfill requires one minute of operating-system idle time', () => {
  assert.equal(shouldRunHistoryBackfill(null), false);
  assert.equal(shouldRunHistoryBackfill(0), false);
  assert.equal(shouldRunHistoryBackfill(59), false);
  assert.equal(shouldRunHistoryBackfill(60), true);
  assert.equal(shouldRunHistoryBackfill(600), true);
});
