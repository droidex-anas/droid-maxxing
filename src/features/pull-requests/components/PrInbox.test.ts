import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldShowPrInboxEmpty } from './PrInbox';

test('an initial list failure does not also claim the repository is empty', () => {
  assert.equal(shouldShowPrInboxEmpty('Could not load pull requests', 0), false);
  assert.equal(shouldShowPrInboxEmpty(null, 0), true);
  assert.equal(shouldShowPrInboxEmpty(null, 2), false);
});
