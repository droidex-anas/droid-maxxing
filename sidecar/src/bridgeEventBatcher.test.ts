import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BridgeEventBatcher,
  type BridgeEventBatchMetadata,
  type BridgeEventBatcherOptions,
} from './bridgeEventBatcher.js';
import type {
  ContextStatsSnapshot,
  ServerEvent,
  ServerEventBatch,
  SessionSummary,
  TranscriptEvent,
} from './protocol.js';

interface FakeTimer {
  callback: () => void;
  delayMs: number;
  cancelled: boolean;
}

interface BatcherHarness {
  batcher: BridgeEventBatcher<FakeTimer>;
  batches: Array<{ batch: ServerEventBatch; metadata: BridgeEventBatchMetadata }>;
  timers: FakeTimer[];
  advance(ms: number): void;
  fire(index?: number): void;
}

function createHarness(
  overrides: Partial<BridgeEventBatcherOptions<FakeTimer>> = {},
): BatcherHarness {
  const batches: BatcherHarness['batches'] = [];
  const timers: FakeTimer[] = [];
  let now = 100;
  const batcher = new BridgeEventBatcher<FakeTimer>({
    generation: 'generation-test',
    sendBatch: (batch, metadata) => batches.push({ batch, metadata }),
    now: () => now,
    schedule: (callback, delayMs) => {
      const timer = { callback, delayMs, cancelled: false };
      timers.push(timer);
      return timer;
    },
    cancel: (timer) => {
      timer.cancelled = true;
    },
    ...overrides,
  });
  return {
    batcher,
    batches,
    timers,
    advance(ms) {
      now += ms;
    },
    fire(index = 0) {
      const timer = timers[index];
      if (!timer) throw new Error(`missing timer ${String(index)}`);
      if (!timer.cancelled) timer.callback();
    },
  };
}

function transcript(sourceSessionId: string, text: string): TranscriptEvent {
  return {
    id: `${sourceSessionId}-${text}`,
    appSessionId: 'app',
    sourceSessionId,
    role: sourceSessionId === 'app' ? 'primary' : 'worker',
    ts: 1,
    kind: 'text',
    text,
  };
}

function appended(sourceSessionId: string, text: string): ServerEvent {
  return { type: 'event.appended', event: transcript(sourceSessionId, text) };
}

function sessionSummary(appSessionId: string, streaming = true): SessionSummary {
  return {
    appSessionId,
    providerSessionId: `provider-${appSessionId}`,
    sessionPurpose: 'chat',
    interactionMode: 'auto',
    role: 'primary',
    title: appSessionId,
    goal: 'test',
    cwd: '/repo',
    autonomy: 'low',
    phase: 'running',
    streaming,
    features: [],
    tokensIn: 0,
    tokensOut: 0,
    contextTokens: 0,
    createdAt: 1,
    updatedAt: 1,
  };
}

function contextStats(used: number): ContextStatsSnapshot {
  return {
    used,
    remaining: 100 - used,
    limit: 100,
    accuracy: 'exact',
    updatedAt: '2026-08-20T00:00:00.000Z',
  };
}

function context(appSessionId: string, sourceSessionId: string, used: number): ServerEvent {
  return {
    type: 'context.updated',
    appSessionId,
    sourceSessionId,
    stats: contextStats(used),
  };
}

test('27 interleaved sources stay ordered in one frame batch', () => {
  const harness = createHarness();
  for (let index = 0; index < 27; index += 1) {
    harness.batcher.enqueue(appended(`child-${String(index)}`, String(index)));
  }

  assert.equal(harness.batches.length, 0);
  assert.equal(harness.timers[0]?.delayMs, 16);
  harness.advance(16);
  harness.fire();

  const delivered = required(harness.batches[0], 'missing delivered batch');
  assert.equal(delivered.batch.firstSeq, 1);
  assert.equal(delivered.batch.lastSeq, 27);
  assert.equal(delivered.batch.events.length, 27);
  assert.deepEqual(
    delivered.batch.events.map((entry) => {
      const event = entry.event;
      if (event.type !== 'event.appended') throw new Error(`unexpected ${event.type}`);
      return event.event.sourceSessionId;
    }),
    Array.from({ length: 27 }, (_, index) => `child-${String(index)}`),
  );
  assert.equal(delivered.metadata.logicalEvents, 27);
  assert.equal(delivered.metadata.deliveredEvents, 27);
});

test('replaceable telemetry collapses to its latest ordered occurrence', () => {
  const harness = createHarness();
  harness.batcher.enqueue(context('app', 'child-a', 1));
  harness.batcher.enqueue({ type: 'session.updated', session: sessionSummary('app') });
  harness.batcher.enqueue(context('app', 'child-a', 2));
  harness.batcher.enqueue({ type: 'session.updated', session: sessionSummary('app') });
  harness.batcher.flush();

  const delivered = required(harness.batches[0], 'missing delivered batch');
  assert.equal(delivered.metadata.logicalEvents, 4);
  assert.equal(delivered.metadata.deliveredEvents, 2);
  assert.deepEqual(
    delivered.batch.events.map((entry) => [entry.event.type, entry.seq]),
    [
      ['context.updated', 3],
      ['session.updated', 4],
    ],
  );
  const first = required(delivered.batch.events[0], 'missing first event').event;
  if (first.type !== 'context.updated') throw new Error(`unexpected ${first.type}`);
  assert.equal(first.stats.used, 2);
});

