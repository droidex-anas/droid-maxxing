import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  ChildSessionSummary,
  ServerEvent,
  SessionSummary,
  TranscriptEvent,
} from './protocol.js';
import {
  SessionTimeline,
  type SessionTimelineLoaders,
  type SessionTimelineRegistry,
} from './SessionTimeline.js';
import { droidSessionConfiguration } from './providers/providerIdentity.js';
import { ShutdownDeadline } from './providers/shutdownDeadline.js';
import {
  CanonicalEventCollisionError,
  type TranscriptStore,
} from './persistence/TranscriptStore.js';
import type {
  CanonicalEvent,
  CanonicalIdentity,
  PersistedCanonicalEvent,
} from './sessionEvents.js';

interface HarnessOptions {
  summaries?: SessionSummary[];
  liveAppSessionIds?: string[];
  childSessions?: ChildSessionSummary[];
  loaders?: Partial<SessionTimelineLoaders>;
  now?: () => number;
  onRecordEvent?: (event: TranscriptEvent) => boolean | void;
  transcriptStore?: Pick<TranscriptStore, 'append'>;
  canonicalIdentity?: CanonicalIdentity;
  streamingCoalesceMs?: number;
  streamingCoalesceMaxBytes?: number;
}

function createHarness(options: HarnessOptions = {}) {
  const emitted: ServerEvent[] = [];
  const errors: Array<Omit<Extract<ServerEvent, { type: 'error' }>, 'type'>> = [];
  const recorded: TranscriptEvent[] = [];
  const trace: string[] = [];
  const summaries = options.summaries ?? [];
  const liveAppSessionIds = new Set(options.liveAppSessionIds ?? []);
  const loaders: SessionTimelineLoaders = {
    page: () => ({ events: [] }),
    hydrateMission: () => ({ progress: [], transcripts: [] }),
    resolveChain: (_appSessionId, providerSessionId) => [providerSessionId],
    transcriptWindow: () => ({ events: [] }),
    ...options.loaders,
  };
  const resolve = (id: string) =>
    summaries.find(
      (summary) =>
        summary.appSessionId === id ||
        summary.providerSessionId === id ||
        summary.compactedFromProviderSessionIds?.includes(id),
    );
  const registry: SessionTimelineRegistry = {
    resolveSummary: resolve,
    getCanonicalSummary: resolve,
    getLive: (id) => (liveAppSessionIds.has(id) ? true : undefined),
  };
  const timeline = new SessionTimeline({
    registry,
    history: {
      recordEvent: (event) => {
        trace.push(`record:${event.id}`);
        const durable = options.onRecordEvent?.(event);
        recorded.push(event);
        return durable;
      },
    },
    getChildSessions: () => options.childSessions ?? [],
    emit: (event) => {
      trace.push(`emit:${event.type}`);
      emitted.push(event);
    },
    emitError: (error) => {
      errors.push(error);
    },
    loaders,
    ...(options.now ? { now: options.now } : {}),
    ...(options.streamingCoalesceMs !== undefined
      ? { streamingCoalesceMs: options.streamingCoalesceMs }
      : {}),
    ...(options.streamingCoalesceMaxBytes !== undefined
      ? { streamingCoalesceMaxBytes: options.streamingCoalesceMaxBytes }
      : {}),
    ...(options.transcriptStore ? { transcriptStore: options.transcriptStore } : {}),
    ...(options.canonicalIdentity ? { canonicalIdentity: options.canonicalIdentity } : {}),
  });
  return { emitted, errors, recorded, timeline, trace };
}

