import assert from 'node:assert/strict';
import test from 'node:test';

import {
  completedSourceOf,
  freezeCompletedPrefix,
  ingestStreamingMarkdown,
  type StreamingBlock,
  type StreamingDocument,
} from './streamingMarkdown';

function sources(document: StreamingDocument): string[] {
  return document.completedBlocks.map((block) => block.source);
}

function kinds(document: StreamingDocument): string[] {
  return document.completedBlocks.map((block) => block.kind);
}

function assertFrozenPrefixStable(full: string): void {
  let previous: { source: string; document: StreamingDocument } | null = null;
  let frozen: StreamingBlock[] = [];
  for (let index = 1; index <= full.length; index += 1) {
    const source = full.slice(0, index);
    const { document } = ingestStreamingMarkdown(previous, source);
    for (let blockIndex = 0; blockIndex < frozen.length; blockIndex += 1) {
      const prior = frozen[blockIndex];
      const next = document.completedBlocks[blockIndex];
      assert.ok(next, `completed block ${String(blockIndex)} disappeared at ${String(index)}`);
      assert.equal(next.id, prior?.id);
      assert.equal(next.kind, prior?.kind);
      assert.ok(
        next.source.startsWith(prior?.source ?? '') &&
          /^\s*$/.test(next.source.slice(prior?.source.length ?? 0)),
        'frozen block source may only grow by trailing whitespace',
      );
    }
    frozen = [...document.completedBlocks];
    previous = { source, document };
    assert.equal(completedSourceOf(document) + document.pendingSource, source);
  }
}

test('paragraphs freeze only after a terminating blank line', () => {
  const open = freezeCompletedPrefix('Hello world\n');
  assert.deepEqual(open.completedBlocks, []);
  assert.equal(open.pendingKind, 'paragraph');
  assert.equal(open.pendingSource, 'Hello world\n');

  const closed = freezeCompletedPrefix('Hello world\n\n');
  assert.deepEqual(kinds(closed), ['paragraph']);
  assert.equal(closed.pendingSource, '');
  assert.equal(closed.completedBlocks[0]?.source, 'Hello world\n\n');
});

test('a later paragraph does not rewrite an already-frozen one', () => {
  const first = freezeCompletedPrefix('Alpha\n\nBeta');
  assert.deepEqual(sources(first), ['Alpha\n\n']);
  assert.equal(first.pendingSource, 'Beta');

  const second = ingestStreamingMarkdown(
    { source: 'Alpha\n\nBeta', document: first },
    'Alpha\n\nBeta still growing\n',
  );
  assert.equal(second.document.completedBlocks[0]?.source, 'Alpha\n\n');
  assert.equal(second.document.pendingSource, 'Beta still growing\n');
  assert.equal(second.stats.usedIncremental, true);
});

test('lists stay pending until an interrupting block appears', () => {
  const growing = freezeCompletedPrefix('- one\n- two\n');
  assert.equal(growing.pendingKind, 'list');
  assert.deepEqual(growing.completedBlocks, []);

  const interrupted = freezeCompletedPrefix('- one\n- two\n\n# Next\n');
  assert.deepEqual(kinds(interrupted), ['list', 'heading']);
  assert.equal(interrupted.completedBlocks[0]?.source, '- one\n- two\n\n');
  assert.equal(interrupted.pendingSource, '');
});

test('a fence opened inside a list keeps the whole list pending', () => {
  const source = ['- item', '  ```js', '  const x = 1'].join('\n');
  const document = freezeCompletedPrefix(`${source}\n`);
  assert.equal(document.pendingKind, 'list');
  assert.deepEqual(document.completedBlocks, []);
  assert.equal(document.pendingSource.startsWith('- item\n'), true);
});

test('a closed fence inside a list still waits for the list to end', () => {
  const source = ['- item', '  ```js', '  const x = 1', '  ```', ''].join('\n');
  const document = freezeCompletedPrefix(source);
  assert.deepEqual(document.completedBlocks, []);
  assert.equal(document.pendingKind, 'list');
});

