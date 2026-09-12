import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { DiffBody } from './DiffBody.js';

const DIFF = ['@@ -1,1 +1,2 @@', ' context', `+${'x'.repeat(300)}`].join('\n');

function render(view: 'unified' | 'split', wrap: boolean): string {
  return renderToStaticMarkup(createElement(DiffBody, { diff: DIFF, view, wrap }));
}

// A row wider than the viewport used to paint its add/del tone only across the
// initial viewport width; the body now carries the widest-line width instead.
test('scrolling diff bodies are sized to their widest line, wrapped ones are not', () => {
  assert.match(render('unified', false), /review-diff-content/);
  assert.match(render('split', false), /review-diff-content/);
  assert.doesNotMatch(render('unified', true), /review-diff-content/);
});
