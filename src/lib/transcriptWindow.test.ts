import test from 'node:test';
import assert from 'node:assert/strict';
import type { TranscriptEvent } from '../types/bridge';
import {
  estimateRetainedPayloadCost,
  estimateTranscriptCost,
  releaseChildTranscriptWindow,
  releaseTranscriptWindow,
  VIEWPORT_TRANSCRIPT_POLICY,
  type TranscriptWindowPolicy,
} from './transcriptWindow';

function event(id: string, overrides: Partial<TranscriptEvent> = {}): TranscriptEvent {
  return {
    id,
    appSessionId: 'session-1',
    sourceSessionId: 'primary',
    role: 'primary',
    kind: 'text',
    text: id,
    ts: Number(id.replace(/\D/g, '')) || 0,
    ...overrides,
  };
}

const TEST_POLICY: TranscriptWindowPolicy = {
  highWaterCost: 2_000,
  highWaterEvents: 10,
  targetCost: 1_000,
  targetEvents: 6,
  minimumEvents: 3,
  boundaryScanEvents: 3,
};

test('retained-payload estimates include UTF-8 and nested reference data', () => {
  const ascii = estimateRetainedPayloadCost({ text: 'aaaa' });
  const emoji = estimateRetainedPayloadCost({ text: '😀😀😀😀' });
  const nested = estimateRetainedPayloadCost({
    text: 'aaaa',
    browserRefs: [{ imageDataUrl: 'data:image/png;base64,' + 'x'.repeat(4_000) }],
  });

  assert.ok(emoji > ascii);
  assert.ok(nested > ascii + 4_000);
});

test('a transcript under its high-water marks keeps the same array identity', () => {
  const events = [event('1'), event('2')];
  const estimatedCost = estimateTranscriptCost(events);
  const result = releaseTranscriptWindow(events, estimatedCost, TEST_POLICY);

  assert.equal(result.events, events);
  assert.equal(result.estimatedCost, estimatedCost);
  assert.equal(result.released, false);
});

test('release keeps a recent tail and moves the boundary to a nearby user prompt', () => {
  const events = Array.from({ length: 14 }, (_, index) =>
    event(String(index), index === 8 ? { author: 'user', text: 'new turn' } : {}),
  );
  const result = releaseTranscriptWindow(events, estimateTranscriptCost(events), {
    ...TEST_POLICY,
    highWaterCost: 4_000,
  });

  assert.equal(result.released, true);
  assert.equal(result.events[0]?.id, '8');
  assert.equal(result.events[0]?.author, 'user');
  assert.equal(result.events.at(-1)?.id, '13');
});

test('prompt-boundary expansion never exceeds the event high-water allocation', () => {
  const events = Array.from({ length: 30 }, (_, index) =>
    event(String(index), index === 10 ? { author: 'user', text: 'distant turn' } : {}),
  );
  const result = releaseTranscriptWindow(events, estimateTranscriptCost(events), {
    ...TEST_POLICY,
    highWaterCost: 100_000,
    highWaterEvents: 8,
    targetCost: 100_000,
    targetEvents: 5,
    minimumEvents: 1,
    boundaryScanEvents: 24,
  });

  assert.equal(result.released, true);
  assert.ok(result.events.length <= 8);
  assert.equal(result.events.at(-1)?.id, '29');
});

test('one indivisible oversized event is never truncated or partially retained', () => {
  const events = [event('1', { text: 'x'.repeat(10_000) })];
  const result = releaseTranscriptWindow(events, estimateTranscriptCost(events), TEST_POLICY);

  assert.equal(result.released, false);
  assert.equal(result.events, events);
  assert.equal(result.events[0]?.text?.length, 10_000);
});

test('payload-heavy events may cross the event floor but stay under the byte ceiling', () => {
  const events = Array.from({ length: 8 }, (_, index) =>
    event(String(index), { text: `${index}:${'x'.repeat(1_500)}` }),
  );
  const result = releaseTranscriptWindow(events, estimateTranscriptCost(events), TEST_POLICY);

  assert.equal(result.released, true);
  assert.ok(result.events.length < TEST_POLICY.minimumEvents);
  assert.ok(result.estimatedCost <= TEST_POLICY.highWaterCost);
  assert.equal(result.events.at(-1)?.text, `7:${'x'.repeat(1_500)}`);
});

test('large tool-call soak releases old objects and plateaus at the viewport window', () => {
  const events: TranscriptEvent[] = [];
  for (let index = 0; index < 2_000; index++) {
    events.push(
      event(`call-${index}`, {
        kind: 'tool_call',
        toolName: 'Read',
        toolUseId: `tool-${index}`,
        toolArgs: { path: `/tmp/file-${index}.ts` },
      }),
      event(`result-${index}`, {
        kind: 'tool_result',
        toolUseId: `tool-${index}`,
        text: `result-${index}\n${'payload '.repeat(120)}`,
      }),
    );
  }

  const result = releaseTranscriptWindow(
    events,
    estimateTranscriptCost(events),
    VIEWPORT_TRANSCRIPT_POLICY,
  );

  assert.equal(result.released, true);
  assert.ok(result.events.length <= VIEWPORT_TRANSCRIPT_POLICY.targetEvents);
  assert.ok(result.events.length >= VIEWPORT_TRANSCRIPT_POLICY.minimumEvents);
  assert.equal(result.events.at(-1)?.id, 'result-1999');
  assert.equal(new Set(result.events.map((item) => item.id)).size, result.events.length);
});

test('child release trims only one logical child and preserves parent and sibling rows', () => {
  const primary = [event('primary-1'), event('primary-2')];
  const sibling = [
    event('sibling-1', { sourceSessionId: 'child-b', role: 'validator' }),
    event('sibling-2', { sourceSessionId: 'child-b', role: 'validator' }),
  ];
  const child = Array.from({ length: 14 }, (_, index) =>
    event(`child-${index}`, {
      sourceSessionId: 'child-a',
      role: 'worker',
      ...(index === 8 ? { author: 'user' as const, text: 'new child turn' } : {}),
    }),
  );
  const transcript = [primary[0], child[0], sibling[0], ...child.slice(1), primary[1], sibling[1]];

  const result = releaseChildTranscriptWindow(transcript, 'child-a', {
    ...TEST_POLICY,
    highWaterCost: 4_000,
  });

  assert.equal(result.released, true);
  assert.deepEqual(
    result.events.filter((item) => item.sourceSessionId === 'primary').map((item) => item.id),
    primary.map((item) => item.id),
  );
  assert.deepEqual(
    result.events.filter((item) => item.sourceSessionId === 'child-b').map((item) => item.id),
    sibling.map((item) => item.id),
  );
  assert.equal(
    result.events.filter((item) => item.sourceSessionId === 'child-a')[0]?.id,
    'child-8',
  );
  assert.equal(result.events.at(-1)?.id, 'sibling-2');
});
