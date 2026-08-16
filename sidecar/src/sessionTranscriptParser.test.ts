import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSessionLineEvents } from './sessionTranscriptParser.js';
import type { TranscriptEvent } from './protocol.js';

function messageLine(opts: {
  role: string;
  content: unknown[];
  visibility?: string;
  timestamp?: string;
}): string {
  return JSON.stringify({
    type: 'message',
    id: 'm1',
    timestamp: opts.timestamp ?? new Date(1000).toISOString(),
    message: {
      role: opts.role,
      ...(opts.visibility ? { visibility: opts.visibility } : {}),
      content: opts.content,
    },
  });
}

test('a tool_result with missing content is preserved, not dropped', () => {
  // Regression: block.content was undefined, so stringifyToolResult reached
  // safeStringify(undefined) which returned undefined (not a string), made
  // trimText(undefined) throw, and the surrounding try/catch dropped the whole
  // line — losing this tool_result and any sibling events.
  const line = JSON.parse(
    messageLine({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1' }] }),
  );
  const events = parseSessionLineEvents('app', 'provider', 'primary', line);
  const result = events.find((e) => e.kind === 'tool_result');
  assert.ok(result, 'tool_result must survive even with no content body');
  assert.equal(result!.text, '');
  assert.equal(result!.toolUseId, 't1');
});

test('a tool_result with a null JSON literal in its content array is not dropped', () => {
  // A degenerate array element (the literal null) must not crash the parse;
  // the real text block beside it must still surface.
  const line = JSON.parse(
    messageLine({
      role: 'user',
      content: [null, { type: 'tool_result', tool_use_id: 't2', content: 'done' }],
    }),
  );
  const events = parseSessionLineEvents('app', 'provider', 'primary', line);
  const result = events.find((e) => e.kind === 'tool_result') as TranscriptEvent;
  assert.ok(result, 'tool_result must survive a null sibling block');
  assert.equal(result.text, 'done');
});

test('an oversized App answer replays with its fence closed', () => {
  // Regression: message text was capped at the tool-result limit (12k), so a
  // real /visualize answer (25k-35k chars) replayed without the closing fence.
  // After a restart the App rendered its markup with a half-written script:
  // no interactivity, an empty canvas, and nothing the renderer could recover.
  const app = `Here is the lab.\n\n\`\`\`app\n<main data-droidex-app-root>${'<p>chart</p>'.repeat(2_000)}</main>\n\`\`\`\n\nSuggested exercise: set a = 6.`;
  assert.ok(app.length > 12_000 && app.length < 64_000);

  const events = parseSessionLineEvents(
    'app',
    'provider',
    'primary',
    JSON.parse(messageLine({ role: 'assistant', content: [{ type: 'text', text: app }] })),
  );

  assert.equal(events.length, 1);
  assert.equal(events[0].text, app);
  assert.doesNotMatch(events[0].text ?? '', /\[truncated/);
});

test('message text stays bounded and tool output keeps the tighter cap', () => {
  const events = parseSessionLineEvents(
    'app',
    'provider',
    'primary',
    JSON.parse(
      messageLine({
        role: 'assistant',
        content: [{ type: 'text', text: 'x'.repeat(70_000) }],
      }),
    ),
  );
  assert.equal(events[0].text, `${'x'.repeat(64_000)}\n\n[truncated 6000 chars]`);

  const toolEvents = parseSessionLineEvents(
    'app',
    'provider',
    'primary',
    JSON.parse(
      messageLine({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't3', content: 'y'.repeat(13_000) }],
      }),
    ),
  );
  assert.equal(toolEvents[0].text, `${'y'.repeat(12_000)}\n\n[truncated 1000 chars]`);
});

test('llm_only user messages stay hidden (filtering lives in the parser)', () => {
  const visible = parseSessionLineEvents(
    'app',
    'provider',
    'primary',
    JSON.parse(messageLine({ role: 'user', content: [{ type: 'text', text: 'shown' }] })),
  );
  const hidden = parseSessionLineEvents(
    'app',
    'provider',
    'primary',
    JSON.parse(
      messageLine({
        role: 'user',
        visibility: 'llm_only',
        content: [{ type: 'text', text: 'hidden' }],
      }),
    ),
  );
  assert.deepEqual(
    visible.map((e) => e.text),
    ['shown'],
  );
  assert.deepEqual(hidden, []);
});

test('child user prompts replay with child ownership', () => {
  const line = JSON.parse(
    messageLine({ role: 'user', content: [{ type: 'text', text: 'continue the child task' }] }),
  );

  const events = parseSessionLineEvents('app', 'child-provider', 'worker', line);
  assert.deepEqual(
    events.map((event) => ({
      sourceSessionId: event.sourceSessionId,
      role: event.role,
      author: event.author,
      text: event.text,
    })),
    [
      {
        sourceSessionId: 'child-provider',
        role: 'worker',
        author: 'user',
        text: 'continue the child task',
      },
    ],
  );
});

test('app-generation guidance replays as only the concise user command', () => {
  const line = JSON.parse(
    messageLine({
      role: 'user',
      content: [
        {
          type: 'text',
          text: `DROIDEX App request:\n/visualize compare renderer timings\n\nPrivate generation guidance:\nReturn one fenced app block using --app-background.`,
        },
      ],
    }),
  );

  const events = parseSessionLineEvents('app', 'provider', 'primary', line);
  assert.equal(events.length, 1);
  assert.equal(events[0].text, '/visualize compare renderer timings');
  assert.doesNotMatch(events[0].text ?? '', /Private generation guidance/);
});

test('internal skill notifications never replay as user-authored chat', () => {
  const line = JSON.parse(
    messageLine({
      role: 'user',
      content: [
        {
          type: 'text',
          text: ` <system-notification>
Skills provide specialized capabilities and domain knowledge.
<skill filePath="builtin:review">
<name>review</name>
Full private skill instructions
</skill>
</system-notification>`,
        },
      ],
    }),
  );

  assert.deepEqual(parseSessionLineEvents('app', 'provider', 'primary', line), []);
});

test('user-only skill activation restores the prompt and harness acknowledgement separately', () => {
  const line = JSON.parse(
    messageLine({
      role: 'user',
      visibility: 'user_only',
      content: [{ type: 'text', text: 'Skill "review" activated: PR #100' }],
    }),
  );

  const events = parseSessionLineEvents('app', 'provider', 'primary', line);
  assert.equal(events.length, 2);
  assert.deepEqual(
    {
      sourceSessionId: events[0].sourceSessionId,
      author: events[0].author,
      text: events[0].text,
      skills: events[0].skills,
    },
    {
      sourceSessionId: 'user',
      author: 'user',
      text: 'PR #100',
      skills: ['review'],
    },
  );
  assert.deepEqual(
    {
      sourceSessionId: events[1].sourceSessionId,
      author: events[1].author,
      text: events[1].text,
    },
    {
      sourceSessionId: 'primary',
      author: undefined,
      text: 'Skill "review" activated: PR #100',
    },
  );
});

test('child skill activations never replay as primary user prompts', () => {
  const line = JSON.parse(
    messageLine({
      role: 'user',
      visibility: 'user_only',
      content: [{ type: 'text', text: 'Skill "review" activated: child task' }],
    }),
  );

  for (const role of ['worker', 'validator'] as const)
    assert.deepEqual(parseSessionLineEvents('app', 'child-provider', role, line), []);
});

test('a mid-file compaction_state record replays as a divider event', () => {
  const line = JSON.parse(
    JSON.stringify({
      type: 'compaction_state',
      id: 'comp-3',
      timestamp: new Date(2000).toISOString(),
      removedCount: 3,
    }),
  );
  const events = parseSessionLineEvents('app', 'provider', 'primary', line);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'compaction');
  assert.equal(events[0].removedCount, 3);
});
