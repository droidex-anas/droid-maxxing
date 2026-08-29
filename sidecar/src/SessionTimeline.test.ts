import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type {
  ChildSessionSummary,
  ServerEvent,
  SessionSummary,
  TranscriptEvent,
} from './protocol.js';
import { SessionTimeline, type SessionTimelineRegistry } from './SessionTimeline.js';
import { droidSessionConfiguration } from './providers/providerIdentity.js';
import { ShutdownDeadline } from './providers/shutdownDeadline.js';
import {
  CanonicalEventCollisionError,
  TranscriptStore,
} from './persistence/TranscriptStore.js';
import { DroidexDatabase } from './persistence/DroidexDatabase.js';
import { SessionStore } from './persistence/SessionStore.js';
import {
  liftRendererTranscriptEvent,
  projectTranscriptEvent,
  type CanonicalEvent,
  type CanonicalIdentity,
  type PersistedCanonicalEvent,
} from './sessionEvents.js';

interface HarnessOptions {
  summaries?: SessionSummary[];
  liveAppSessionIds?: string[];
  childSessions?: ChildSessionSummary[];
  now?: () => number;
  onRecordEvent?: (event: TranscriptEvent) => boolean | void;
  transcriptStore?: Pick<TranscriptStore, 'append'> & Partial<Pick<TranscriptStore, 'page'>>;
  sessionStore?: SessionStore;
  canonicalIdentity?: CanonicalIdentity;
  streamingCoalesceMs?: number;
  streamingCoalesceMaxBytes?: number;
}

const CANONICAL_IDENTITY: CanonicalIdentity = {
  providerDriverKind: 'droid',
  providerInstanceId: 'droid',
  runtimeGeneration: 1,
};

