import assert from 'node:assert/strict';
import test from 'node:test';

import { parseCursorAssistantTextDelta, sessionUpdateIsReplay } from './cursorSessionUpdate.js';

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
