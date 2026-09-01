import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Expand, ToolPanel } from './primitives';

test('Expand omits children when closed', () => {
  const closed = renderToStaticMarkup(
    createElement(Expand, { open: false }, createElement('pre', null, 'SECRET')),
  );
  assert.equal(closed.includes('SECRET'), false);
  const opened = renderToStaticMarkup(
    createElement(Expand, { open: true }, createElement('pre', null, 'SECRET')),
  );
  assert.equal(opened.includes('SECRET'), true);
});

test('Expand uses grid 0fr/1fr rows with reduced-motion off', () => {
  const closed = renderToStaticMarkup(createElement(Expand, { open: false }, 'x'));
  assert.match(closed, /grid-rows-\[0fr\]/);
  assert.match(closed, /opacity-0/);
  assert.match(closed, /aria-hidden="true"/);
  assert.match(closed, /motion-reduce:transition-none/);
  const opened = renderToStaticMarkup(createElement(Expand, { open: true }, 'x'));
  assert.match(opened, /grid-rows-\[1fr\]/);
  assert.match(opened, /opacity-100/);
  assert.match(opened, /aria-hidden="false"/);
  assert.match(opened, /transition-\[grid-template-rows,opacity\]/);
  assert.match(opened, /min-h-0 overflow-hidden/);
});

test('ToolPanel applies the short-shadow panel class', () => {
  const html = renderToStaticMarkup(
    createElement(ToolPanel, { className: 'max-h-56 overflow-y-auto' }, 'body'),
  );
  assert.match(html, /droid-tool-panel/);
  assert.match(html, /max-h-56 overflow-y-auto/);
});
