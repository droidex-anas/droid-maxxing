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

test('restored app fences stay inert behind a compact Play card', () => {
  const source = '```app\n<button onclick="document.body.dataset.ran=\'yes\'">Run</button>\n```';
  const html = renderToStaticMarkup(createElement(Markdown, null, source));

  assert.match(html, /Interactive App/);
  assert.match(html, /aria-label="Play app"/);
  assert.doesNotMatch(html, /&lt;button onclick=/);
  assert.doesNotMatch(html, /<iframe/i);
  assert.doesNotMatch(html, /srcdoc=/i);
});

test('a complete app fence in the live response opens automatically', () => {
  const source = '```app\n<main>Live app</main>\n```';
  const html = renderToStaticMarkup(createElement(Markdown, { autoPlayAppBlocks: true }, source));

  assert.match(html, /<iframe/i);
  assert.match(html, /aria-label="Stop app"/);
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

test('plain fenced blocks preserve preformatted multiline layout', () => {
  const html = renderToStaticMarkup(
    createElement(Markdown, null, '```\nfirst line\nsecond line\n```'),
  );

  assert.match(html, /<pre[^>]*>/);
  assert.match(html, /first line\nsecond line/);
});

test('formatted spec headings keep a usable text slug', () => {
  const html = renderToStaticMarkup(
    createElement(Markdown, { specMode: true }, '## The `--app-surface` *color*'),
  );

  assert.match(html, /id="the-app-surface-color"/);
  assert.doesNotMatch(html, /id=""/);
});

test('each live App fence owns its own completion state', () => {
  const source = [
    '```app',
    '<main>Complete</main>',
    '```',
    '',
    '```app',
    '<main>Still streaming',
  ].join('\n');
  const html = renderToStaticMarkup(
    createElement(Markdown, { autoPlayAppBlocks: true, buildingAppBlocks: true }, source),
  );

  assert.equal(html.match(/<iframe/g)?.length, 1);
  assert.equal(html.match(/>Building interactive app</g)?.length, 1);
});

test('App fences with an info-string title use the same completion state as react-markdown', () => {
  const source = '```app title="Latency explorer"\n<main>Still streaming';
  const html = renderToStaticMarkup(
    createElement(Markdown, { autoPlayAppBlocks: true, buildingAppBlocks: true }, source),
  );

  assert.match(html, />Building interactive app</);
  assert.doesNotMatch(html, /<iframe/i);
});

test('uppercase fences stay ordinary code without shifting a later App completion state', () => {
  const source = [
    '```App',
    '<main>Ordinary code</main>',
    '```',
    '',
    '```app',
    '<main>Still streaming',
  ].join('\n');
  const html = renderToStaticMarkup(
    createElement(Markdown, { autoPlayAppBlocks: true, buildingAppBlocks: true }, source),
  );

  assert.match(html, /&lt;main&gt;Ordinary code&lt;\/main&gt;/);
  assert.match(html, />Building interactive app</);
  assert.doesNotMatch(html, /<iframe/i);
});

test('completed App fences inside quotes and lists keep their completed streaming state', () => {
  const sources = [
    ['> ```app', '> <main>Quoted app</main>', '> ```'].join('\n'),
    ['- ```app', '  <main>Listed app</main>', '  ```'].join('\n'),
  ];

  for (const source of sources) {
    const html = renderToStaticMarkup(
      createElement(Markdown, { autoPlayAppBlocks: true, buildingAppBlocks: true }, source),
    );
    assert.match(html, /<iframe/i);
    assert.doesNotMatch(html, />Building interactive app</);
  }
});

test('copy gracefully declines when the Clipboard API is unavailable', async () => {
  const markdown = (await import('./Markdown')) as unknown as {
    copyMarkdownCode?: (
      clipboard: Pick<Clipboard, 'writeText'> | undefined,
      text: string,
    ) => Promise<boolean>;
  };
  assert.equal(await markdown.copyMarkdownCode?.(undefined, 'sample'), false);
});
