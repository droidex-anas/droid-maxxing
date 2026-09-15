import test from 'node:test';
import assert from 'node:assert/strict';
import type { TranscriptEvent } from '../types/bridge';
import {
  ingestTranscriptEvents,
  firstUserTranscriptEvent,
  normalizeTranscriptUpdate,
} from './transcriptIngestion';
import { estimateTranscriptCost } from './transcriptWindow';

function transcriptEvent(id: string, overrides: Partial<TranscriptEvent> = {}): TranscriptEvent {
  return {
    id,
    appSessionId: 'session-a',
    sourceSessionId: 'primary',
    role: 'primary',
    kind: 'text',
    author: 'assistant',
    text: id,
    ts: 1,
    ...overrides,
  };
}

test('ingestion preserves literal text-delta dedupe and retained identity semantics', () => {
  const retained = transcriptEvent('retained', { author: undefined, text: 'A' });
  const repeatedDelta = transcriptEvent('delta', {
    author: undefined,
    text: 'B',
    ts: 2,
  });

  const result = ingestTranscriptEvents([retained], estimateTranscriptCost([retained]), [
    retained,
    repeatedDelta,
    repeatedDelta,
  ]);

  assert.deepEqual(result.change, {
    kind: 'append',
    previousLength: 1,
    firstChangedIndex: 0,
  });
  assert.deepEqual(result.events, [
    {
      ...retained,
      text: 'ABB',
      endTs: 2,
    },
  ]);
  assert.equal(result.estimatedCost, estimateTranscriptCost(result.events));
});

test('ingestion reports the first changed index and leaves duplicate-only runs untouched', () => {
  const retained = [transcriptEvent('retained-1'), transcriptEvent('retained-2')];
  const appended = transcriptEvent('appended', { ts: 3 });

  const changed = ingestTranscriptEvents(retained, estimateTranscriptCost(retained), [
    retained[0],
    appended,
  ]);
  const unchanged = ingestTranscriptEvents(retained, estimateTranscriptCost(retained), retained);

  assert.deepEqual(changed.change, {
    kind: 'append',
    previousLength: 2,
    firstChangedIndex: 2,
  });
  assert.equal(unchanged.change, null);
  assert.equal(unchanged.events, retained);
});

test('ingestion merges one streamed tool call and keeps distinct calls separate', () => {
  const retained = transcriptEvent('tool-call', {
    author: undefined,
    kind: 'tool_call',
    text: undefined,
    toolUseId: 'tool-use-1',
    toolName: 'Read',
    toolArgs: { path: '/tmp/file' },
  });
  const partial = transcriptEvent('tool-partial', {
    author: undefined,
    kind: 'tool_call',
    text: undefined,
    toolUseId: 'tool-use-1',
    toolArgs: { line: 12 },
    ts: 2,
  });
  const distinct = transcriptEvent('tool-call-2', {
    author: undefined,
    kind: 'tool_call',
    text: undefined,
    toolUseId: 'tool-use-2',
    toolName: 'Read',
    toolArgs: { path: '/tmp/other' },
    ts: 3,
  });

  const result = ingestTranscriptEvents([retained], estimateTranscriptCost([retained]), [
    partial,
    distinct,
  ]);

  assert.deepEqual(result.events, [
    {
      ...retained,
      toolArgs: { path: '/tmp/file', line: 12 },
      endTs: 2,
    },
    distinct,
  ]);
  assert.deepEqual(result.change, {
    kind: 'append',
    previousLength: 1,
    firstChangedIndex: 0,
  });
  assert.equal(result.estimatedCost, estimateTranscriptCost(result.events));
});

