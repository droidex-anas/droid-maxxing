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

test('a prompt with no images shows no thumbnail', () => {
  const html = render([prompt({ files: ['/src/index.ts'] })]);
  assert.doesNotMatch(html, /droidex-img/);
});
