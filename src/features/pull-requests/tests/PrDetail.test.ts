import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { PrDetail } from '../components/PrDetail';

const noop = () => undefined;

function renderDetail(): string {
  return renderToStaticMarkup(
    createElement(PrDetail, {
      cwd: '/repo',
      number: 4,
      pr: null,
      viewerLogin: null,
      onOpenChat: noop,
      onReviewWithDroid: noop,
    }),
  );
}

test('the Summary and Code views are an accessible tab list', () => {
  const html = renderDetail();
  assert.match(html, /role="tablist" aria-label="Pull request views"/);
  assert.match(html, /role="tab" aria-selected="true"[^>]*>Summary</);
  assert.match(html, /role="tab" aria-selected="false"[^>]*>Code</);
});
