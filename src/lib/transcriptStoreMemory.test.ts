import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, type AppState } from '../hooks/useStore';
import type { TranscriptEvent } from '../types/bridge';
import { appendTranscriptEvent, appendTranscriptEvents } from './transcriptStoreMemory';

function transcriptEvent(
  id: string,
  appSessionId: string,
  overrides: Partial<TranscriptEvent> = {},
): TranscriptEvent {
  return {
    id,
    appSessionId,
    sourceSessionId: 'primary',
    role: 'primary',
    kind: 'text',
    author: 'assistant',
    text: id,
    ts: 1,
    ...overrides,
  };
}

test('batched transcript appends preserve exact sequential behavior', () => {
  const firstText = transcriptEvent('text-1', 'session-a', { author: undefined, text: 'A' });
  const firstToolCall = transcriptEvent('tool-1', 'session-a', {
    author: undefined,
    kind: 'tool_call',
    toolUseId: 'tool-use-1',
    toolName: 'Read',
    toolArgs: { path: '/first' },
  });
  const state: AppState = {
    ...initialState,
    transcripts: { 'session-a': [firstText, firstToolCall] },
    transcriptRetainedCost: {},
  };
  const events: TranscriptEvent[] = [
    firstText,
    transcriptEvent('tool-part-2', 'session-a', {
      author: undefined,
      kind: 'tool_call',
      toolUseId: 'tool-use-1',
      toolArgs: { line: 12 },
      ts: 2,
    }),
    transcriptEvent('text-2', 'session-a', { author: undefined, text: 'B', ts: 3 }),
    transcriptEvent('session-b-1', 'session-b', { text: 'background', ts: 4 }),
    transcriptEvent('child-1', 'session-a', {
      sourceSessionId: 'child-a',
      role: 'worker',
      text: 'child output',
      ts: 5,
    }),
  ];

  const sequential = events.reduce(appendTranscriptEvent, state);
  const batched = appendTranscriptEvents(state, events);

  assert.deepEqual(
    { ...batched, transcriptMutations: {} },
    { ...sequential, transcriptMutations: {} },
  );
  assert.deepEqual(batched.transcriptMutations, {
    'session-a': {
      revision: 1,
      baseRevision: 0,
      kind: 'append',
      previousLength: 2,
      firstChangedIndex: 1,
    },
    'session-b': {
      revision: 1,
      baseRevision: 0,
      kind: 'append',
      previousLength: 0,
      firstChangedIndex: 0,
    },
  });
});

test('duplicate transcript events preserve state and mutation revision', () => {
  const retained = transcriptEvent('retained', 'session-a');
  const state = appendTranscriptEvent(initialState, retained);

  assert.equal(appendTranscriptEvent(state, retained), state);
  assert.equal(appendTranscriptEvents(state, [retained, retained]), state);
});

test('batched transcript appends index retained event IDs once per session', () => {
  let retainedIdReads = 0;
  const retained = Array.from({ length: 2_000 }, (_, index) => {
    const event = transcriptEvent(`retained-${index}`, 'session-a', { ts: index });
    Object.defineProperty(event, 'id', {
      configurable: true,
      enumerable: true,
      get: () => {
        retainedIdReads += 1;
        return `retained-${index}`;
      },
    });
    return event;
  });
  const state: AppState = {
    ...initialState,
    transcripts: { 'session-a': retained },
    // The retained-cost owner already measured this window. Supplying it keeps
    // this test focused on duplicate indexing rather than payload estimation.
    transcriptRetainedCost: { 'session-a': 1 },
  };
  const incoming = Array.from({ length: 200 }, (_, index) =>
    transcriptEvent(`incoming-${index}`, 'session-a', { ts: 2_000 + index }),
  );

  appendTranscriptEvents(state, incoming);

  assert.equal(retainedIdReads, retained.length);
});

test('batched transcript appends preserve sequential emergency release boundaries', () => {
  const retained = Array.from({ length: 30_000 }, (_, index) =>
    transcriptEvent(`retained-${index}`, 'session-a', { ts: index }),
  );
  const state: AppState = {
    ...initialState,
    transcripts: { 'session-a': retained },
    transcriptRetainedCost: { 'session-a': 1 },
  };
  const incoming = [
    transcriptEvent('incoming-1', 'session-a', { ts: 30_000 }),
    transcriptEvent('incoming-2', 'session-a', { ts: 30_001 }),
  ];

  const sequential = incoming.reduce(appendTranscriptEvent, state);
  const batched = appendTranscriptEvents(state, incoming);

  assert.deepEqual(batched, sequential);
  assert.equal(batched.transcripts['session-a'].length, 1_201);
  assert.equal(batched.transcripts['session-a'].at(-1)?.id, 'incoming-2');
});