test('context replacement keys cannot collide across delimited identities', () => {
  const harness = createHarness();
  harness.batcher.enqueue(context('a:b', 'c', 1));
  harness.batcher.enqueue(context('a', 'b:c', 2));
  harness.batcher.flush();

  const delivered = required(harness.batches[0], 'missing delivered batch');
  assert.equal(delivered.metadata.deliveredEvents, 2);
  assert.deepEqual(
    delivered.batch.events.map((entry) => {
      const event = entry.event;
      if (event.type !== 'context.updated') throw new Error(`unexpected ${event.type}`);
      return [event.appSessionId, event.sourceSessionId];
    }),
    [
      ['a:b', 'c'],
      ['a', 'b:c'],
    ],
  );
});

test('a non-replaceable event is a telemetry collapse barrier', () => {
  const harness = createHarness();
  harness.batcher.enqueue(context('app', 'child-a', 1));
  harness.batcher.enqueue(appended('child-b', 'middle'));
  harness.batcher.enqueue(context('app', 'child-a', 2));
  harness.batcher.flush();

  const delivered = required(harness.batches[0], 'missing delivered batch');
  assert.deepEqual(
    delivered.batch.events.map((entry) => entry.event.type),
    ['context.updated', 'event.appended', 'context.updated'],
  );
});

test('priority events flush queued work before their immediate batch', () => {
  const harness = createHarness();
  harness.batcher.enqueue(appended('child-a', 'before'));
  harness.advance(5);
  harness.batcher.enqueue({
    type: 'approval.requested',
    request: {
      appSessionId: 'app',
      requestId: 'approval',
      kind: 'exec',
      title: 'Run command',
      detail: 'npm test',
      raw: {},
    },
  });

  assert.equal(harness.batches.length, 2);
  assert.deepEqual(
    harness.batches.map(({ batch }) => [batch.firstSeq, batch.lastSeq]),
    [
      [1, 1],
      [2, 2],
    ],
  );
  assert.equal(harness.batches[0]?.metadata.queueDelayMs, 5);
  assert.equal(harness.batches[1]?.metadata.immediate, true);
  assert.equal(harness.batches[1]?.batch.events[0]?.event.type, 'approval.requested');
});

test('user-action and domain error events bypass the normal frame window', () => {
  const events: ServerEvent[] = [
    { type: 'mcp.authRequested', requestId: 'mcp-auth', serverName: 'github' },
    { type: 'mcp.error', requestId: 'mcp-error', message: 'authentication failed' },
    { type: 'browser.error', appSessionId: 'app', message: 'navigation failed' },
    { type: 'browser.closed', appSessionId: 'app' },
  ];

  for (const event of events) {
    const harness = createHarness();
    harness.batcher.enqueue(event);
    assert.equal(harness.batches.length, 1, `${event.type} should flush immediately`);
    assert.equal(harness.batches[0]?.metadata.immediate, true);
    assert.equal(harness.batches[0]?.batch.events[0]?.event.type, event.type);
    assert.equal(harness.timers.length, 0);
  }
});

test('turn settlement is an immediate flush boundary', () => {
  const harness = createHarness();
  harness.batcher.enqueue(appended('app', 'tail'));
  harness.batcher.enqueue({
    type: 'session.updated',
    session: sessionSummary('app', false),
  });

  assert.equal(harness.batches.length, 2);
  assert.equal(harness.batches[0]?.batch.events[0]?.event.type, 'event.appended');
  assert.equal(harness.batches[1]?.batch.events[0]?.event.type, 'session.updated');
  assert.equal(harness.batches[1]?.metadata.immediate, true);
});

test('pending limits synchronously flush a bounded queue', () => {
  const harness = createHarness({ maxPendingEvents: 3 });
  harness.batcher.enqueue(appended('a', '1'));
  harness.batcher.enqueue(appended('b', '2'));
  harness.batcher.enqueue(appended('c', '3'));

  assert.equal(harness.batches.length, 1);
  assert.equal(harness.batches[0]?.batch.events.length, 3);
  assert.equal(harness.batcher.snapshot().pendingLogicalEvents, 0);
});

test('queue snapshots publish the full dwell age before flush reset', () => {
  const ages: number[] = [];
  const harness = createHarness({
    onQueueChanged: (snapshot) => ages.push(snapshot.oldestPendingAgeMs),
  });

  harness.batcher.enqueue(appended('app', 'queued'));
  harness.advance(16);
  harness.fire();

  assert.ok(ages.includes(16));
  assert.equal(ages.at(-1), 0);
});

test('soft transport pressure uses the longer batching window', () => {
  const harness = createHarness({ isUnderPressure: () => true });
  harness.batcher.enqueue(appended('a', '1'));
  assert.equal(harness.timers[0]?.delayMs, 32);
});

test('close flushes once and rejects later writes', () => {
  const harness = createHarness();
  harness.batcher.enqueue(appended('a', '1'));
  harness.batcher.close();
  harness.batcher.close();

  assert.equal(harness.batches.length, 1);
  assert.throws(() => harness.batcher.enqueue(appended('a', '2')), /closed/);
});

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}
