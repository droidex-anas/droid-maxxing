import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Markdown, MarkdownTree, markdownFenceOptions } from './Markdown';

interface MarkdownProps {
  children: string;
  specMode?: boolean;
  autoPlayAppBlocks?: boolean;
}

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

test('an App fence that saved history cut short reports the loss instead of offering Play', () => {
  const source = '```app\n<main data-droidex-app-root><script>const points = [';
  const html = renderToStaticMarkup(createElement(Markdown, { cutOffAppBlocks: true }, source));

  assert.match(html, /role="alert"/);
  assert.match(html, /Saved history kept only part/);
  assert.doesNotMatch(html, /aria-label="Play app"/);
  assert.doesNotMatch(html, /<iframe/i);
});

test('a cut-off message keeps its earlier complete App playable', () => {
  const source = [
    '```app',
    '<main>Complete</main>',
    '```',
    '',
    '```app',
    '<main>Cut off<script>const points = [',
  ].join('\n');
  const html = renderToStaticMarkup(createElement(Markdown, { cutOffAppBlocks: true }, source));

  assert.equal(html.match(/aria-label="Play app"/g)?.length, 1);
  assert.equal(html.match(/role="alert"/g)?.length, 1);
});

test('a complete app fence in the live response opens automatically', () => {
  const source = '```app\n<main>Live app</main>\n```';
  const html = renderToStaticMarkup(createElement(Markdown, { autoPlayAppBlocks: true }, source));

  assert.match(html, /<iframe/i);
  assert.match(html, /aria-label="Stop app"/);
});

