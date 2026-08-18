import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { initialState, StaticStoreProvider } from '../../../hooks/useStore';
import { applyCommentPostSettlement, CodePane } from './PrDetail';

function renderCodePane(diff: string | null, diffError: string | null): string {
  return renderToStaticMarkup(
    createElement(
      StaticStoreProvider,
      { state: initialState, dispatch: () => undefined },
      createElement(CodePane, { diff, diffError }),
    ),
  );
}

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

test('diff-success with an empty remote patch shows no file changes, not the skeleton', () => {
  const html = renderCodePane('', null);
  assert.match(html, /No file changes\./);
  assert.doesNotMatch(html, /bg-droid-elevated\/40/);
});

test('unset diff still shows the loading skeleton until a patch arrives', () => {
  const html = renderCodePane(null, null);
  assert.match(html, /bg-droid-elevated\/40/);
  assert.doesNotMatch(html, /No file changes\./);
});
