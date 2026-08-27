import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { Markdown } from './Markdown';
import { StreamingMarkdown } from './StreamingMarkdown';
import { ingestStreamingMarkdown, type StreamingDocument } from '../lib/streamingMarkdown';

function canonical(source: string, extra: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(createElement(Markdown, extra, source));
}

function settled(source: string, extra: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(
    createElement(StreamingMarkdown, { source, live: false, cacheId: 'fixture', ...extra }),
  );
}

function streaming(source: string, extra: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(
    createElement(StreamingMarkdown, { source, live: true, cacheId: 'fixture', ...extra }),
  );
}

function assertSettledMatchesCanonical(source: string, extra: Record<string, unknown> = {}): void {
  assert.equal(settled(source, extra), canonical(source, extra));
}

function assertCompletedBlocksStable(full: string): void {
  let previous: { source: string; document: StreamingDocument } | null = null;
  const seen = new Map<string, string>();
  const checkpoints: Array<{ index: number; ids: string[] }> = [];
  for (let index = 1; index <= full.length; index += 1) {
    const source = full.slice(0, index);
    const { document } = ingestStreamingMarkdown(previous, source);
    let frozenGrew = false;
    for (const block of document.completedBlocks) {
      const prior = seen.get(block.id);
      if (prior !== undefined) {
        assert.ok(
          block.source.startsWith(prior) && /^\s*$/.test(block.source.slice(prior.length)),
          'frozen block source may only grow by trailing whitespace',
        );
        seen.set(block.id, block.source);
      } else {
        seen.set(block.id, block.source);
        frozenGrew = true;
      }
    }
    if (frozenGrew || index === full.length) {
      checkpoints.push({ index, ids: [...seen.keys()] });
    }
    previous = { source, document };
  }
  for (const checkpoint of checkpoints) {
    const html = streaming(full.slice(0, checkpoint.index));
    for (const id of checkpoint.ids) {
      assert.match(html, new RegExp(`data-stream-block="${id}"`));
    }
  }
}

const PARAGRAPHS = ['First paragraph.', '', 'Second paragraph.', '', 'Third stays open'].join('\n');

const LISTS = ['- alpha', '- beta', '', '# After list', '', 'Tail'].join('\n');

const TABLE = ['| a | b |', '| --- | --- |', '| 1 | 2 |', '', 'Done.'].join('\n');

const NESTED_FENCE = [
  '````markdown',
  '```js',
  'const nested = true;',
  '```',
  '````',
  '',
  'After',
].join('\n');

const HUGE_CODE = [
  'Intro.',
  '',
  '```js',
  `${'const x = 1;\n'.repeat(80)}`,
  '```',
  '',
  'Outro.',
].join('\n');

const MERMAID = ['```mermaid', 'flowchart LR', '  A --> B', '```', '', 'Caption'].join('\n');

const KATEX_APP = [
  '```app',
  '<main data-droidex-app-root>E = mc^2</main>',
  '```',
  '',
  'Done.',
].join('\n');

const APP_BLOCK = ['```app', '<main>Complete app</main>', '```'].join('\n');

const MALFORMED = ['Hello', '', '```js', 'const incomplete = '].join('\n');

test('settled paragraphs match the canonical renderer', () => {
  assertSettledMatchesCanonical(`${PARAGRAPHS}\n\n`);
});

test('settled lists and tables match the canonical renderer', () => {
  assertSettledMatchesCanonical(`${LISTS}\n\n`);
  assertSettledMatchesCanonical(`${TABLE}\n\n`);
});

test('settled nested fences match the canonical renderer', () => {
  assertSettledMatchesCanonical(`${NESTED_FENCE}\n\n`);
});

test('settled huge code blocks match the canonical renderer', () => {
  assertSettledMatchesCanonical(`${HUGE_CODE}\n\n`);
});

test('settled mermaid, katex-in-app, and app blocks match the canonical renderer', () => {
  assertSettledMatchesCanonical(`${MERMAID}\n\n`);
  assertSettledMatchesCanonical(`${KATEX_APP}\n\n`);
  assertSettledMatchesCanonical(APP_BLOCK);
});

test('settled cut-off app fences match the canonical renderer', () => {
  const source = '```app\n<main>partial';
  assertSettledMatchesCanonical(source, { cutOffAppBlocks: true });
});

test('malformed and incomplete mid-stream blocks stay pending without rewriting frozen prose', () => {
  const html = streaming(`${MALFORMED}\n`);
  assert.match(html, /Hello/);
  assert.match(html, /data-stream-block="b:0"/);
  assert.match(html, /const incomplete = /);
  assert.doesNotMatch(html, /<iframe/i);
});

test('streaming states never remove or rewrite completed blocks', () => {
  assertCompletedBlocksStable(`${HUGE_CODE}\nStill growing`);
  assertCompletedBlocksStable(`${LISTS}\n\n`);
  assertCompletedBlocksStable(`${TABLE}\n\n`);
  assertCompletedBlocksStable(`${NESTED_FENCE}\n\n`);
  assertCompletedBlocksStable(`${MERMAID}\n\n`);
});

test('streaming to settled keeps frozen prose and matches canonical output', () => {
  const live = 'Intro paragraph.\n\n```js\nconst x = 1;\n';
  const liveHtml = streaming(live);
  assert.match(liveHtml, /Intro paragraph/);
  assert.match(liveHtml, /data-stream-block="b:0"/);

  const finalSource = `${live}\`\`\`\n\nDone.\n`;
  assertSettledMatchesCanonical(finalSource);
  const settledHtml = settled(finalSource);
  assert.match(settledHtml, /Intro paragraph/);
  assert.match(settledHtml, /const x = 1;/);
  assert.match(settledHtml, /Done/);
});

test('an open code fence streams as preformatted text without mermaid or app runtime', () => {
  const mermaidOpen = streaming('```mermaid\nflowchart LR\n  A --> B\n');
  assert.match(mermaidOpen, /flowchart LR/);
  assert.doesNotMatch(mermaidOpen, /Diagram/);

  const appOpen = streaming('```app\n<main>still', { buildingAppBlocks: true });
  assert.match(appOpen, /Building interactive app/);
  assert.doesNotMatch(appOpen, /<iframe/i);
});
