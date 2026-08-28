import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TOOL_CALL_CONTENT_MAX_CHARS,
  TOOL_CALL_UPDATE_COALESCE_LIMIT,
  TOOL_CALL_UPDATE_MIN_DETAIL_GROWTH_CHARS,
  boundToolCallOutputText,
  decideToolCallUpdateEmission,
  ingestToolCallUpdate,
  mergeToolCallState,
  parseAssistantTextDelta,
  parseToolCallUpdate,
  sessionUpdateIsReplay,
  toolCallProgressLength,
  toolNameForAcpKind,
  type AcpToolCallState,
} from './acpSessionUpdate.js';

test('only agent_message_chunk text becomes assistant text', () => {
  assert.deepEqual(
    parseAssistantTextDelta({
      sessionId: 's1',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } },
    }),
    { text: 'hello' },
  );
  assert.equal(
    parseAssistantTextDelta({
      sessionId: 's1',
      update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'think' } },
    }),
    undefined,
  );
  assert.equal(
    parseAssistantTextDelta({
      sessionId: 's1',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'image', data: 'x' } },
    }),
    undefined,
  );
  assert.equal(
    parseAssistantTextDelta({
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
  assert.ok(raw.length > TOOL_CALL_CONTENT_MAX_CHARS);
  const bounded = boundToolCallOutputText(raw);
  assert.equal(bounded.includes('HEADHEAD'), false);
  assert.ok(bounded.endsWith(tail.slice(-100)));
  assert.ok(bounded.startsWith('[Earlier output truncated]'));
  assert.ok(bounded.length <= TOOL_CALL_CONTENT_MAX_CHARS + 40);
  const parsed = parseToolCallUpdate({
    sessionId: 's1',
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
      title: 'Terminal',
      kind: 'execute',
      rawInput: { command: 'npm test' },
      content: [{ type: 'content', content: { type: 'text', text: raw } }],
    },
  });
  assert.ok(parsed);
  assert.equal(parsed?.command, 'npm test');
  assert.equal(typeof parsed?.data?.content, 'object');
  assert.equal(parsed?.detail?.startsWith('[Earlier output truncated]'), true);
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
  assert.equal(TOOL_CALL_UPDATE_MIN_DETAIL_GROWTH_CHARS, 256);
  assert.equal(TOOL_CALL_UPDATE_COALESCE_LIMIT, 10);
  const growth = decideToolCallUpdateEmission({
    previous: { toolCallId: 't', status: 'inProgress', detail: 'x'.repeat(10), data: {} },
    next: { toolCallId: 't', status: 'inProgress', detail: 'x'.repeat(10 + 256), data: {} },
    lastEmittedDetailLength: 10,
    skippedSinceEmit: 0,
  });
  assert.equal(growth.emit, true);

  const suppressed = decideToolCallUpdateEmission({
    previous: { toolCallId: 't', status: 'inProgress', detail: 'ab', data: {} },
    next: { toolCallId: 't', status: 'inProgress', detail: 'abc', data: {} },
    lastEmittedDetailLength: 2,
    skippedSinceEmit: 0,
  });
  assert.equal(suppressed.emit, false);
  assert.equal(suppressed.skippedSinceEmit, 1);

  const tenth = decideToolCallUpdateEmission({
    previous: { toolCallId: 't', status: 'inProgress', detail: 'ab', data: {} },
    next: { toolCallId: 't', status: 'inProgress', detail: 'abc', data: {} },
    lastEmittedDetailLength: 2,
    skippedSinceEmit: 9,
  });
  assert.equal(tenth.emit, true);

  const terminal = decideToolCallUpdateEmission({
    previous: { toolCallId: 't', status: 'inProgress', detail: 'ab', data: {} },
    next: { toolCallId: 't', status: 'completed', detail: 'abc', data: {} },
    lastEmittedDetailLength: 2,
    skippedSinceEmit: 0,
  });
  assert.equal(terminal.emit, true);

  const states = new Map();
  let emitted = 0;
  for (let index = 0; index < 12; index += 1) {
    const isLast = index === 11;
    const result = ingestToolCallUpdate(states, {
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

test('mergeToolCallState keeps earlier kind/title when a delta omits them', () => {
  const merged = mergeToolCallState(
    {
      toolCallId: 't1',
      kind: 'execute',
      title: 'Run tests',
      status: 'pending',
      data: { toolCallId: 't1', kind: 'execute' },
    },
    {
      toolCallId: 't1',
      status: 'inProgress',
      data: { toolCallId: 't1', rawOutput: { stdout: 'ok' } },
    },
  );
  assert.equal(merged.kind, 'execute');
  assert.equal(merged.title, 'Run tests');
  assert.equal(merged.status, 'inProgress');
});

test('toolCallProgressLength measures detail, content, and rawOutput', () => {
  const state: AcpToolCallState = {
    toolCallId: 't1',
    detail: 'short',
    data: { content: [{ type: 'content', content: { type: 'text', text: 'x'.repeat(40) } }] },
  };
  assert.equal(toolCallProgressLength(state), 40);
});
