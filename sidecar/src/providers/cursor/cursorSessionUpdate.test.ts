import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CURSOR_TOOL_OUTPUT_MAX_CHARS,
  CURSOR_TOOL_UPDATE_COALESCE_LIMIT,
  CURSOR_TOOL_UPDATE_MIN_DETAIL_GROWTH_CHARS,
  boundToolCallOutputText,
  decideToolCallUpdateEmission,
  ingestCursorToolCallUpdate,
  parseCursorAssistantTextDelta,
  sessionUpdateIsReplay,
  toolNameForAcpKind,
} from './cursorSessionUpdate.js';

test('only agent_message_chunk text becomes assistant text', () => {
  assert.deepEqual(
    parseCursorAssistantTextDelta({
      sessionId: 's1',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } },
    }),
    { text: 'hello' },
  );
  assert.equal(
    parseCursorAssistantTextDelta({
      sessionId: 's1',
      update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'think' } },
    }),
    undefined,
  );
  assert.equal(
    parseCursorAssistantTextDelta({
      sessionId: 's1',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'image', data: 'x' } },
    }),
    undefined,
  );
  assert.equal(
    parseCursorAssistantTextDelta({
      sessionId: 's1',
      update: { sessionUpdate: 'tool_call', toolCallId: 't1' },
    }),
    undefined,
  );
});

test('replayed _meta.isReplay updates are detected', () => {
  const replay = {
    sessionId: 's1',
    _meta: { isReplay: true },
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'old' } },
  };
  assert.equal(sessionUpdateIsReplay(replay), true);
  assert.equal(
    sessionUpdateIsReplay({
      sessionId: 's1',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'live' } },
    }),
    false,
  );
});

test('tool output keeps the 8,000-character tail and drops the head', () => {
  const head = 'HEAD'.repeat(500);
  const tail = 'TAIL'.repeat(2_000);
  const raw = `${head}${tail}`;
  assert.ok(raw.length > CURSOR_TOOL_OUTPUT_MAX_CHARS);
  const bounded = boundToolCallOutputText(raw);
  assert.equal(bounded.includes('HEADHEAD'), false);
  assert.ok(bounded.endsWith(tail.slice(-100)));
  assert.ok(bounded.startsWith('[Earlier output truncated]'));
  assert.ok(bounded.length <= CURSOR_TOOL_OUTPUT_MAX_CHARS + 40);
});

test('tool kinds map to command execution, file change, web search, or dynamic tool call', () => {
  assert.equal(toolNameForAcpKind('execute'), 'command execution');
  assert.equal(toolNameForAcpKind('edit'), 'file change');
  assert.equal(toolNameForAcpKind('delete'), 'file change');
  assert.equal(toolNameForAcpKind('move'), 'file change');
  assert.equal(toolNameForAcpKind('search'), 'web search');
  assert.equal(toolNameForAcpKind('fetch'), 'web search');
  assert.equal(toolNameForAcpKind('think'), 'dynamic tool call');
});

test('coalescing emits on 256-char growth, every 10 suppressed updates, and always on terminal status', () => {
  assert.equal(CURSOR_TOOL_UPDATE_MIN_DETAIL_GROWTH_CHARS, 256);
  assert.equal(CURSOR_TOOL_UPDATE_COALESCE_LIMIT, 10);
  const growth = decideToolCallUpdateEmission({
    previous: { toolCallId: 't', status: 'inProgress', detail: 'x'.repeat(10) },
    next: { toolCallId: 't', status: 'inProgress', detail: 'x'.repeat(10 + 256) },
    lastEmittedDetailLength: 10,
    skippedSinceEmit: 0,
  });
  assert.equal(growth.emit, true);

  const suppressed = decideToolCallUpdateEmission({
    previous: { toolCallId: 't', status: 'inProgress', detail: 'ab' },
    next: { toolCallId: 't', status: 'inProgress', detail: 'abc' },
    lastEmittedDetailLength: 2,
    skippedSinceEmit: 0,
  });
  assert.equal(suppressed.emit, false);
  assert.equal(suppressed.skippedSinceEmit, 1);

  const tenth = decideToolCallUpdateEmission({
    previous: { toolCallId: 't', status: 'inProgress', detail: 'ab' },
    next: { toolCallId: 't', status: 'inProgress', detail: 'abc' },
    lastEmittedDetailLength: 2,
    skippedSinceEmit: 9,
  });
  assert.equal(tenth.emit, true);

  const terminal = decideToolCallUpdateEmission({
    previous: { toolCallId: 't', status: 'inProgress', detail: 'ab' },
    next: { toolCallId: 't', status: 'completed', detail: 'abc' },
    lastEmittedDetailLength: 2,
    skippedSinceEmit: 0,
  });
  assert.equal(terminal.emit, true);

  const states = new Map();
  let emitted = 0;
  for (let index = 0; index < 12; index += 1) {
    const isLast = index === 11;
    const result = ingestCursorToolCallUpdate(states, {
      sessionId: 's1',
      update: {
        sessionUpdate: index === 0 ? 'tool_call' : 'tool_call_update',
        toolCallId: 't1',
        kind: 'execute',
        status: isLast ? 'completed' : 'in_progress',
        content: [{ type: 'content', content: { type: 'text', text: 'x'.repeat(index + 1) } }],
      },
    });
    if (result?.emit) {
      emitted += 1;
    }
  }
  assert.equal(emitted, 3);
});
