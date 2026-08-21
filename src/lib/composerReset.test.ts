import assert from 'node:assert/strict';
import test from 'node:test';
import { composerTextAfterSeed, resetComposerAfterSubmit } from './composerReset';

test('a fresh-chat composer seed replaces stale mounted input', () => {
  assert.equal(
    composerTextAfterSeed('old draft', '/review Pull request #129', true),
    '/review Pull request #129',
  );
});

test('an ordinary composer seed still appends to an active draft', () => {
  assert.equal(
    composerTextAfterSeed('keep this  ', 'add this note', false),
    'keep this\n\nadd this note',
  );
  assert.equal(composerTextAfterSeed('   ', 'start here', false), 'start here');
});

test('resetComposerAfterSubmit clears images and the draft when untouched', () => {
  const calls: string[] = [];
  resetComposerAfterSubmit({
    draftUntouched: true,
    clearImages: () => calls.push('images'),
    resetDraft: () => calls.push('draft'),
  });
  assert.deepEqual(calls, ['images', 'draft']);
});

test('resetComposerAfterSubmit keeps draft edits made while images encoded', () => {
  // Regression: the submit path snapshots the composer before awaiting
  // in-flight image encodes; typing or staging during that wait must survive
  // the submit, or the user's in-progress next prompt is silently wiped.
  // Images still clear — they already made it into the sent prompt.
  const calls: string[] = [];
  resetComposerAfterSubmit({
    draftUntouched: false,
    clearImages: () => calls.push('images'),
    resetDraft: () => calls.push('draft'),
  });
  assert.deepEqual(calls, ['images']);
});
