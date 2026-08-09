import test from 'node:test';
import assert from 'node:assert/strict';
import { transcriptToMarkdown } from './sessionMarkdown.js';
import type { TranscriptEvent } from './protocol.js';

function ev(overrides: Partial<TranscriptEvent> & Pick<TranscriptEvent, 'kind'>): TranscriptEvent {
  return {
    id: 'e1',
    appSessionId: 'app',
    sourceSessionId: 'primary',
    role: 'primary',
    ts: 1_000,
    ...overrides,
  };
}

const META = {
  title: 'Fix the sidebar',
  providerSessionId: 'droid-abc',
  cwd: '/repo',
  exportedAt: new Date('2026-08-09T12:00:00.000Z'),
};

test('header carries the title, resume hint, directory, and export date', () => {
  const md = transcriptToMarkdown([], META);
  assert.match(md, /^# Fix the sidebar/);
  assert.match(md, /`droid-abc` — resume with `droid -r droid-abc`/);
  assert.match(md, /- \*\*Directory:\*\* `\/repo`/);
  assert.match(md, /- \*\*Exported:\*\* 2026-08-09T12:00:00\.000Z/);
});

test('header omits the directory line when the session has no cwd', () => {
  const md = transcriptToMarkdown([], { ...META, cwd: undefined });
  assert.doesNotMatch(md, /Directory/);
});

test('a meta note renders as a caveat right under the header', () => {
  // The export limit note must sit between the header and the conversation so
  // a truncated export cannot be mistaken for the complete chat.
  const md = transcriptToMarkdown([ev({ kind: 'text', text: 'tail turn' })], {
    ...META,
    note: 'Only the most recent events are included.',
  });
  const headerEnd = md.indexOf('- **Exported:**');
  const note = md.indexOf('> **Note:** Only the most recent events are included.');
  const turn = md.indexOf('## Droid\n\ntail turn');
  assert.ok(headerEnd > -1 && note > headerEnd && turn > note);
});

test('user and assistant text become labeled sections in order', () => {
  const md = transcriptToMarkdown(
    [ev({ kind: 'text', author: 'user', text: 'hello there' }), ev({ kind: 'text', text: 'hi!' })],
    META,
  );
  const user = md.indexOf('## User\n\nhello there');
  const droid = md.indexOf('## Droid\n\nhi!');
  assert.ok(user > -1 && droid > user);
});

test('thinking folds into a details block; status chrome is dropped', () => {
  const md = transcriptToMarkdown(
    [ev({ kind: 'thinking', text: 'hmm' }), ev({ kind: 'status', text: 'Working…' })],
    META,
  );
  assert.match(md, /<details>\n<summary>Thinking<\/summary>\n\nhmm\n\n<\/details>/);
  assert.doesNotMatch(md, /Working…/);
});

test('the oversized-trim status survives as a note so the export is not misstated as complete', () => {
  const md = transcriptToMarkdown(
    [
      ev({
        kind: 'status',
        text: 'Loaded latest 5 MB of this oversized session for UI performance.',
      }),
      ev({ kind: 'text', author: 'user', text: 'tail of the chat' }),
    ],
    META,
  );
  assert.match(md, /> \*\*Note:\*\* Loaded latest 5 MB of this oversized session/);
  assert.match(md, /## User\n\ntail of the chat/);
});

test('tool calls and results are fenced; errors are quoted', () => {
  const md = transcriptToMarkdown(
    [
      ev({ kind: 'tool_call', toolName: 'Execute', toolArgs: { command: 'ls' } }),
      ev({ kind: 'tool_result', toolName: 'Execute', text: 'file.ts' }),
      ev({ kind: 'tool_result', text: 'boom', isError: true }),
      ev({ kind: 'error', text: 'bad thing' }),
    ],
    META,
  );
  assert.match(md, /\*\*Tool: Execute\*\*\n\n```\n\{\n {2}"command": "ls"\n\}\n```/);
  assert.match(md, /\*\*Tool result: Execute\*\*\n\n```\nfile\.ts\n```/);
  assert.match(md, /\*\*Tool error\*\*\n\n```\nboom\n```/);
  assert.match(md, /> \*\*Error:\*\* bad thing/);
});

test('a payload containing code fences gets a longer outer fence', () => {
  const md = transcriptToMarkdown(
    [ev({ kind: 'tool_result', text: 'before\n```ts\ncode\n```\nafter' })],
    META,
  );
  assert.match(md, /````\nbefore\n```ts\ncode\n```\nafter\n````/);
});

test('oversized tool output and thinking are truncated with a marker', () => {
  const md = transcriptToMarkdown(
    [
      ev({ kind: 'tool_result', text: 'x'.repeat(3_000) }),
      ev({ kind: 'thinking', text: 'y'.repeat(5_000) }),
    ],
    META,
  );
  assert.match(md, /\[truncated 1000 chars\]/);
  assert.ok(!md.includes('x'.repeat(2_500)));
  assert.ok(!md.includes('y'.repeat(4_500)));
});

test('compaction becomes a divider with the summarized count', () => {
  const md = transcriptToMarkdown([ev({ kind: 'compaction', removedCount: 42 })], META);
  assert.match(md, /---\n\n\*42 earlier messages were summarized by compaction\.\*/);
});

test('empty transcript exports just the header', () => {
  const md = transcriptToMarkdown([], META);
  assert.equal(
    md
      .trim()
      .split('\n')
      .filter((l) => l.startsWith('##')).length,
    0,
  );
});