function summary(
  appSessionId: string,
  providerSessionId: string,
  overrides: Partial<SessionSummary> = {},
): SessionSummary {
  return {
    appSessionId,
    providerSessionId,
    sessionPurpose: 'chat',
    role: 'primary',
    title: appSessionId,
    goal: appSessionId,
    cwd: '/workspace',
    workspaceKind: 'folder',
    configuration: droidSessionConfiguration({
      modelId: 'model-default',
      interactionMode: 'auto',
      autonomy: 'low',
    }),
    phase: 'paused',
    features: [],
    tokensIn: 0,
    tokensOut: 0,
    contextTokens: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function child(
  parentAppSessionId: string,
  childSessionId: string,
  status: ChildSessionSummary['status'],
): ChildSessionSummary {
  return {
    parentAppSessionId,
    childSessionId,
    role: 'worker',
    status,
    modelId: 'model-default',
    transcriptAvailable: true,
    streamFidelity: 'state',
  };
}

function transcript(id: string, appSessionId = 'provider-source'): TranscriptEvent {
  return {
    id,
    appSessionId,
    sourceSessionId: appSessionId,
    role: 'primary',
    ts: 1,
    kind: 'text',
    text: id,
  };
}

const TEST_COALESCE_MS = 5;
const TEST_COALESCE_SETTLE_MARGIN_MS = 20;

function waitForTestCoalesce(): Promise<void> {
  return new Promise((resolve) =>
    setTimeout(resolve, TEST_COALESCE_MS + TEST_COALESCE_SETTLE_MARGIN_MS),
  );
}

function delta(
  id: string,
  overrides: Partial<TranscriptEvent> & { appSessionId?: string } = {},
): TranscriptEvent {
  return {
    id,
    appSessionId: 'app-1',
    sourceSessionId: 'source-1',
    role: 'primary',
    ts: 1,
    kind: 'text',
    text: id,
    ...overrides,
  };
}

test('streaming text deltas coalesce into one event flushed by the timer', async () => {
  const { emitted, recorded, timeline } = createHarness({
    streamingCoalesceMs: TEST_COALESCE_MS,
  });

  timeline.appendStreaming(delta('a', { text: 'Hel', ts: 10 }));
  timeline.appendStreaming(delta('b', { text: 'lo', ts: 12 }));
  assert.deepEqual(emitted, []);
  assert.deepEqual(recorded, []);

  await waitForTestCoalesce();

  assert.equal(recorded.length, 1);
  assert.deepEqual(recorded[0], delta('a', { text: 'Hello', ts: 10, endTs: 12 }));
  assert.deepEqual(emitted, [{ type: 'event.appended', event: recorded[0] }]);
});

test('timer flush failures stay owned by turn settlement', async () => {
  const { emitted, errors, timeline } = createHarness({
    streamingCoalesceMs: TEST_COALESCE_MS,
    onRecordEvent: () => {
      throw new Error('disk full');
    },
  });

  timeline.appendStreaming(delta('a', { text: 'buffered tail' }));
  await waitForTestCoalesce();

  assert.deepEqual(emitted, []);
  assert.deepEqual(errors, [
    {
      appSessionId: 'app-1',
      message: 'Could not persist streaming transcript: disk full',
      recoverable: true,
    },
  ]);
  assert.doesNotThrow(() => timeline.flushStreamingFor('app-1', 'app-1'));
  assert.throws(() => timeline.settleStreaming('app-1', 'app-1'), /disk full/);
  assert.doesNotThrow(() => timeline.settleStreaming('app-1', 'app-1'));
});

test('timer flush failures report once through the owning child conversation', async () => {
  const { emitted, errors, timeline } = createHarness({
    streamingCoalesceMs: TEST_COALESCE_MS,
    onRecordEvent: () => {
      throw new Error('disk full');
    },
  });

  timeline.appendStreaming(
    delta('a', {
      appSessionId: 'parent-1',
      sourceSessionId: 'child-1',
      role: 'worker',
      text: 'buffered child tail',
    }),
  );
  await waitForTestCoalesce();

  assert.deepEqual(errors, []);
  assert.deepEqual(emitted, [
    {
      type: 'child.error',
      parentAppSessionId: 'parent-1',
      childSessionId: 'child-1',
      operation: 'send',
      requestId: null,
      code: 'child.transcript_persist_failed',
      message: 'Unable to persist buffered child output: disk full',
      recoverable: true,
    },
  ]);
  assert.doesNotThrow(() => timeline.flushStreamingFor('parent-1', 'child-1'));
  assert.throws(() => timeline.settleStreaming('parent-1', 'child-1'), /disk full/);
  assert.equal(emitted.length, 1);
});

test('one child persistence failure does not abort another child append', () => {
  const { emitted, recorded, timeline } = createHarness({
    streamingCoalesceMs: 1_000,
    onRecordEvent: (event) => {
      if (event.sourceSessionId === 'child-a') throw new Error('child A disk failure');
    },
  });

  timeline.appendStreaming(
    delta('a', {
      appSessionId: 'parent-1',
      sourceSessionId: 'child-a',
      role: 'worker',
    }),
  );
  assert.doesNotThrow(() => {
    timeline.appendStreaming(
      delta('b', {
        appSessionId: 'parent-1',
        sourceSessionId: 'child-b',
        role: 'worker',
      }),
    );
  });
  // A sibling's delta must neither publish nor abort child A's buffered run.
  assert.deepEqual(emitted, []);
  timeline.flushStreamingFor('parent-1', 'child-b');

  assert.deepEqual(
    recorded.map((event) => event.id),
    ['b'],
  );
  assert.deepEqual(emitted, [{ type: 'event.appended', event: recorded[0] }]);
  assert.throws(() => timeline.settleStreaming('parent-1', 'child-a'), /child A disk failure/);
  assert.deepEqual(emitted.slice(1), [
    {
      type: 'child.error',
      parentAppSessionId: 'parent-1',
      childSessionId: 'child-a',
      operation: 'send',
      requestId: null,
      code: 'child.transcript_persist_failed',
      message: 'Unable to persist buffered child output: child A disk failure',
      recoverable: true,
    },
  ]);
  assert.doesNotThrow(() => timeline.settleStreaming('parent-1', 'child-b'));
});

test('streaming byte budget flushes early without dropping or truncating content', () => {
  const { recorded, timeline } = createHarness({
    streamingCoalesceMs: 1_000,
    streamingCoalesceMaxBytes: 400,
  });

  timeline.appendStreaming(delta('a', { text: 'a'.repeat(120) }));
  timeline.appendStreaming(delta('b', { text: 'b'.repeat(120) }));
  timeline.appendStreaming(delta('c', { text: 'c'.repeat(1_000) }));
  timeline.flushStreaming();

  assert.equal(
    recorded.map((event) => event.text ?? '').join(''),
    `${'a'.repeat(120)}${'b'.repeat(120)}${'c'.repeat(1_000)}`,
  );
  assert.equal(
    recorded.every((event) => (event.text?.length ?? 0) > 0),
    true,
  );
});

test('non-mergeable streaming events flush the buffer and keep order', () => {
  const { recorded, timeline, trace } = createHarness({ streamingCoalesceMs: 1000 });

  timeline.appendStreaming(delta('a', { text: 'thought ', kind: 'thinking' }));
  timeline.appendStreaming(delta('b', { text: 'stream', kind: 'thinking' }));
  timeline.appendStreaming(delta('echo', { author: 'user' }));

  assert.deepEqual(trace, [
    'record:a',
    'emit:event.appended',
    'record:echo',
    'emit:event.appended',
  ]);
  assert.equal(recorded[0]?.text, 'thought stream');
  timeline.flushStreaming();
  assert.equal(recorded.length, 2);
});

test('a kind or source change starts a new buffered run instead of merging', () => {
  const { recorded, timeline } = createHarness({ streamingCoalesceMs: 1000 });

  timeline.appendStreaming(delta('a', { kind: 'thinking' }));
  timeline.appendStreaming(delta('b', { kind: 'text' }));
  timeline.appendStreaming(delta('c', { kind: 'text', sourceSessionId: 'source-2' }));
  timeline.flushStreaming();

  assert.deepEqual(
    recorded.map((event) => event.id),
    ['a', 'b', 'c'],
  );
});

test('tool_call deltas of one toolUseId collapse onto the latest snapshot', () => {
  const { recorded, timeline } = createHarness({ streamingCoalesceMs: 1000 });

  timeline.appendStreaming(
    delta('a', { kind: 'tool_call', text: undefined, toolUseId: 'tool-1', ts: 10 }),
  );
  timeline.appendStreaming(
    delta('b', {
      kind: 'tool_call',
      text: undefined,
      toolName: 'Edit',
      toolUseId: 'tool-1',
      toolArgs: { path: '/tmp/file' },
      ts: 12,
    }),
  );
  timeline.appendStreaming(
    delta('c', {
      kind: 'tool_call',
      text: undefined,
      toolUseId: 'tool-1',
      toolArgs: { content: 'body' },
      ts: 14,
    }),
  );
  timeline.appendStreaming(
    delta('d', { kind: 'tool_call', text: undefined, toolUseId: 'tool-2', ts: 16 }),
  );
  timeline.flushStreaming();

  assert.deepEqual(
    recorded.map((event) => [event.id, event.toolName, event.toolArgs, event.endTs]),
    [
      ['a', 'Edit', { path: '/tmp/file', content: 'body' }, 14],
      ['d', undefined, undefined, undefined],
    ],
  );
});

test('plain append flushes the buffered run first and flush is idempotent', () => {
  const { timeline, trace } = createHarness({ streamingCoalesceMs: 1000 });

  timeline.appendStreaming(delta('buffered'));
  timeline.append(delta('status-line', { kind: 'status', author: 'user' }));
  timeline.flushStreaming();
  timeline.flushStreaming();

  assert.deepEqual(trace, [
    'record:buffered',
    'emit:event.appended',
    'record:status-line',
    'emit:event.appended',
  ]);
});

test('coalescing disabled records and emits every delta immediately', () => {
  const { recorded, timeline } = createHarness({ streamingCoalesceMs: 0 });

  timeline.appendStreaming(delta('a'));
  timeline.appendStreaming(delta('b'));

  assert.deepEqual(
    recorded.map((event) => event.id),
    ['a', 'b'],
  );
});

test('append records before emitting exactly one live transcript event', () => {
  const { emitted, recorded, timeline, trace } = createHarness();
  const event = transcript('event-1', 'app-1');

  timeline.append(event);

  assert.deepEqual(trace, ['record:event-1', 'emit:event.appended']);
  assert.deepEqual(recorded, [event]);
  assert.deepEqual(emitted, [{ type: 'event.appended', event }]);
});

test('plain restore resolves aliases, records in order, and emits replace telemetry', () => {
  const restored = [transcript('first'), transcript('second')];
  const childSessions = [child('app-1', 'worker-1', 'running')];
  const calls: unknown[][] = [];
  const stable = summary('app-1', 'provider-current', {
    compactedFromProviderSessionIds: ['provider-old'],
  });
  const harness = createHarness({
    summaries: [stable],
    childSessions,
    loaders: {
      resolveChain: (...args) => {
        calls.push(args);
        return ['provider-old', 'provider-current'];
      },
      transcriptWindow: (...args) => {
        calls.push(args);
        return { events: restored, olderCursor: 'older-1' };
      },
    },
  });

  harness.timeline.load('provider-old');

  assert.deepEqual(calls, [
    ['app-1', 'provider-current'],
    ['app-1', ['provider-old', 'provider-current'], { cursor: undefined }],
  ]);
  assert.deepEqual(
    harness.recorded.map((event) => [event.id, event.appSessionId]),
    [
      ['first', 'app-1'],
      ['second', 'app-1'],
    ],
  );
  assert.deepEqual(harness.trace, ['record:first', 'record:second', 'emit:session.history']);
  const page = harness.emitted[0];
  assert.equal(page?.type, 'session.history');
  if (page?.type !== 'session.history') return;
  assert.equal(page.appSessionId, 'app-1');
  assert.equal(page.mode, 'replace');
  assert.equal(page.olderCursor, 'older-1');
  assert.equal(page.loadedCount, 2);
  assert.equal(page.hasMore, true);
  assert.deepEqual(page.childSessions, childSessions);
});

test('history page limits tune only the bounded local transcript window', () => {
  const calls: unknown[][] = [];
  const harness = createHarness({
    summaries: [summary('app-1', 'provider-1')],
    loaders: {
      resolveChain: () => ['provider-1'],
      transcriptWindow: (...args) => {
        calls.push(args);
        return { events: [] };
      },
    },
  });

  harness.timeline.load('app-1', 'cursor-1', 240);
  harness.timeline.load('app-1', 'cursor-2', 100_000);

  assert.deepEqual(calls, [
    ['app-1', ['provider-1'], { cursor: 'cursor-1', limit: 240 }],
    ['app-1', ['provider-1'], { cursor: 'cursor-2', limit: 1_600 }],
  ]);
});

test('Mission Control restore preserves progress, child links, cursor, identity, and order', () => {
  const progress = [{ type: 'feature', timestamp: '2026-07-28T00:00:00.000Z' }];
  const restored = [transcript('mission-first'), transcript('mission-second')];
  const childSessions = [child('mission-app', 'mission-worker', 'running')];
  const calls: unknown[][] = [];
  const harness = createHarness({
    summaries: [summary('mission-app', 'mission-provider', { sessionPurpose: 'mission-control' })],
    childSessions,
    loaders: {
      hydrateMission: (...args) => {
        calls.push(args);
        return { progress, transcripts: restored, olderCursor: 'mission-older' };
      },
      resolveChain: () => {
        throw new Error('plain restore must not run');
      },
    },
  });

  harness.timeline.load('mission-provider');

  assert.deepEqual(calls, [['mission-app', { cursor: undefined }]]);
  assert.deepEqual(
    harness.recorded.map((event) => event.id),
    ['mission-first', 'mission-second'],
  );
  const page = harness.emitted[0];
  assert.equal(page?.type, 'session.history');
  if (page?.type !== 'session.history') return;
  assert.equal(page.appSessionId, 'mission-app');
  assert.deepEqual(page.progress, progress);
  assert.deepEqual(page.childSessions, childSessions);
  assert.equal(page.olderCursor, 'mission-older');
  assert.equal(page.mode, 'replace');
});

test('older restore prepends only transcripts and preserves page telemetry', () => {
  let childLinkReads = 0;
  const event = transcript('older');
  const harness = createHarness({
    summaries: [summary('app-1', 'provider-1')],
    loaders: {
      transcriptWindow: (_appSessionId, _chain, options) => {
        assert.deepEqual(options, { cursor: 'cursor-1' });
        return { events: [event], olderCursor: 'cursor-2' };
      },
    },
  });
  const timeline = new SessionTimeline({
    registry: {
      resolveSummary: () => summary('app-1', 'provider-1'),
      getCanonicalSummary: () => summary('app-1', 'provider-1'),
      getLive: () => undefined,
    },
    history: {
      recordEvent: (recorded) => {
        harness.recorded.push(recorded);
      },
    },
    getChildSessions: () => {
      childLinkReads += 1;
      return [];
    },
    emit: (emitted) => harness.emitted.push(emitted),
    emitError: (error) => harness.errors.push(error),
    loaders: {
      page: () => ({ events: [] }),
      hydrateMission: () => ({ progress: [], transcripts: [] }),
      resolveChain: () => ['provider-1'],
      transcriptWindow: (_appSessionId, _chain, options) => {
        assert.deepEqual(options, { cursor: 'cursor-1' });
        return { events: [event], olderCursor: 'cursor-2' };
      },
    },
  });

  timeline.load('provider-1', 'cursor-1');

  assert.equal(childLinkReads, 0);
  const page = harness.emitted[0];
  assert.equal(page?.type, 'session.history');
  if (page?.type !== 'session.history') return;
  assert.equal(page.mode, 'prepend');
  assert.deepEqual(page.progress, []);
  assert.equal(page.childSessions, undefined);
  assert.equal(page.olderCursor, 'cursor-2');
  assert.equal(page.loadedCount, 1);
  assert.equal(page.hasMore, true);
});

test('older failure emits an empty terminal prepend without an error', () => {
  const harness = createHarness({
    summaries: [summary('app-1', 'provider-1')],
    loaders: {
      transcriptWindow: () => {
        throw new Error('read failed');
      },
    },
  });

  harness.timeline.load('provider-1', 'cursor-1');

  assert.equal(harness.errors.length, 0);
  assert.equal(harness.emitted.length, 1);
  const page = harness.emitted[0];
  assert.equal(page?.type, 'session.history');
  if (page?.type !== 'session.history') return;
  assert.equal(page.mode, 'prepend');
  assert.deepEqual(page.transcripts, []);
  assert.equal(page.olderCursor, undefined);
  assert.equal(page.hasMore, false);
});

test('missing live history emits an authoritative empty replace page', () => {
  const childSessions = [child('app-live', 'worker-live', 'running')];
  const harness = createHarness({
    summaries: [summary('app-live', 'provider-live')],
    liveAppSessionIds: ['app-live'],
    childSessions,
    loaders: { resolveChain: () => [] },
  });

  harness.timeline.load('provider-live');

  assert.equal(harness.errors.length, 0);
  const page = harness.emitted[0];
  assert.equal(page?.type, 'session.history');
  if (page?.type !== 'session.history') return;
  assert.equal(page.mode, 'replace');
  assert.deepEqual(page.transcripts, []);
  assert.deepEqual(page.childSessions, childSessions);
  assert.equal(page.loadedCount, 0);
  assert.equal(page.hasMore, false);
});

test('non-live failure emits stable recoverable errors and permits retry', () => {
  let fail = true;
  const harness = createHarness({
    summaries: [summary('stable-app', 'provider-current')],
    loaders: {
      transcriptWindow: () => {
        if (fail) throw new Error('temporarily unavailable');
        return { events: [transcript('retry-success')] };
      },
    },
  });

  harness.timeline.load('provider-current');
  assert.equal(harness.emitted[0]?.type, 'session.history.error');
  assert.deepEqual(harness.errors, [
    {
      appSessionId: 'stable-app',
      message: 'temporarily unavailable',
      recoverable: true,
    },
  ]);

  fail = false;
  harness.timeline.load('provider-current');
  assert.equal(harness.emitted.at(-1)?.type, 'session.history');
});

test('recording failure prevents a history page after a partial write', () => {
  const harness = createHarness({
    summaries: [summary('stable-app', 'provider-current')],
    loaders: {
      transcriptWindow: () => ({
        events: [transcript('recorded-first'), transcript('recording-fails')],
      }),
    },
    onRecordEvent: (event) => {
      if (event.id === 'recording-fails') throw new Error('index unavailable');
    },
  });

  harness.timeline.load('provider-current');

  assert.deepEqual(
    harness.recorded.map((event) => event.id),
    ['recorded-first'],
  );
  assert.equal(
    harness.emitted.some((event) => event.type === 'session.history'),
    false,
  );
  assert.equal(harness.emitted[0]?.type, 'session.history.error');
  assert.deepEqual(harness.errors, [
    {
      appSessionId: 'stable-app',
      message: 'index unavailable',
      recoverable: true,
    },
  ]);
});

test('child history loads a canonical replace batch and reports replay failures for retry', () => {
  let fail = false;
  const events = [transcript('child-first'), transcript('child-second')];
  const harness = createHarness({
    loaders: {
      resolveChain: (appSessionId, providerSessionId) => {
        assert.deepEqual([appSessionId, providerSessionId], ['child-logical', 'child-provider']);
        return ['child-provider'];
      },
      transcriptWindow: (appSessionId, chain, options) => {
        assert.deepEqual(
          [appSessionId, chain, options],
          [
            'app-1',
            ['child-old', 'child-provider'],
            Object.assign(
              Object.defineProperty({}, 'cursor', { enumerable: true, value: undefined }),
              { role: 'worker' },
            ),
          ],
        );
        if (fail) throw new Error('not flushed');
        return { events, olderCursor: 'v2:0:1:0' };
      },
    },
  });

  harness.timeline.loadChildHistory({
    appSessionId: 'app-1',
    childSessionId: 'child-logical',
    childProviderSessionIds: ['child-old', 'child-provider'],
    role: 'worker',
  });

  assert.deepEqual(harness.trace, ['emit:session.history']);
  const page = harness.emitted[0];
  assert.equal(page?.type, 'session.history');
  if (page?.type !== 'session.history') return;
  assert.equal(page.appSessionId, 'app-1');
  assert.equal(page.childSessionId, 'child-logical');
  assert.equal(page.mode, 'replace');
  assert.equal(page.olderCursor, 'v2:0:1:0');
  assert.equal(page.loadedCount, 2);
  assert.equal(page.hasMore, true);
  assert.deepEqual(page.progress, []);
  assert.deepEqual(
    page.transcripts.map((event) => [event.appSessionId, event.sourceSessionId, event.role]),
    [
      ['app-1', 'child-logical', 'worker'],
      ['app-1', 'child-logical', 'worker'],
    ],
  );
  fail = true;
  harness.timeline.loadChildHistory({
    appSessionId: 'app-1',
    childSessionId: 'child-logical',
    childProviderSessionIds: ['child-old', 'child-provider'],
    role: 'worker',
  });
  assert.deepEqual(harness.errors.at(-1), {
    appSessionId: 'app-1',
    message: 'not flushed',
    recoverable: true,
  });
  assert.deepEqual(harness.emitted.at(-1), {
    type: 'session.history.error',
    appSessionId: 'app-1',
    childSessionId: 'child-logical',
    message: 'not flushed',
  });
});

test('a live child with no flushed provider file returns an empty successful history page', () => {
  const harness = createHarness({
    loaders: {
      resolveChain: () => [],
      transcriptWindow: (_appSessionId, chain) => {
        assert.deepEqual(chain, ['child-provider']);
        return { events: [] };
      },
    },
  });

  harness.timeline.loadChildHistory({
    appSessionId: 'app-1',
    childSessionId: 'child-logical',
    childProviderSessionIds: ['child-provider'],
    role: 'worker',
  });

  assert.equal(harness.errors.length, 0);
  assert.deepEqual(harness.emitted, [
    {
      type: 'session.history',
      appSessionId: 'app-1',
      childSessionId: 'child-logical',
      progress: [],
      transcripts: [],
      mode: 'replace',
      loadedCount: 0,
      hasMore: false,
    },
  ]);
});

test('child history older page prepends and reports cursor exhaustion', () => {
  const harness = createHarness({
    loaders: {
      resolveChain: () => ['child-provider'],
      transcriptWindow: (_appSessionId, _chain, options) =>
        options?.cursor === 'older' ? { events: [transcript('older')] } : { events: [] },
    },
  });

  harness.timeline.loadChildHistory({
    appSessionId: 'app-1',
    childSessionId: 'child-logical',
    childProviderSessionIds: ['child-provider'],
    role: 'validator',
    cursor: 'older',
    limit: 50,
  });
  harness.timeline.loadChildHistory({
    appSessionId: 'app-1',
    childSessionId: 'child-logical',
    childProviderSessionIds: ['child-provider'],
    role: 'validator',
    cursor: 'done',
    limit: 50,
  });

  const pages = harness.emitted.filter((event) => event.type === 'session.history');
  assert.equal(pages.length, 2);
  const first = pages[0];
  const second = pages[1];
  if (first?.type !== 'session.history' || second?.type !== 'session.history') return;
  assert.equal(first.mode, 'prepend');
  assert.equal(first.loadedCount, 1);
  assert.equal(first.hasMore, false);
  assert.equal(first.transcripts[0]?.sourceSessionId, 'child-logical');
  assert.equal(first.transcripts[0]?.role, 'validator');
  assert.equal(second.mode, 'prepend');
  assert.equal(second.loadedCount, 0);
  assert.equal(second.hasMore, false);
});

test('status appends keep unique IDs, clock behavior, compact type, source, and role', () => {
  const times = [100, 101, 100, 101];
  const harness = createHarness({ now: () => times.shift() ?? 0 });

  harness.timeline.appendStatus('app-1', 'first', 'auto', 'worker-1', 'worker');
  harness.timeline.appendStatus('app-1', 'second', undefined, 'validator-1', 'validator');

  assert.equal(harness.recorded.length, 2);
  const [first, second] = harness.recorded;
  assert.ok(first);
  assert.ok(second);
  assert.notEqual(first.id, second.id);
  assert.deepEqual(first, {
    id: 'status-2s-0',
    appSessionId: 'app-1',
    sourceSessionId: 'worker-1',
    role: 'worker',
    ts: 101,
    kind: 'status',
    text: 'first',
    compactType: 'auto',
  });
  assert.equal(second.sourceSessionId, 'validator-1');
  assert.equal(second.role, 'validator');
  assert.equal(second.compactType, undefined);
});

test('automatic compaction appends a persistent provider-identified divider', () => {
  const harness = createHarness({ now: () => 200 });

  harness.timeline.appendCompaction('app-1', 42, 'worker-1', 'worker', 'summary-1');

  assert.deepEqual(harness.recorded, [
    {
      id: 'compaction-worker-1-summary-1',
      appSessionId: 'app-1',
      sourceSessionId: 'worker-1',
      role: 'worker',
      ts: 200,
      kind: 'compaction',
      removedCount: 42,
      compactType: 'auto',
    },
  ]);
  assert.deepEqual(harness.trace, ['record:compaction-worker-1-summary-1', 'emit:event.appended']);
});

const CANONICAL_IDENTITY: CanonicalIdentity = {
  providerDriverKind: 'droid',
  providerInstanceId: 'droid',
  runtimeGeneration: 1,
};

function fakeStore(
  append: (event: CanonicalEvent) => PersistedCanonicalEvent,
): Pick<TranscriptStore, 'append'> {
  return { append };
}

test('recordAndEmit appends the canonical envelope then emits the projected persisted row', () => {
  const appended: CanonicalEvent[] = [];
  const { emitted, recorded, timeline, trace } = createHarness({
    canonicalIdentity: CANONICAL_IDENTITY,
    transcriptStore: fakeStore((event) => {
      appended.push(event);
      return { ...event, seq: 42 };
    }),
  });
  const event = transcript('event-1', 'app-1');

  timeline.append(event);

  assert.equal(recorded.length, 0);
  assert.equal(appended.length, 1);
  assert.equal(appended[0]?.eventId, 'event-1');
  assert.equal(appended[0]?.nativeCorrelation, undefined);
  assert.deepEqual(trace, ['emit:event.appended']);
  assert.equal(emitted[0]?.type, 'event.appended');
  if (emitted[0]?.type !== 'event.appended') return;
  assert.equal(emitted[0].event.id, 'event-1');
  assert.equal(emitted[0].event.seq, 42);
  assert.equal(emitted[0].event.ts, 1);
  assert.equal('providerDriverKind' in emitted[0].event, false);
  assert.equal('nativeCorrelation' in emitted[0].event, false);
});

test('a failed canonical append emits no undurable event', () => {
  const { emitted, errors, timeline } = createHarness({
    canonicalIdentity: CANONICAL_IDENTITY,
    transcriptStore: fakeStore(() => {
      throw new Error('disk full');
    }),
  });

  assert.throws(() => timeline.append(transcript('event-1', 'app-1')), /disk full/);
  assert.deepEqual(emitted, []);
  assert.deepEqual(errors, []);
});

test('a colliding canonical append emits no undurable event', () => {
  const { emitted, timeline } = createHarness({
    canonicalIdentity: CANONICAL_IDENTITY,
    transcriptStore: fakeStore(() => {
      throw new CanonicalEventCollisionError('event-1');
    }),
  });

  assert.throws(
    () => timeline.append(transcript('event-1', 'app-1')),
    CanonicalEventCollisionError,
  );
  assert.deepEqual(emitted, []);
});

test('flushStreaming accepts the shared shutdown deadline without replacing it', () => {
  const harness = createHarness();
  const deadline = ShutdownDeadline.fromDurationMs(1_000, 5);
  harness.timeline.flushStreaming(deadline);
  harness.timeline.flushStreaming(deadline);
});
