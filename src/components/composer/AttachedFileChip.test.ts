import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AttachedFileChip } from './AttachedFileChip';

const render = (path: string) =>
  renderToStaticMarkup(createElement(AttachedFileChip, { path, onRemove: () => undefined }));

test('names the file and keeps the full path as the tooltip', () => {
  const html = render('/Users/me/repo/docs/notes.md');
  assert.match(html, /notes\.md/);
  assert.match(html, /title="\/Users\/me\/repo\/docs\/notes\.md"/);
  assert.match(html, /Remove file/);
});

test('an image with no displayable source still gets a removable chip', () => {
  // A repo-relative image cannot be resolved to a src, so the composer falls back
  // to this chip; returning nothing left the attachment attached but invisible.
  const html = render('assets/hero.png');
  assert.match(html, /hero\.png/);
  assert.match(html, /Remove file/);
});
