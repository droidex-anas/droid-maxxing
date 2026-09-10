import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as icons from '@droidex/icons';
import { catalog } from '../tools/catalog.mjs';

test('public components accept size, color, SVG attributes and accessible labels', () => {
  const decorative = renderToStaticMarkup(createElement(icons.Rosette, { size: 16 }));
  assert.match(decorative, /width="16" height="16"/);
  assert.match(decorative, /stroke="currentColor"/);
  assert.match(decorative, /aria-hidden="true"/);
  assert.doesNotMatch(decorative, /role=/);

  const labelled = renderToStaticMarkup(
    createElement(icons.RosetteFilled, {
      size: 20,
      color: 'rebeccapurple',
      'aria-label': 'Design skill',
      className: 'custom-icon',
    }),
  );
  assert.match(labelled, /role="img"/);
  assert.match(labelled, /aria-label="Design skill"/);
  assert.match(labelled, /color="rebeccapurple"/);
  assert.match(labelled, /fill="currentColor"/);
  assert.match(labelled, /class="custom-icon"/);
  assert.doesNotMatch(labelled, /aria-hidden/);
});

test('externally labelled icons are not hidden from assistive technology', () => {
  const html = renderToStaticMarkup(
    createElement(icons.CircleCheckFilled, {
      'aria-label': '',
      'aria-labelledby': 'check-result',
    }),
  );
  assert.match(html, /role="img"/);
  assert.match(html, /aria-labelledby="check-result"/);
  assert.doesNotMatch(html, /aria-hidden/);
});

test('every public export renders and has a matching raw SVG export', async () => {
  assert.deepEqual(Object.keys(icons).sort(), catalog.map((icon) => icon.name).sort());
  assert.equal(new Set(catalog.map((icon) => icon.slug)).size, catalog.length);
  for (const { name, slug } of catalog) {
    const html = renderToStaticMarkup(
      createElement(icons[name], {
        xmlns: 'http://www.w3.org/2000/svg',
      }),
    );
    assert.match(html, /^<svg /, name);
    assert.match(html, /viewBox="0 0 24 24"/, name);
    assert.match(html, /width="24" height="24"/, name);
    const exported = await readFile(
      new URL(import.meta.resolve(`@droidex/icons/svg/${slug}.svg`)),
      'utf8',
    );
    assert.equal(exported.trim(), html, name);
  }
});

test('spinner keeps its heavier stroke and animation remains opt-in', () => {
  const html = renderToStaticMarkup(createElement(icons.Spinner, { size: 14 }));
  assert.match(html, /stroke-width="2"/);
  assert.match(html, /width="14" height="14"/);
  assert.doesNotMatch(html, /class=|style=|<animate/);
  const custom = renderToStaticMarkup(createElement(icons.Spinner, { strokeWidth: 1.5 }));
  assert.match(custom, /stroke-width="1.5"/);
});
