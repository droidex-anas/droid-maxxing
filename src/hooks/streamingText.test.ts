import assert from 'node:assert/strict';
import test from 'node:test';

import { nextRevealedText } from './streamingText';

test('nextRevealedText caps a large burst and keeps surrogate pairs intact', () => {
  const burst = `${'a'.repeat(800)}${String.fromCodePoint(0x1f680)}`;
  const next = nextRevealedText(burst, '');
  assert.equal(next.length, 64);
  assert.equal(next.includes('\uFFFD'), false);

  const emojiStart = 'hello ';
  const withEmoji = `${emojiStart}${String.fromCodePoint(0x1f680)} world`;
  const step = nextRevealedText(withEmoji, emojiStart);
  assert.equal(step.startsWith(emojiStart), true);
  assert.equal(step.includes('\uD83D\uDE80') || step.includes('🚀'), true);
  assert.equal(step.includes('\uFFFD'), false);
});

test('nextRevealedText does not pair a high surrogate with a following BMP unit', () => {
  const unpaired = '\uD83D'.repeat(800);
  const next = nextRevealedText(unpaired, '');
  assert.equal(next.length, 64);

  const mixed = `\uD83Dx${'a'.repeat(800)}`;
  const mixedNext = nextRevealedText(mixed, '');
  assert.equal(mixedNext.startsWith('\uD83Dx'), true);
  assert.equal(mixedNext.length, 64);
});
