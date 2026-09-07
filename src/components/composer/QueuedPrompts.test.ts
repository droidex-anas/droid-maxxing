import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueuedPrompts } from './QueuedPrompts';
import type { QueuedPrompt } from '../../hooks/useStore';

const prompt = (overrides: Partial<QueuedPrompt> = {}): QueuedPrompt => ({
  id: 'q1',
  text: 'Fix the login redirect',
  skills: [],
  files: [],
  ...overrides,
});

const render = (queue: QueuedPrompt[]) =>
  renderToStaticMarkup(
    createElement(QueuedPrompts, {
      queue,
      onReorder: () => undefined,
      onEdit: () => undefined,
      onRemove: () => undefined,
    }),
  );

test('renders nothing without queued prompts', () => {
  assert.equal(render([]), '');
});

test('a long prompt is collapsed to a clamped preview', () => {
  const text = `${'Refactor the composer '.repeat(20)}\n\nthen ship it`;
  const html = render([prompt({ text })]);
  assert.match(html, /line-clamp-2/);
  assert.match(html, /…/);
  // Neither the tail of the prompt nor its paragraph break reaches the row.
  assert.doesNotMatch(html, /then ship it/);
  assert.doesNotMatch(html, /whitespace-pre-wrap/);
});

test('one queued image renders a thumbnail without a count badge', () => {
  const html = render([prompt({ files: ['/tmp/attach/paste-1.png', '/src/index.ts'] })]);
  assert.match(html, /<img src="droidex-img:\/\/local\/\?p=%2Ftmp%2Fattach%2Fpaste-1\.png"/);
  assert.doesNotMatch(html, /text-\[8px\]/);
});

test('several queued images collapse to one thumbnail with a count badge', () => {
  const html = render([
    prompt({ files: ['/tmp/a.png', '/tmp/b.png', '/tmp/c.jpeg', '/notes.md'] }),
  ]);
  assert.equal(html.match(/<img src="droidex-img:\/\/local/g)?.length, 1);
  assert.match(html, /<img src="droidex-img:\/\/local\/\?p=%2Ftmp%2Fa\.png"/);
  assert.match(html, /text-\[8px\][^>]*">3</);
});

test('a queued non-image file renders a FileChip', () => {
  const html = render([prompt({ files: ['/tmp/notes.pdf'] })]);
  assert.match(html, /notes\.pdf/);
  assert.match(html, />PDF</);
  assert.doesNotMatch(html, /droidex-img/);
});

test('queued mixed attachments keep paste order', () => {
  const html = render([
    prompt({ files: ['/tmp/notes.pdf', '/tmp/a.png', '/tmp/b.png', '/tmp/spec.md'] }),
  ]);
  // React 19 also emits a preload <link> for the thumbnail, so order is the
  // chip titles and the real <img>, not the first droidex-img string.
  const pdf = html.indexOf('title="notes.pdf"');
  const img = html.indexOf('<img src="droidex-img');
  const spec = html.indexOf('title="spec.md"');
  assert.ok(pdf >= 0 && img >= 0 && spec >= 0);
  assert.ok(pdf < img && img < spec);
  assert.equal(html.match(/<img src="droidex-img:\/\/local/g)?.length, 1);
  assert.match(html, /text-\[8px\][^>]*">2</);
});

test('queued duplicate native paths still render two chips', () => {
  const html = render([prompt({ files: ['/tmp/notes.pdf', '/tmp/notes.pdf'] })]);
  assert.equal(html.split('>PDF<').length - 1, 2);
});
