import assert from 'node:assert/strict';
import test from 'node:test';

import type { TranscriptEvent } from './protocol.js';
import { StreamingDeltaCoalescer, streamingEventOwner } from './streamingDeltaCoalescer.js';

const WINDOW_MS = 40;
const SETTLE_MARGIN_MS = 25;

function createCoalescer(
  overrides: {
    windowMs?: number;
    maxBytes?: number;
    failFor?: (event: TranscriptEvent) => boolean;
  } = {},
) {
  const delivered: TranscriptEvent[] = [];
  const coalescer = new StreamingDeltaCoalescer({
    windowMs: overrides.windowMs ?? WINDOW_MS,
    maxBytes: overrides.maxBytes ?? 64 * 1024,
    deliver: (event) => {
      if (overrides.failFor?.(event)) throw new Error(`deliver failed for ${event.id}`);
      delivered.push(event);
    },
  });
  return { coalescer, delivered };
}

function childDelta(
  id: string,
  childSessionId: string,
  overrides: Partial<TranscriptEvent> = {},
): TranscriptEvent {
  return {
    id,
    appSessionId: 'parent-1',
    sourceSessionId: childSessionId,
    role: 'worker',
    ts: 1,
    kind: 'text',
    text: id,
    ...overrides,
  };
}

function waitTicks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

function waitWindow(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, WINDOW_MS + SETTLE_MARGIN_MS));
}

test('a turn opens at tick speed and then coalesces for the full window', async () => {
  const { coalescer, delivered } = createCoalescer();

  coalescer.accept(childDelta('a1', 'child-1', { text: 'He' }));
  assert.equal(delivered.length, 0, 'nothing is published synchronously');
  await waitTicks();
  assert.deepEqual(
    delivered.map((event) => event.text),
    ['He'],
  );

  coalescer.accept(childDelta('a2', 'child-1', { text: 'llo', ts: 2 }));
  coalescer.accept(childDelta('a3', 'child-1', { text: ' there', ts: 3 }));
  await waitTicks();
  assert.equal(delivered.length, 1, 'steady-state deltas keep the full coalescing window');
  await waitWindow();
  assert.deepEqual(
    delivered.map((event) => event.text),
    ['He', 'llo there'],
  );

  coalescer.endTurn('parent-1', 'child-1');
  coalescer.accept(childDelta('b1', 'child-1', { text: 'next turn' }));
  await waitTicks();
  assert.equal(delivered.length, 3, 'the next turn opens at tick speed again');
});

test('concurrent children each keep their own coalescing run', async () => {
  const { coalescer, delivered } = createCoalescer();

  // Open both turns so both sources are past their first-run flush.
  coalescer.accept(childDelta('a0', 'child-a', { text: 'A' }));
  coalescer.accept(childDelta('b0', 'child-b', { text: 'B' }));
  await waitTicks();
  assert.equal(delivered.length, 2);

  for (let index = 1; index <= 4; index += 1) {
    coalescer.accept(childDelta(`a${String(index)}`, 'child-a', { text: 'a', ts: index }));
    coalescer.accept(childDelta(`b${String(index)}`, 'child-b', { text: 'b', ts: index }));
  }
  assert.equal(delivered.length, 2, 'interleaved siblings must not flush each other');
  await waitWindow();

  assert.deepEqual(
    delivered.map((event) => [event.sourceSessionId, event.text]),
    [
      ['child-a', 'A'],
      ['child-b', 'B'],
      ['child-a', 'aaaa'],
      ['child-b', 'bbbb'],
    ],
  );
});

test('a non-mergeable event lands behind its own source and ahead of nothing else', async () => {
  const { coalescer, delivered } = createCoalescer({ windowMs: 1_000 });

  coalescer.accept(childDelta('a1', 'child-a', { text: 'thinking', kind: 'thinking' }));
  coalescer.accept(childDelta('b1', 'child-b', { text: 'other child' }));
  coalescer.accept(
    childDelta('a2', 'child-a', { kind: 'tool_result', text: 'result', toolUseId: 'tool-1' }),
  );

  assert.deepEqual(
    delivered.map((event) => event.id),
    ['a1', 'a2'],
    'child A flushes its own run then appends the result; child B stays buffered',
  );
  coalescer.flushAll();
  assert.deepEqual(
    delivered.map((event) => event.id),
    ['a1', 'a2', 'b1'],
  );
});

test('endTurn forgets the source so its buffered tail cannot be published twice', () => {
  const { coalescer, delivered } = createCoalescer({ windowMs: 1_000 });

  coalescer.accept(childDelta('a1', 'child-a', { text: 'tail' }));
  coalescer.endTurn('parent-1', 'child-a');
  coalescer.endTurn('parent-1', 'child-a');
  coalescer.flushAll();

  assert.deepEqual(
    delivered.map((event) => event.id),
    ['a1'],
  );
});

test('flushAll delivers every source even when one delivery fails', () => {
  const { coalescer, delivered } = createCoalescer({
    windowMs: 1_000,
    failFor: (event) => event.sourceSessionId === 'child-b',
  });

  coalescer.accept(childDelta('a1', 'child-a', { text: 'a' }));
  coalescer.accept(childDelta('b1', 'child-b', { text: 'b' }));
  coalescer.accept(childDelta('c1', 'child-c', { text: 'c' }));

  assert.throws(() => coalescer.flushAll(), /deliver failed for b1/);
  assert.deepEqual(
    delivered.map((event) => event.id),
    ['a1', 'c1'],
  );
  assert.doesNotThrow(() => coalescer.flushAll());
});

test('a disabled window delivers every delta immediately', () => {
  const { coalescer, delivered } = createCoalescer({ windowMs: 0 });

  coalescer.accept(childDelta('a1', 'child-a'));
  coalescer.accept(childDelta('a2', 'child-a'));

  assert.deepEqual(
    delivered.map((event) => event.id),
    ['a1', 'a2'],
  );
});

test('streamingEventOwner keys primaries by session and children by child id', () => {
  assert.equal(
    streamingEventOwner({
      id: 'p',
      appSessionId: 'app-1',
      sourceSessionId: 'provider-1',
      role: 'primary',
      ts: 1,
      kind: 'text',
    }),
    'app-1',
  );
  assert.equal(streamingEventOwner(childDelta('c', 'child-9')), 'child-9');
});
