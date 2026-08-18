import assert from 'node:assert/strict';
import test from 'node:test';

import { applyCommentPostSettlement } from './PrDetail';

test('submit settlement after number change does not clear the new PR draft or leave posting stuck', () => {
  let draft = 'old comment';
  let posting = true;
  const submitted = { cwd: '/repo', number: 1 };

  draft = '';
  posting = false;
  draft = 'new draft';

  const settlement = applyCommentPostSettlement(submitted, { cwd: '/repo', number: 2 }, true);
  assert.equal(settlement, null);
  assert.equal(draft, 'new draft');
  assert.equal(posting, false);
});

test('submit settlement on the same PR clears the draft and ends posting', () => {
  const submitted = { cwd: '/repo', number: 1 };
  const settlement = applyCommentPostSettlement(submitted, submitted, true);
  assert.deepEqual(settlement, { clearDraft: true, posting: false });
});

test('failed submit on the same PR keeps the draft and ends posting', () => {
  const submitted = { cwd: '/repo', number: 1 };
  const settlement = applyCommentPostSettlement(submitted, submitted, false);
  assert.deepEqual(settlement, { clearDraft: false, posting: false });
});
