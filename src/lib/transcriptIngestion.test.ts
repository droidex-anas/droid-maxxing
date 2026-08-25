import test from 'node:test';
import assert from 'node:assert/strict';
import type { TranscriptEvent } from '../types/bridge';
import { ingestTranscriptEvents } from './transcriptIngestion';
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
