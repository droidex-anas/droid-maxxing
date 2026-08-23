import test from 'node:test';
import assert from 'node:assert/strict';
import { QUEUED_PREVIEW_MAX_CHARS, queuedPromptPreview } from './queuedPromptPreview';

test('short prompts survive untouched', () => {
  assert.equal(queuedPromptPreview('Fix the login redirect'), 'Fix the login redirect');
});

test('newlines and whitespace runs collapse to single spaces', () => {
  assert.equal(
    queuedPromptPreview('Fix the bug\n\n  then   add a test\n'),
    'Fix the bug then add a test',
  );
});

test('a long prompt is cut at a nearby word boundary with an ellipsis', () => {
  const preview = queuedPromptPreview('word '.repeat(60), 20);
  assert.equal(preview, 'word word word word…');
});

test('a long unbroken run is cut at the limit', () => {
  const preview = queuedPromptPreview('x'.repeat(200), 20);
  assert.equal(preview, `${'x'.repeat(20)}…`);
});

test('the default limit keeps a queued row to roughly two lines', () => {
  const preview = queuedPromptPreview('a'.repeat(500));
  assert.equal(preview.length, QUEUED_PREVIEW_MAX_CHARS + 1);
});