test('interleaved snapshots of parallel tool calls merge by id instead of duplicating', () => {
  const callA1 = transcriptEvent('call-a-1', {
    author: undefined,
    kind: 'tool_call',
    text: undefined,
    toolUseId: 'tool-use-a',
    toolName: 'Bash',
    toolArgs: { command: 'git branch' },
  });
  const callB1 = transcriptEvent('call-b-1', {
    author: undefined,
    kind: 'tool_call',
    text: undefined,
    toolUseId: 'tool-use-b',
    toolName: 'Read',
    toolArgs: { path: '/tmp/file' },
    ts: 2,
  });
  const thought = transcriptEvent('thought', {
    author: undefined,
    kind: 'thinking',
    text: 'working',
    ts: 3,
  });
  const seeded = ingestTranscriptEvents([], estimateTranscriptCost([]), [callA1, callB1, thought]);

  const callA2 = transcriptEvent('call-a-2', {
    author: undefined,
    kind: 'tool_call',
    text: undefined,
    toolUseId: 'tool-use-a',
    toolArgs: { description: 'list branches' },
    ts: 4,
  });
  const callB2 = transcriptEvent('call-b-2', {
    author: undefined,
    kind: 'tool_call',
    text: undefined,
    toolUseId: 'tool-use-b',
    toolArgs: { line: 12 },
    ts: 5,
  });
  const result = ingestTranscriptEvents(seeded.events, seeded.estimatedCost, [callA2, callB2]);

  assert.equal(result.events.length, 3);
  assert.deepEqual(result.events[0], {
    ...callA1,
    toolArgs: { command: 'git branch', description: 'list branches' },
    endTs: 4,
  });
  assert.deepEqual(result.events[1], {
    ...callB1,
    toolArgs: { path: '/tmp/file', line: 12 },
    endTs: 5,
  });
  assert.equal(result.events[2], thought);
  assert.deepEqual(result.change, {
    kind: 'append',
    previousLength: 3,
    firstChangedIndex: 0,
  });
  assert.equal(result.estimatedCost, estimateTranscriptCost(result.events));
});

test('a tool-call snapshot never merges into another source\u2019s call', () => {
  const call = transcriptEvent('call-1', {
    author: undefined,
    kind: 'tool_call',
    text: undefined,
    toolUseId: 'tool-use-a',
    toolName: 'Bash',
    toolArgs: { command: 'git branch' },
  });
  const seeded = ingestTranscriptEvents([], estimateTranscriptCost([]), [call]);

  const foreign = transcriptEvent('call-foreign', {
    author: undefined,
    kind: 'tool_call',
    text: undefined,
    sourceSessionId: 'child-1',
    toolUseId: 'tool-use-a',
    toolName: 'Bash',
    toolArgs: { command: 'git status' },
    ts: 2,
  });
  const result = ingestTranscriptEvents(seeded.events, seeded.estimatedCost, [foreign]);

  assert.deepEqual(result.events, [call, foreign]);
  assert.deepEqual(result.change, {
    kind: 'append',
    previousLength: 1,
    firstChangedIndex: 1,
  });
});

test('a prepended history page shifts streamed tool-call merge targets', () => {
  const call = transcriptEvent('call-1', {
    author: undefined,
    kind: 'tool_call',
    text: undefined,
    toolUseId: 'tool-use-a',
    toolName: 'Bash',
    toolArgs: { command: 'git log' },
  });
  const tail = transcriptEvent('tail', { ts: 2 });
  const seeded = ingestTranscriptEvents([], estimateTranscriptCost([]), [call, tail]);

  const older = transcriptEvent('older', { ts: 0 });
  const normalized = normalizeTranscriptUpdate(seeded.events, [older, ...seeded.events], {
    kind: 'prepend',
    previousLength: 2,
    firstChangedIndex: 0,
    insertedCount: 1,
  });

  const snapshot = transcriptEvent('call-1-later', {
    author: undefined,
    kind: 'tool_call',
    text: undefined,
    toolUseId: 'tool-use-a',
    toolArgs: { description: 'later args' },
    ts: 3,
  });
  const result = ingestTranscriptEvents(normalized, estimateTranscriptCost(normalized), [snapshot]);

  assert.equal(result.events.length, 3);
  assert.equal(result.events[0], older);
  assert.deepEqual(result.events[1], {
    ...call,
    toolArgs: { command: 'git log', description: 'later args' },
    endTs: 3,
  });
  assert.equal(result.events[2], tail);
  assert.deepEqual(result.change, {
    kind: 'append',
    previousLength: 3,
    firstChangedIndex: 1,
  });
  assert.equal(result.estimatedCost, estimateTranscriptCost(result.events));
});