test('nested longer outer fences do not close on a shorter inner run', () => {
  const source = ['````outer', '```inner', 'still in outer', '```', '````', '', 'After\n\n'].join(
    '\n',
  );
  const document = freezeCompletedPrefix(source);
  assert.equal(document.completedBlocks[0]?.kind, 'fence');
  assert.equal(document.completedBlocks[0]?.fenceInfo, 'outer');
  assert.equal(document.completedBlocks[0]?.source.includes('```inner'), true);
  assert.equal(document.completedBlocks[1]?.kind, 'paragraph');
});

test('an unclosed fence remains pending and preserves prior blocks', () => {
  const source = ['Done paragraph.', '', '```js', 'const growing = 1'].join('\n');
  const document = freezeCompletedPrefix(`${source}\n`);
  assert.deepEqual(kinds(document), ['paragraph']);
  assert.equal(document.pendingKind, 'fence');
  assert.equal(document.pendingFenceInfo, 'js');
  assert.equal(document.pendingSource.startsWith('```js\n'), true);
});

test('a table with an incomplete trailing row stays pending', () => {
  const source = ['| a | b |', '| --- | --- |', '| 1 |'].join('\n');
  const document = freezeCompletedPrefix(`${source}\n`);
  assert.deepEqual(document.completedBlocks, []);
  assert.equal(document.pendingKind, 'table');
});

test('a complete table freezes once a following heading interrupts it', () => {
  const source = ['| a | b |', '| --- | --- |', '| 1 | 2 |', '', '# Next', ''].join('\n');
  const document = freezeCompletedPrefix(source);
  assert.deepEqual(kinds(document), ['table', 'heading']);
  assert.equal(document.pendingSource, '');
});

test('CRLF line endings freeze at the same boundaries as LF', () => {
  const lf = freezeCompletedPrefix('Hello\n\n```js\nconst x = 1\n```\n\n');
  const crlf = freezeCompletedPrefix('Hello\r\n\r\n```js\r\nconst x = 1\r\n```\r\n\r\n');
  assert.deepEqual(kinds(lf), kinds(crlf));
  assert.equal(crlf.completedBlocks[0]?.source.includes('\r\n'), true);
  assert.equal(completedSourceOf(crlf), 'Hello\r\n\r\n```js\r\nconst x = 1\r\n```\r\n\r\n');
});

test('append-only ingest scans only the pending suffix', () => {
  const closed = 'Intro paragraph.\n\n';
  const first = ingestStreamingMarkdown(null, closed);
  const growing = `${closed}\`\`\`js\n${'const x = 1;\n'.repeat(20)}`;
  const second = ingestStreamingMarkdown({ source: closed, document: first.document }, growing);
  assert.equal(second.stats.usedIncremental, true);
  assert.equal(second.stats.scannedChars, growing.length - closed.length);
  assert.equal(second.document.pendingKind, 'fence');
  assert.equal(second.document.completedBlocks.length, 1);
});

test('streaming tokens never remove or rewrite frozen blocks', () => {
  const full = [
    'First paragraph.',
    '',
    '- list item',
    '- still listing',
    '',
    '# Heading',
    '',
    '```js',
    'const frozen = true;',
    '```',
    '',
    '| a | b |',
    '| --- | --- |',
    '| 1 | 2 |',
    '',
    'Tail paragraph that is still growing',
  ].join('\n');
  assertFrozenPrefixStable(`${full}\n`);
});

test('math-like dollar fences stay in pending until a blank line proves the paragraph closed', () => {
  const open = freezeCompletedPrefix('Energy $E = mc^2$ is still\n');
  assert.equal(open.pendingKind, 'paragraph');
  const closed = freezeCompletedPrefix('Energy $E = mc^2$ is done.\n\n');
  assert.equal(closed.completedBlocks[0]?.kind, 'paragraph');
});
