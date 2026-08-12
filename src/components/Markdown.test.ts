import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Markdown } from './Markdown';

test('disabled diagrams render fenced SVG as escaped code', () => {
  const source = '```svg\n<svg onload="globalThis.pwned=true"></svg>\n```';
  const html = renderToStaticMarkup(
    createElement(Markdown, { allowGeneratedContent: false }, source),
  );

  assert.doesNotMatch(html, /<svg[^>]*\sonload=/i);
  assert.match(html, /&lt;svg onload=/);
});

test('app fences stay inert behind an explicit Play action', () => {
  const source = '```app\n<button onclick="document.body.dataset.ran=\'yes\'">Run</button>\n```';
  const html = renderToStaticMarkup(createElement(Markdown, null, source));

  assert.match(html, />App</);
  assert.match(html, /aria-label="Play app"/);
  assert.match(html, /&lt;button onclick=/);
  assert.doesNotMatch(html, /<iframe/i);
  assert.doesNotMatch(html, /srcdoc=/i);
});

test('app blocks are framed as a top-level surface instead of nesting inside preformatted text', () => {
  const source = '```app\n<p>App surface</p>\n```';
  const html = renderToStaticMarkup(createElement(Markdown, null, source));

  assert.doesNotMatch(html, /<pre><div[^>]*my-2\.5/);
});

test('disabled generated content renders app fences as ordinary code', () => {
  const source = '```app\n<p>Untrusted preview content</p>\n```';
  const html = renderToStaticMarkup(
    createElement(Markdown, { allowGeneratedContent: false }, source),
  );

  assert.match(html, /&lt;p&gt;Untrusted preview content&lt;\/p&gt;/);
  assert.doesNotMatch(html, /aria-label="Play app"/);
});

test('only the exact app fence activates an App block', () => {
  const source = '```application\n<p>Ordinary code</p>\n```';
  const html = renderToStaticMarkup(createElement(Markdown, null, source));

  assert.match(html, /&lt;p&gt;Ordinary code&lt;\/p&gt;/);
  assert.doesNotMatch(html, /aria-label="Play app"/);
});
