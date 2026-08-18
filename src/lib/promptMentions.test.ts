import test from 'node:test';
import assert from 'node:assert/strict';
import { composePrompt } from './composePrompt';
import { splitTrailingMentions, userMessageAttachments } from './promptMentions';

test('splitTrailingMentions recovers the mention block composePrompt appended', () => {
  const composed = composePrompt('look at this', [], ['/tmp/a.png', 'src/b.ts']);
  assert.deepEqual(splitTrailingMentions(composed), {
    text: 'look at this',
    files: ['/tmp/a.png', 'src/b.ts'],
  });
});

test('splitTrailingMentions keeps prose that merely contains an @word', () => {
  const text = 'ping @anas about this\n\nand also check the @ sign handling';
  assert.deepEqual(splitTrailingMentions(text), { text, files: [] });
});

test('splitTrailingMentions handles a prompt that is only attachments', () => {
  const composed = composePrompt('', [], ['/tmp/a.png']);
  assert.deepEqual(splitTrailingMentions(composed), { text: '', files: ['/tmp/a.png'] });
});

test('userMessageAttachments prefers event metadata over parsing', () => {
  assert.deepEqual(userMessageAttachments('look at this', ['/tmp/a.png']), {
    text: 'look at this',
    files: ['/tmp/a.png'],
  });
});

test('userMessageAttachments parses a replayed message that has no metadata', () => {
  const composed = composePrompt('what is wrong here', [], ['/tmp/paste-1.png']);
  assert.deepEqual(userMessageAttachments(composed, undefined), {
    text: 'what is wrong here',
    files: ['/tmp/paste-1.png'],
  });
});

test('userMessageAttachments keeps the skill invocation with the message text', () => {
  const composed = composePrompt('fix the bug', ['debugger'], ['/tmp/paste-1.png']);
  assert.deepEqual(userMessageAttachments(composed, []), {
    text: '/debugger fix the bug',
    files: ['/tmp/paste-1.png'],
  });
});

test('userMessageAttachments declines text this app did not compose', () => {
  // Mentions separated by newlines instead of the single spaces composePrompt
  // emits: not our format, so the text is left exactly as persisted.
  const text = 'see these\n\n@/tmp/a.png\n@/tmp/b.png';
  assert.deepEqual(userMessageAttachments(text, undefined), { text, files: [] });
});
