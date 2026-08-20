import assert from 'node:assert/strict';
import test from 'node:test';

import type { PrComment } from '../../../types/vcs';
import { commentPreview, commentStartsFolded, isLongComment, threadStatus } from './prCommentFold';

const comment = (overrides: Partial<PrComment> = {}): PrComment => ({
  id: '1',
  kind: 'inline',
  author: 'ana',
  body: 'looks good',
  createdAt: '2026-08-04T10:00:00Z',
  url: null,
  state: null,
  reactions: [],
  ...overrides,
});

test('a comment counts as long past ten lines or seven hundred characters', () => {
  assert.equal(isLongComment('one line'), false);
  assert.equal(isLongComment('line\n'.repeat(10).trimEnd()), false);
  assert.equal(isLongComment('line\n'.repeat(11).trimEnd()), true);
  assert.equal(isLongComment('x'.repeat(700)), false);
  assert.equal(isLongComment('x'.repeat(701)), true);
});

test('the preview is the first prose line without its markdown markers', () => {
  assert.equal(commentPreview('## Heading\n\nbody'), 'Heading');
  assert.equal(commentPreview('\n\n- **bold** point'), 'bold point');
  assert.equal(commentPreview('> quoted reply'), 'quoted reply');
  assert.equal(commentPreview('1. first step'), 'first step');
});

test('the preview keeps identifiers that contain underscores', () => {
  assert.equal(
    commentPreview('- rename **snake_case** to camelCase'),
    'rename snake_case to camelCase',
  );
});

test('the preview skips fenced code and truncates with an ellipsis', () => {
  assert.equal(commentPreview('```ts\nconst a = 1;\n```\nafter the fence'), 'const a = 1;');
  assert.equal(commentPreview('word '.repeat(60), 20), 'word word word word…');
  assert.equal(commentPreview(''), '');
});

test('resolved threads and long bodies start folded', () => {
  assert.equal(commentStartsFolded(comment({ resolved: true }), 'short'), true);
  assert.equal(commentStartsFolded(comment(), 'line\n'.repeat(20)), true);
  assert.equal(commentStartsFolded(comment({ resolved: false }), 'short'), false);
  assert.equal(commentStartsFolded(comment({ outdated: true }), 'short'), false);
});

test('thread status names who resolved the conversation', () => {
  assert.deepEqual(threadStatus(comment({ resolved: true, resolvedBy: 'rae' })), {
    label: 'Resolved',
    icon: 'check',
    title: 'Resolved by rae',
  });
  assert.equal(
    threadStatus(comment({ resolved: true, resolvedBy: null }))?.title,
    'This conversation is resolved',
  );
  assert.equal(threadStatus(comment({ outdated: true }))?.label, 'Outdated');
  assert.equal(threadStatus(comment()), null);
});

test('the preview skips tilde fence delimiters too', () => {
  assert.equal(commentPreview('~~~ts\nconst a = 1;\n~~~\nafter the fence'), 'const a = 1;');
  assert.equal(commentPreview('~~~\ncode\n~~~'), 'code');
});