test('disabled generated content renders app fences as ordinary code', () => {
  const source = '```app\n<p>Untrusted preview content</p>\n```';
  const html = renderToStaticMarkup(
    createElement(Markdown, { allowGeneratedContent: false }, source),
  );

  assert.match(html, /&lt;p&gt;Untrusted preview content&lt;\/p&gt;/);
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

test('a linked image renders one image control without a wrapping anchor', () => {
  const html = renderToStaticMarkup(
    createElement(Markdown, null, '[![Preview](https://x.test/a.png)](https://x.test/full)'),
  );

  assert.match(html, /<button[^>]*title="View Preview"/);
  assert.doesNotMatch(html, /<a[^>]*href="https:\/\/x\.test\/full"/);
});

test('a link containing image and text does not wrap the image control in an anchor', () => {
  const html = renderToStaticMarkup(
    createElement(
      Markdown,
      null,
      '[![Preview](https://x.test/a.png) full size](https://x.test/full)',
    ),
  );

  assert.match(html, /<button[^>]*title="View Preview"/);
  assert.match(html, /full size/);
  assert.doesNotMatch(html, /<a[^>]*href="https:\/\/x\.test\/full"/);
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
    ['- > ```app', '  > <main>Quoted list app</main>', '  > ```'].join('\n'),
  ];

  for (const source of sources) {
    const html = renderToStaticMarkup(
      createElement(Markdown, { autoPlayAppBlocks: true, buildingAppBlocks: true }, source),
    );
    assert.match(html, /<iframe/i);
    assert.doesNotMatch(html, />Building interactive app</);
  }
});

// The fence scan is deliberately simpler than a full CommonMark parser, so a
// fence nested deeper than it follows is missing from its list. An unfinished
// one must still not be mistaken for a finished app and auto-played.
test('a streaming App fence nested past the fence scan keeps building', () => {
  const source = [
    '```app',
    '<main>Complete</main>',
    '```',
    '',
    '- item',
    '  - nested',
    '',
    '      ```app',
    '      <main>Still streaming',
  ].join('\n');
  const html = renderToStaticMarkup(
    createElement(Markdown, { autoPlayAppBlocks: true, buildingAppBlocks: true }, source),
  );

  assert.equal(html.match(/<iframe/g)?.length, 1);
  assert.equal(html.match(/>Building interactive app</g)?.length, 1);
});

test('a streaming response keeps the same element types across renders', () => {
  // react-markdown uses each `components` entry as the JSX element type, so a
  // map rebuilt per render makes React remount the whole response on every
  // streamed token: App iframes reload, Mermaid diagrams restart, and anything
  // the reader is interacting with is thrown away.
  const renderMarkdown = (Markdown as unknown as { type: (props: MarkdownProps) => ReactElement })
    .type;
  const childOf = (element: ReactElement) => (element.props as { children: ReactElement }).children;
  const componentsFor = (props: MarkdownProps) => {
    const shell = renderMarkdown(props);
    const tree = childOf(shell);
    const renderedTree = (tree.type as (treeProps: unknown) => ReactElement)(tree.props);
    const markdown = childOf(renderedTree);
    return (markdown.props as { components: Record<string, unknown> }).components;
  };

  const source = '```app\n<main>Live app</main>\n```\n';
  const first = componentsFor({ children: source, autoPlayAppBlocks: true });
  const second = componentsFor({
    children: `${source}\nTrailing prose while the answer streams.`,
    autoPlayAppBlocks: true,
  });

  assert.equal(first, second);
  assert.equal(first.code, second.code);
  assert.equal(first.p, second.p);
  // Spec mode is a different presentation, and so a different stable map.
  assert.notEqual(first, componentsFor({ children: source, specMode: true }));
});

test('copy gracefully declines when the Clipboard API is unavailable', async () => {
  const markdownCode = (await import('./MarkdownCode')) as unknown as {
    copyMarkdownCode?: (
      clipboard: Pick<Clipboard, 'writeText'> | undefined,
      text: string,
    ) => Promise<boolean>;
  };
  assert.equal(await markdownCode.copyMarkdownCode?.(undefined, 'sample'), false);
});

test('small JSON fences keep token highlighting and large ones stay plain', async () => {
  const { JSON_HIGHLIGHT_MAX_CHARS } = await import('./MarkdownCode');
  const small = '```json\n{"accent": true, "count": 3, "name": "droid"}\n```';
  const largeObject = Object.fromEntries(
    Array.from({ length: 1200 }, (_, index) => [`k${String(index)}`, index]),
  );
  const large = `\`\`\`json\n${JSON.stringify(largeObject)}\n\`\`\``;
  assert.ok(JSON.stringify(largeObject).length > JSON_HIGHLIGHT_MAX_CHARS);

  const smallHtml = renderToStaticMarkup(createElement(Markdown, null, small));
  const largeHtml = renderToStaticMarkup(createElement(Markdown, null, large));
  // Keys read by accent, string values by green.
  assert.match(smallHtml, /--droid-accent\)">&quot;accent&quot;/);
  assert.match(smallHtml, /--droid-green\)">&quot;droid&quot;/);
  assert.doesNotMatch(largeHtml, /--droid-green/);
  assert.match(largeHtml, /k1199/);
});

test('GFM task lists render as checkbox rows without bullet markers', () => {
  const html = renderToStaticMarkup(
    createElement(Markdown, null, ['- [x] done', '- [ ] open'].join('\n')),
  );

  assert.match(html, /<input[^>]*type="checkbox"[^>]*checked/);
  assert.match(html, /<li[^>]*list-none/);
  assert.doesNotMatch(html, /<li[^>]*list-disc/);
});

test('breaks mode keeps single newlines from typed text as visible breaks', () => {
  const source = 'first line\nsecond line';
  const render = (breaks: boolean) =>
    renderToStaticMarkup(
      createElement(
        MarkdownTree,
        { specMode: false, fenceOptions: markdownFenceOptions(source, {}), breaks },
        source,
      ),
    );

  assert.match(render(true), /<br\/>/);
  assert.doesNotMatch(render(false), /<br\/>/);
});

// Shortening an arbitrary link would hide where it goes.
test('a bare non-GitHub URL still shows its full address', () => {
  const html = renderToStaticMarkup(
    createElement(Markdown, null, 'see https://techcrunch.com/2026/09/08/muse'),
  );

  assert.match(html, /techcrunch\.com\/2026\/09\/08\/muse<\/span>/);
});