test('retained event IDs are indexed once for small and large batches', () => {
  const retainedCount = 256;
  for (const batchSize of [1, 2, 4, 7]) {
    let retainedIdReads = 0;
    const retained = retainedEvents(retainedCount, () => {
      retainedIdReads += 1;
    });
    const incoming = Array.from({ length: batchSize }, (_, index) =>
      transcriptEvent(`small-${batchSize}-${index}`, { ts: retainedCount + index }),
    );

    const first = ingestTranscriptEvents(retained, 1, incoming);

    assert.equal(retainedIdReads, retainedCount);
    retainedIdReads = 0;
    ingestTranscriptEvents(first.events, first.estimatedCost, [
      transcriptEvent(`small-follow-up-${batchSize}`),
    ]);
    assert.equal(retainedIdReads, 0);
  }

  let retainedIdReads = 0;
  const retained = retainedEvents(retainedCount, () => {
    retainedIdReads += 1;
  });
  const incoming = Array.from({ length: 24 }, (_, index) =>
    transcriptEvent(`large-${index}`, { ts: retainedCount + index }),
  );

  ingestTranscriptEvents(retained, 1, incoming);

  assert.equal(retainedIdReads, retainedCount);
});

test('a live-tail delta copies bounded chunk state instead of retained history', () => {
  const retained = Array.from({ length: 3_001 }, (_, index) =>
    transcriptEvent(`retained-${index}`, {
      author: index === 3_000 ? undefined : 'assistant',
      text: index === 3_000 ? 'A' : `settled ${index}`,
      ts: index,
    }),
  );
  const initialized = ingestTranscriptEvents(retained, estimateTranscriptCost(retained), [
    transcriptEvent('initialize', { author: undefined, text: 'C', ts: 3_001 }),
  ]);
  const beforeStreaming = initialized.events;
  const delta = transcriptEvent('delta', {
    author: undefined,
    text: 'B',
    ts: 3_002,
  });

  const streamed = ingestTranscriptEvents(beforeStreaming, initialized.estimatedCost, [delta]);

  assert.equal(beforeStreaming.at(-1)?.text, 'AC');
  assert.equal(streamed.events.length, beforeStreaming.length);
  assert.equal(streamed.events.at(-1)?.text, 'ACB');
  assert.equal(streamed.events[0], beforeStreaming[0]);
  assert.equal(streamed.events[2_999], beforeStreaming[2_999]);
});

test('first-user lookup reuses runtime indexes for a plain hydrated array', () => {
  let idReads = 0;
  const events = [
    transcriptEvent('user-1', {
      author: 'user',
      text: 'hello',
    }),
    transcriptEvent('assistant-1'),
  ].map((event) => {
    Object.defineProperty(event, 'id', {
      configurable: true,
      enumerable: true,
      get: () => {
        idReads += 1;
        return event.kind === 'text' && event.author === 'user' ? 'user-1' : 'assistant-1';
      },
    });
    return event;
  });

  assert.equal(firstUserTranscriptEvent(events)?.author, 'user');
  const readsAfterFirstLookup = idReads;
  assert.ok(readsAfterFirstLookup > 0);
  assert.equal(firstUserTranscriptEvent(events)?.author, 'user');
  assert.equal(idReads, readsAfterFirstLookup);
});

function retainedEvents(count: number, onIdRead: () => void): TranscriptEvent[] {
  return Array.from({ length: count }, (_, index) => {
    const event = transcriptEvent(`retained-${index}`, { ts: index });
    Object.defineProperty(event, 'id', {
      configurable: true,
      enumerable: true,
      get: () => {
        onIdRead();
        return `retained-${index}`;
      },
    });
    return event;
  });
}