function createHarness(options: HarnessOptions = {}) {
  const emitted: ServerEvent[] = [];
  const errors: Array<Omit<Extract<ServerEvent, { type: 'error' }>, 'type'>> = [];
  const recorded: TranscriptEvent[] = [];
  const trace: string[] = [];
  const summaries = options.summaries ?? [];
  const liveAppSessionIds = new Set(options.liveAppSessionIds ?? []);
  const resolve = (id: string) =>
    summaries.find(
      (liveSummary) =>
        liveSummary.appSessionId === id ||
        liveSummary.providerSessionId === id ||
        liveSummary.compactedFromProviderSessionIds?.includes(id),
    );
  const registry: SessionTimelineRegistry = {
    resolveSummary: resolve,
    getCanonicalSummary: resolve,
    getLive: (id) => (liveAppSessionIds.has(id) ? true : undefined),
  };
  let transcriptStore = options.transcriptStore;
  if (!transcriptStore && options.onRecordEvent) {
    transcriptStore = {
      append: (canonical) => {
        const projected = projectTranscriptEvent({ ...canonical, seq: recorded.length + 1 });
        if (!projected) throw new Error('unprojectable canonical event');
        trace.push(`record:${projected.id}`);
        options.onRecordEvent?.(projected);
        recorded.push(projected);
        return { ...canonical, seq: recorded.length };
      },
    };
  }
  const timeline = new SessionTimeline({
    registry,
    getChildSessions: () => options.childSessions ?? [],
    emit: (event) => {
      trace.push(`emit:${event.type}`);
      emitted.push(event);
      if (event.type === 'event.appended' && !transcriptStore) {
        recorded.push(event.event);
      }
    },
    emitError: (error) => {
      errors.push(error);
    },
    ...(options.now ? { now: options.now } : {}),
    ...(options.streamingCoalesceMs !== undefined
      ? { streamingCoalesceMs: options.streamingCoalesceMs }
      : {}),
    ...(options.streamingCoalesceMaxBytes !== undefined
      ? { streamingCoalesceMaxBytes: options.streamingCoalesceMaxBytes }
      : {}),
    ...(transcriptStore ? { transcriptStore } : {}),
    ...(options.canonicalIdentity
      ? { canonicalIdentity: options.canonicalIdentity }
      : transcriptStore
        ? { canonicalIdentity: CANONICAL_IDENTITY }
        : {}),
    ...(options.sessionStore ? { sessionStore: options.sessionStore } : {}),
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

  assert.deepEqual(trace, ['emit:event.appended', 'emit:event.appended']);
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

  assert.deepEqual(trace, ['emit:event.appended', 'emit:event.appended']);
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

  assert.deepEqual(trace, ['emit:event.appended']);
  assert.deepEqual(recorded, [event]);
  assert.deepEqual(emitted, [{ type: 'event.appended', event }]);
});


function withCanonicalStores(
  run: (stores: { sessionStore: SessionStore; transcriptStore: TranscriptStore }) => void,
): void {
  const dir = mkdtempSync(join(tmpdir(), 'droidex-timeline-'));
  const db = new DroidexDatabase(join(dir, 'state', 'droidex.sqlite'));
  try {
    run({
      sessionStore: new SessionStore(db),
      transcriptStore: new TranscriptStore(db),
    });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function seedStoredSession(store: SessionStore, liveSummary: SessionSummary): void {
  store.createProvisional({
    appSessionId: liveSummary.appSessionId,
    clientRef: `ref-${liveSummary.appSessionId}`,
    summary: liveSummary,
  });
  if (liveSummary.providerSessionId) {
    store.bindInitialProviderRuntime(liveSummary.appSessionId, 0, liveSummary.providerSessionId);
  }
  store.markStarted(liveSummary.appSessionId);
}

function seedChild(store: SessionStore, parentAppSessionId: string, childSessionId: string): void {
  store.upsertChild({
    parentAppSessionId,
    childSessionId,
    summary: {
      parentAppSessionId,
      childSessionId,
      role: 'worker',
      status: 'completed',
      modelId: 'model-default',
      transcriptAvailable: true,
      streamFidelity: 'state',
    },
    binding: {
      providerDriverKind: 'droid',
      providerInstanceId: 'droid',
      providerSessionId: childSessionId,
    },
  });
}

function seedTranscript(transcriptStore: TranscriptStore, event: TranscriptEvent): void {
  transcriptStore.append(liftRendererTranscriptEvent(event, CANONICAL_IDENTITY));
}

test('load serves canonical transcripts as a replace page with child links', () => {
  withCanonicalStores(({ sessionStore, transcriptStore }) => {
    const liveSummary = summary('app-1', 'provider-1');
    seedStoredSession(sessionStore, liveSummary);
    seedTranscript(transcriptStore, transcript('first', 'app-1'));
    seedTranscript(transcriptStore, transcript('second', 'app-1'));
    const childSessions = [child('app-1', 'worker-1', 'running')];
    const harness = createHarness({
      summaries: [liveSummary],
      childSessions,
      sessionStore,
      transcriptStore,
    });

    harness.timeline.load('app-1');

    const page = harness.emitted[0];
    assert.equal(page?.type, 'session.history');
    if (page?.type !== 'session.history') return;
    assert.equal(page.appSessionId, 'app-1');
    assert.equal(page.mode, 'replace');
    assert.equal(page.loadedCount, 2);
    assert.equal(page.hasMore, false);
    assert.deepEqual(
      page.transcripts.map((event) => event.id),
      ['first', 'second'],
    );
    assert.deepEqual(page.childSessions, childSessions);
  });
});

test('older load prepends transcripts and omits child links', () => {
  withCanonicalStores(({ sessionStore, transcriptStore }) => {
    const liveSummary = summary('app-1', 'provider-1');
    seedStoredSession(sessionStore, liveSummary);
    for (const id of ['oldest', 'middle', 'newest']) {
      seedTranscript(transcriptStore, transcript(id, 'app-1'));
    }
    const harness = createHarness({
      summaries: [liveSummary],
      childSessions: [child('app-1', 'worker-1', 'running')],
      sessionStore,
      transcriptStore,
    });

    harness.timeline.load('app-1', undefined, 2);
    const newest = harness.emitted[0];
    assert.equal(newest?.type, 'session.history');
    if (newest?.type !== 'session.history') return;
    assert.equal(newest.mode, 'replace');
    assert.equal(newest.hasMore, true);
    assert.ok(newest.olderCursor);

    harness.timeline.load('app-1', newest.olderCursor, 2);
    const older = harness.emitted[1];
    assert.equal(older?.type, 'session.history');
    if (older?.type !== 'session.history') return;
    assert.equal(older.mode, 'prepend');
    assert.equal(older.childSessions, undefined);
    assert.deepEqual(
      older.transcripts.map((event) => event.id),
      ['oldest'],
    );
    assert.equal(older.hasMore, false);
  });
});

test('load without a canonical store reports a recoverable error', () => {
  const harness = createHarness({ summaries: [summary('app-1', 'provider-1')] });
  harness.timeline.load('app-1');
  assert.equal(harness.emitted[0]?.type, 'session.history.error');
  assert.deepEqual(harness.errors, [
    {
      appSessionId: 'app-1',
      message: 'Canonical transcript store is required.',
      recoverable: true,
    },
  ]);
});

test('unknown app session load reports a recoverable error', () => {
  withCanonicalStores(({ sessionStore, transcriptStore }) => {
    const harness = createHarness({ sessionStore, transcriptStore });
    harness.timeline.load('missing');
    assert.equal(harness.emitted[0]?.type, 'session.history.error');
    assert.equal(harness.errors[0]?.appSessionId, 'missing');
    assert.equal(harness.errors[0]?.recoverable, true);
  });
});

test('a page failure is recoverable and permits retry', () => {
  withCanonicalStores(({ sessionStore, transcriptStore }) => {
    const liveSummary = summary('app-1', 'provider-1');
    seedStoredSession(sessionStore, liveSummary);
    seedTranscript(transcriptStore, transcript('retry-success', 'app-1'));
    let fail = true;
    const harness = createHarness({
      summaries: [liveSummary],
      sessionStore,
      transcriptStore: {
        append: (event) => transcriptStore.append(event),
        page: (input) => {
          if (fail) throw new Error('temporarily unavailable');
          return transcriptStore.page(input);
        },
      },
    });

    harness.timeline.load('app-1');
    assert.equal(harness.emitted[0]?.type, 'session.history.error');
    fail = false;
    harness.timeline.load('app-1');
    assert.equal(harness.emitted.at(-1)?.type, 'session.history');
  });
});

test('child history loads a canonical replace page and empty live history succeeds', () => {
  withCanonicalStores(({ sessionStore, transcriptStore }) => {
    seedStoredSession(sessionStore, summary('app-1', 'provider-1'));
    seedChild(sessionStore, 'app-1', 'child-logical');
    transcriptStore.append(
      liftRendererTranscriptEvent(
        {
          id: 'child-first',
          appSessionId: 'app-1',
          sourceSessionId: 'child-logical',
          role: 'worker',
          ts: 1,
          kind: 'text',
          text: 'child-first',
        },
        CANONICAL_IDENTITY,
      ),
    );
    transcriptStore.append(
      liftRendererTranscriptEvent(
        {
          id: 'child-second',
          appSessionId: 'app-1',
          sourceSessionId: 'child-logical',
          role: 'worker',
          ts: 2,
          kind: 'text',
          text: 'child-second',
        },
        CANONICAL_IDENTITY,
      ),
    );
    const harness = createHarness({ sessionStore, transcriptStore });
    harness.timeline.loadChildHistory({
      appSessionId: 'app-1',
      childSessionId: 'child-logical',
      childProviderSessionIds: ['child-provider'],
      role: 'worker',
    });
    const page = harness.emitted[0];
    assert.equal(page?.type, 'session.history');
    if (page?.type !== 'session.history') return;
    assert.equal(page.childSessionId, 'child-logical');
    assert.equal(page.mode, 'replace');
    assert.equal(page.loadedCount, 2);
    assert.deepEqual(
      page.transcripts.map((event) => [event.id, event.sourceSessionId, event.role]),
      [
        ['child-first', 'child-logical', 'worker'],
        ['child-second', 'child-logical', 'worker'],
      ],
    );

    harness.timeline.loadChildHistory({
      appSessionId: 'app-1',
      childSessionId: 'missing-child',
      childProviderSessionIds: ['missing'],
      role: 'worker',
    });
    const empty = harness.emitted.at(-1);
    assert.equal(empty?.type, 'session.history');
    if (empty?.type !== 'session.history') return;
    assert.equal(empty.childSessionId, 'missing-child');
    assert.equal(empty.loadedCount, 0);
    assert.equal(empty.hasMore, false);
  });
});

test('child history older page prepends until the cursor is exhausted', () => {
  withCanonicalStores(({ sessionStore, transcriptStore }) => {
    seedStoredSession(sessionStore, summary('app-1', 'provider-1'));
    seedChild(sessionStore, 'app-1', 'child-logical');
    for (const [id, ts] of [
      ['oldest', 1],
      ['middle', 2],
      ['newest', 3],
    ] as const) {
      transcriptStore.append(
        liftRendererTranscriptEvent(
          {
            id,
            appSessionId: 'app-1',
            sourceSessionId: 'child-logical',
            role: 'validator',
            ts,
            kind: 'text',
            text: id,
          },
          CANONICAL_IDENTITY,
        ),
      );
    }
    const harness = createHarness({ sessionStore, transcriptStore });
    harness.timeline.loadChildHistory({
      appSessionId: 'app-1',
      childSessionId: 'child-logical',
      childProviderSessionIds: ['child-provider'],
      role: 'validator',
      limit: 2,
    });
    const first = harness.emitted[0];
    assert.equal(first?.type, 'session.history');
    if (first?.type !== 'session.history') return;
    assert.equal(first.mode, 'replace');
    assert.equal(first.hasMore, true);

    harness.timeline.loadChildHistory({
      appSessionId: 'app-1',
      childSessionId: 'child-logical',
      childProviderSessionIds: ['child-provider'],
      role: 'validator',
      cursor: first.olderCursor,
      limit: 2,
    });
    const second = harness.emitted[1];
    assert.equal(second?.type, 'session.history');
    if (second?.type !== 'session.history') return;
    assert.equal(second.mode, 'prepend');
    assert.equal(second.loadedCount, 1);
    assert.equal(second.transcripts[0]?.id, 'oldest');
    assert.equal(second.hasMore, false);
  });
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
  assert.deepEqual(harness.trace, ['emit:event.appended']);
});

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
