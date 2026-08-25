import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { HistoryIndex, type PersistedChildSession } from './history.js';
import { HistoryPersistence } from './HistoryPersistence.js';
import type {
  HistoryPersistenceCall,
  HistoryPersistenceClient,
  HistorySearchClient,
} from './HistoryWorkerClient.js';
import type {
  HistoryPersistenceBatch,
  HistoryPersistenceResult,
} from './historyPersistenceProtocol.js';
import type { SessionSearchResult, SessionSummary, TranscriptEvent } from './protocol.js';
import { hotPathMetrics } from './telemetry/hotPathMetrics.js';
import { providerSessionJsonl } from './testing/providerSessionFixtures.js';
import { persistTestChild } from './testing/historyPersistenceFixture.js';

function summary(patch: Partial<SessionSummary> = {}): SessionSummary {
  return {
    appSessionId: 'app',
    providerSessionId: 'provider',
    sessionPurpose: 'chat',
    interactionMode: 'auto',
    role: 'primary',
    title: 'Durable session',
    goal: 'Persist settled state',
    cwd: '/repo',
    autonomy: 'low',
    phase: 'running',
    streaming: true,
    features: [],
    tokensIn: 0,
    tokensOut: 1,
    contextTokens: 1,
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}

function child(status: PersistedChildSession['status']): PersistedChildSession {
  return {
    parentAppSessionId: 'app',
    childSessionId: 'child',
    role: 'worker',
    status,
    modelId: 'model',
    transcriptAvailable: true,
    updatedAt: 1,
  };
}

test('a failed settlement is held while live transcript output continues until recovery', () => {
  const home = mkdtempSync(join(tmpdir(), 'droidex-history-persistence-'));
  const previousHome = process.env['HOME'];
  process.env['HOME'] = home;
  const persistence = new HistoryPersistence();
  try {
    persistence.syncSummaries([summary()]);

    const invalidSettlement = summary({ phase: 'paused', streaming: false, tokensOut: 2 });
    Object.defineProperty(invalidSettlement, 'title', { value: undefined });
    assert.equal(persistence.syncSummaries([invalidSettlement]), false);

    assert.doesNotThrow(() =>
      persistence.recordEvent({
        id: 'live-after-boundary-failure',
        appSessionId: 'app',
        sourceSessionId: 'app',
        role: 'primary',
        ts: 2,
        kind: 'text',
        text: 'live output continues',
      }),
    );

    assert.equal(
      persistence.syncSummaries([summary({ phase: 'paused', streaming: false, tokensOut: 2 })]),
      false,
    );
    persistence.flushSync();

    const db = new DatabaseSync(join(home, '.factory', 'droidex', 'session-index.sqlite'), {
      readOnly: true,
    });
    try {
      const row = db
        .prepare('SELECT tokens_out FROM app_sessions WHERE app_session_id = ?')
        .get('app') as { tokens_out: number };
      assert.equal(row.tokens_out, 2);
    } finally {
      db.close();
    }
  } finally {
    persistence.close();
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test('a failed child settlement is held until a later strict boundary recovers durability', () => {
  const home = mkdtempSync(join(tmpdir(), 'droidex-child-persistence-'));
  const previousHome = process.env['HOME'];
  process.env['HOME'] = home;
  const persistence = new HistoryPersistence();
  try {
    persistence.upsertChildSession(child('running'));
    persistence.flushSync();

    const invalidSettlement = child('paused');
    Object.defineProperty(invalidSettlement, 'modelId', { value: undefined });
    assert.equal(persistence.upsertChildSession(invalidSettlement), false);

    assert.equal(persistence.upsertChildSession(child('paused')), false);
    persistence.flushSync();

    const db = new DatabaseSync(join(home, '.factory', 'droidex', 'session-index.sqlite'), {
      readOnly: true,
    });
    try {
      const row = db
        .prepare(
          'SELECT status FROM child_sessions WHERE parent_app_session_id = ? AND child_session_id = ?',
        )
        .get('app', 'child') as { status: string };
      assert.equal(row.status, 'paused');
    } finally {
      db.close();
    }
  } finally {
    persistence.close();
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test('a hydrated running child replacement crosses a durability boundary', () => {
  const home = mkdtempSync(join(tmpdir(), 'droidex-hydrated-child-durability-'));
  const previousHome = process.env['HOME'];
  process.env['HOME'] = home;
  new HistoryIndex().close();
  persistTestChild({
    ...child('running'),
    providerSessionId: 'provider-old',
    previousProviderSessionIds: [],
  });
  const persistence = new HistoryPersistence();
  try {
    assert.equal(persistence.childSession('app', 'child')?.providerSessionId, 'provider-old');
    hotPathMetrics.reset();
    assert.equal(
      persistence.upsertChildSession({
        ...child('running'),
        providerSessionId: 'provider-new',
        previousProviderSessionIds: ['provider-old'],
      }),
      true,
    );
    assert.equal(hotPathMetrics.snapshot().histograms.persistenceBoundaryMs.count, 1);
  } finally {
    persistence.close();
    hotPathMetrics.reset();
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test('search excludes session files that the canonical history cache did not admit', async () => {
  const home = mkdtempSync(join(tmpdir(), 'droidex-history-search-'));
  const previousHome = process.env['HOME'];
  process.env['HOME'] = home;
  const persistence = new HistoryPersistence();
  try {
    const sessionsDirectory = join(home, '.factory', 'sessions', '2026', '08');
    mkdirSync(sessionsDirectory, { recursive: true });
    writeFileSync(
      join(sessionsDirectory, 'abandoned.jsonl'),
      providerSessionJsonl(
        {
          type: 'session_start',
          cwd: '/repo',
          sessionTitle: 'Abandoned session',
          settings: { interactionMode: 'auto' },
        },
        ['user'],
      ),
    );

    await persistence.reconcileSessionFiles();

    assert.deepEqual(await persistence.searchSessions('hello'), []);
  } finally {
    persistence.close();
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test('search results resolve through pending in-memory provider aliases', async () => {
  const home = mkdtempSync(join(tmpdir(), 'droidex-history-search-alias-overlay-'));
  const previousHome = process.env['HOME'];
  process.env['HOME'] = home;
  const searchClient: HistorySearchClient = {
    reconcileSessionFiles: async () => ({
      previousRevision: 0,
      revision: 0,
      changed: 0,
      upserts: [],
      removedProviderSessionIds: [],
    }),
    reconcileSessionFilePaths: async () => ({
      previousRevision: 0,
      revision: 0,
      changed: 0,
      upserts: [],
      removedProviderSessionIds: [],
    }),
    sessionFileSnapshot: async () => ({ revision: 0, changed: 0, entries: [] }),
    setIndexingIdle: async () => undefined,
    search: async () => [
      {
        appSessionId: 'provider',
        matches: [{ snippet: 'pending alias needle', author: 'user', ts: 1 }],
      },
    ],
    closeSync: () => undefined,
  };
  const persistence = new HistoryPersistence({ searchClient });
  try {
    persistence.syncSummaries([summary({ appSessionId: 'stable-app' })]);
    persistence.syncSummaries([
      summary({ appSessionId: 'stable-app', title: 'Pending overlay', tokensOut: 2 }),
    ]);

    assert.equal((await persistence.searchSessions('needle'))[0]?.appSessionId, 'stable-app');
  } finally {
    persistence.close();
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test('reconciliation awaits the index worker and applies its delta to the live historical cache', async () => {
  const home = mkdtempSync(join(tmpdir(), 'droidex-history-worker-reconcile-'));
  const previousHome = process.env['HOME'];
  process.env['HOME'] = home;
  let reconciles = 0;
  const historical = summary({
    appSessionId: 'historical-app',
    providerSessionId: 'historical-provider',
    title: 'Worker reconciled history',
    phase: 'paused',
    streaming: false,
  });
  const searchClient: HistorySearchClient = {
    reconcileSessionFiles: async () => {
      reconciles += 1;
      await new Promise<void>((resolve) => setImmediate(resolve));
      return {
        previousRevision: 0,
        revision: 1,
        changed: 1,
        upserts: [
          {
            providerSessionId: 'historical-provider',
            path: '/sessions/historical-provider.jsonl',
            birthtimeMs: 1,
            mtimeMs: 2,
            sizeBytes: 3,
            settingsMtimeMs: null,
            summary: historical,
          },
        ],
        removedProviderSessionIds: [],
      };
    },
    reconcileSessionFilePaths: async () => ({
      previousRevision: 1,
      revision: 1,
      changed: 0,
      upserts: [],
      removedProviderSessionIds: [],
    }),
    sessionFileSnapshot: async () => ({ revision: 1, changed: 0, entries: [] }),
    setIndexingIdle: async () => undefined,
    search: async () => [],
    closeSync: () => undefined,
  };
  const persistence = new HistoryPersistence({ searchClient });
  try {
    const operation = persistence.reconcileSessionFiles();
    assert.ok(operation instanceof Promise, 'raw reconciliation stays off the caller thread');
    assert.deepEqual(persistence.listHistoricalSessions({ workspaceCwds: ['/repo'] }), []);

    assert.equal(await operation, 1);
    assert.equal(reconciles, 1);
    assert.equal(
      persistence.listHistoricalSessions({ workspaceCwds: ['/repo'] })[0]?.summary.title,
      'Worker reconciled history',
    );
  } finally {
    persistence.close();
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test('a reconciliation revision gap replaces the main cache from an authoritative snapshot', async () => {
  const home = mkdtempSync(join(tmpdir(), 'droidex-history-worker-resync-'));
  const previousHome = process.env['HOME'];
  process.env['HOME'] = home;
  const oldEntry = {
    providerSessionId: 'old-provider',
    path: '/sessions/old-provider.jsonl',
    birthtimeMs: 1,
    mtimeMs: 1,
    sizeBytes: 1,
    settingsMtimeMs: null,
    summary: summary({
      appSessionId: 'old-app',
      providerSessionId: 'old-provider',
      title: 'Old session',
      phase: 'paused',
      streaming: false,
    }),
  };
  const newEntry = {
    ...oldEntry,
    providerSessionId: 'new-provider',
    path: '/sessions/new-provider.jsonl',
    summary: summary({
      appSessionId: 'new-app',
      providerSessionId: 'new-provider',
      title: 'Recovered session',
      phase: 'paused',
      streaming: false,
    }),
  };
  let snapshotRequests = 0;
  const searchClient: HistorySearchClient = {
    reconcileSessionFiles: async () => ({
      previousRevision: 0,
      revision: 1,
      changed: 1,
      upserts: [oldEntry],
      removedProviderSessionIds: [],
    }),
    reconcileSessionFilePaths: async () => ({
      previousRevision: 2,
      revision: 3,
      changed: 1,
      upserts: [newEntry],
      removedProviderSessionIds: [],
    }),
    sessionFileSnapshot: async () => {
      snapshotRequests += 1;
      return { revision: 3, changed: 0, entries: [newEntry] };
    },
    setIndexingIdle: async () => undefined,
    search: async () => [],
    closeSync: () => undefined,
  };
  const persistence = new HistoryPersistence({ searchClient });
  try {
    await persistence.reconcileSessionFiles();
    assert.equal(await persistence.reconcileSessionFilePaths([]), 1);
    assert.equal(snapshotRequests, 1);
    assert.deepEqual(
      persistence
        .listHistoricalSessions({ workspaceCwds: ['/repo'] })
        .map((item) => item.summary.title),
      ['Recovered session'],
    );
  } finally {
    persistence.close();
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test('an active search cannot delay a synchronous persistence boundary', async () => {
  const home = mkdtempSync(join(tmpdir(), 'droidex-history-lanes-'));
  const previousHome = process.env['HOME'];
  process.env['HOME'] = home;
  let resolveSearch: ((results: SessionSearchResult[]) => void) | undefined;
  const searchClient: HistorySearchClient = {
    reconcileSessionFiles: async () => ({
      previousRevision: 0,
      revision: 0,
      changed: 0,
      upserts: [],
      removedProviderSessionIds: [],
    }),
    reconcileSessionFilePaths: async () => ({
      previousRevision: 0,
      revision: 0,
      changed: 0,
      upserts: [],
      removedProviderSessionIds: [],
    }),
    sessionFileSnapshot: async () => ({ revision: 0, changed: 0, entries: [] }),
    setIndexingIdle: async () => undefined,
    search: () =>
      new Promise<SessionSearchResult[]>((resolve) => {
        resolveSearch = resolve;
      }),
    closeSync: () => undefined,
  };
  const persisted: HistoryPersistenceBatch[] = [];
  const persistenceClient: HistoryPersistenceClient = {
    startPersist: (batch): HistoryPersistenceCall<HistoryPersistenceResult> => {
      persisted.push(batch);
      const result = {
        durationMs: 1,
        eventsWritten: batch.events.length,
        summariesWritten: batch.summaries.length,
        childrenWritten: batch.children.length,
      };
      return { promise: Promise.resolve(result), waitSync: () => result };
    },
    startDurabilityBarrier: () => {
      const result = { durable: true } as const;
      return { promise: Promise.resolve(result), waitSync: () => result };
    },
    closeSync: () => undefined,
  };
  const persistence = new HistoryPersistence({ persistenceClient, searchClient });
  try {
    const search = persistence.searchSessions('needle');
    await new Promise<void>((resolve) => setImmediate(resolve));

    const event: TranscriptEvent = {
      id: 'during-search',
      appSessionId: 'app',
      sourceSessionId: 'app',
      role: 'primary',
      ts: 1,
      kind: 'text',
      text: 'live output',
    };
    persistence.recordEvent(event);
    persistence.flushSync();

    assert.deepEqual(
      persisted.flatMap((batch) => batch.events.map((item) => item.id)),
      ['during-search'],
    );
    resolveSearch?.([]);
    await search;
  } finally {
    persistence.close();
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test('live transcript work pauses an idle history backfill until the next desktop sample', async () => {
  const home = mkdtempSync(join(tmpdir(), 'droidex-history-idle-pause-'));
  const previousHome = process.env['HOME'];
  process.env['HOME'] = home;
  const idleStates: boolean[] = [];
  const searchClient: HistorySearchClient = {
    reconcileSessionFiles: async () => ({
      previousRevision: 0,
      revision: 0,
      changed: 0,
      upserts: [],
      removedProviderSessionIds: [],
    }),
    reconcileSessionFilePaths: async () => ({
      previousRevision: 0,
      revision: 0,
      changed: 0,
      upserts: [],
      removedProviderSessionIds: [],
    }),
    sessionFileSnapshot: async () => ({ revision: 0, changed: 0, entries: [] }),
    setIndexingIdle: async (isIdle) => {
      idleStates.push(isIdle);
    },
    search: async () => [],
    closeSync: () => undefined,
  };
  const persistence = new HistoryPersistence({ searchClient });
  try {
    await persistence.setIndexingIdle(true);
    persistence.recordEvent({
      id: 'live-event',
      appSessionId: 'app',
      sourceSessionId: 'app',
      role: 'primary',
      ts: 1,
      kind: 'text',
      text: 'live work wins',
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.deepEqual(idleStates, [true, false]);
  } finally {
    persistence.close();
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test('desktop idle samples do not resume archive indexing while live work is active', async () => {
  const home = mkdtempSync(join(tmpdir(), 'droidex-history-idle-active-'));
  const previousHome = process.env['HOME'];
  process.env['HOME'] = home;
  const idleStates: boolean[] = [];
  const searchClient: HistorySearchClient = {
    reconcileSessionFiles: async () => ({
      previousRevision: 0,
      revision: 0,
      changed: 0,
      upserts: [],
      removedProviderSessionIds: [],
    }),
    reconcileSessionFilePaths: async () => ({
      previousRevision: 0,
      revision: 0,
      changed: 0,
      upserts: [],
      removedProviderSessionIds: [],
    }),
    sessionFileSnapshot: async () => ({ revision: 0, changed: 0, entries: [] }),
    setIndexingIdle: async (isIdle) => {
      idleStates.push(isIdle);
    },
    search: async () => [],
    closeSync: () => undefined,
  };
  const persistence = new HistoryPersistence({ searchClient });
  try {
    persistence.syncSummaries([summary()]);
    await persistence.setIndexingIdle(true);

    persistence.syncSummaries([summary({ streaming: false })]);
    persistence.upsertChildSession(child('running'));
    await persistence.setIndexingIdle(true);

    persistence.upsertChildSession(child('completed'));
    await persistence.setIndexingIdle(true);

    assert.deepEqual(idleStates, [false, false, true]);
  } finally {
    persistence.close();
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test('reconciliation drains pending commits without running a durability barrier', async () => {
  const home = mkdtempSync(join(tmpdir(), 'droidex-history-reconcile-drain-'));
  const previousHome = process.env['HOME'];
  process.env['HOME'] = home;
  hotPathMetrics.reset();
  const persisted: string[][] = [];
  let barriers = 0;
  let allowBarrier = false;
  const persistenceClient: HistoryPersistenceClient = {
    startPersist: (batch) => {
      persisted.push(batch.events.map((item) => item.id));
      const result: HistoryPersistenceResult = {
        durationMs: 1,
        eventsWritten: batch.events.length,
        summariesWritten: batch.summaries.length,
        childrenWritten: batch.children.length,
      };
      return {
        promise: Promise.resolve(result),
        waitSync: () => {
          throw new Error('reconciliation must not synchronously wait for persistence');
        },
      };
    },
    startDurabilityBarrier: () => {
      barriers += 1;
      const result = { durable: true } as const;
      const promise = allowBarrier
        ? Promise.resolve(result)
        : Promise.reject(new Error('unexpected barrier'));
      void promise.catch(() => undefined);
      return {
        promise,
        waitSync: () => {
          if (!allowBarrier) throw new Error('unexpected barrier');
          return result;
        },
      };
    },
    closeSync: () => undefined,
  };
  const persistence = new HistoryPersistence({ persistenceClient });
  try {
    persistence.recordEvent({
      id: 'pending-before-reconcile',
      appSessionId: 'app',
      sourceSessionId: 'app',
      role: 'primary',
      ts: 1,
      kind: 'text',
      text: 'live output',
    });

    await assert.doesNotReject(persistence.reconcileSessionFiles());
    assert.deepEqual(persisted, [['pending-before-reconcile']]);
    assert.equal(barriers, 0);
    assert.equal(hotPathMetrics.snapshot().histograms.persistenceBoundaryMs.count, 0);

    allowBarrier = true;
    persistence.flushSync();
    assert.equal(barriers, 1);
    assert.equal(hotPathMetrics.snapshot().histograms.persistenceBoundaryMs.count, 1);
  } finally {
    allowBarrier = true;
    persistence.close();
    hotPathMetrics.reset();
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test('forgetSession removes live summary and child overlays', () => {
  const home = mkdtempSync(join(tmpdir(), 'droidex-history-forget-'));
  const previousHome = process.env['HOME'];
  process.env['HOME'] = home;
  const persistenceClient: HistoryPersistenceClient = {
    startPersist: (batch) => {
      const result: HistoryPersistenceResult = {
        durationMs: 1,
        eventsWritten: batch.events.length,
        summariesWritten: batch.summaries.length,
        childrenWritten: batch.children.length,
      };
      return { promise: Promise.resolve(result), waitSync: () => result };
    },
    startDurabilityBarrier: () => {
      const result = { durable: true } as const;
      return { promise: Promise.resolve(result), waitSync: () => result };
    },
    closeSync: () => undefined,
  };
  const persistence = new HistoryPersistence({ persistenceClient });
  try {
    persistence.syncSummaries([summary()]);
    persistence.syncSummaries([summary({ tokensIn: 2 })]);
    persistence.upsertChildSession(child('running'));

    assert.equal(persistence.summaryPatchesAndHidden().patches.get('app')?.tokensIn, 2);
    assert.deepEqual(
      persistence.childSessions('app').map((item) => item.childSessionId),
      ['child'],
    );

    persistence.forgetSession('app');

    assert.equal(persistence.summaryPatchesAndHidden().patches.has('app'), false);
    assert.deepEqual(persistence.childSessions('app'), []);
  } finally {
    persistence.close();
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test('persistence reports degraded state once and reports recovery after retained work commits', () => {
  const home = mkdtempSync(join(tmpdir(), 'droidex-history-status-'));
  const previousHome = process.env['HOME'];
  process.env['HOME'] = home;
  const statuses: string[] = [];
  let attempts = 0;
  const persistenceClient: HistoryPersistenceClient = {
    startPersist: (batch) => {
      attempts += 1;
      const result: HistoryPersistenceResult = {
        durationMs: 1,
        eventsWritten: batch.events.length,
        summariesWritten: batch.summaries.length,
        childrenWritten: batch.children.length,
      };
      const failure = attempts === 1 ? new Error('worker exited') : null;
      return {
        promise: failure ? Promise.reject(failure) : Promise.resolve(result),
        waitSync: () => {
          if (failure) throw failure;
          return result;
        },
      };
    },
    startDurabilityBarrier: () => {
      const result = { durable: true } as const;
      return { promise: Promise.resolve(result), waitSync: () => result };
    },
    closeSync: () => undefined,
  };
  const searchClient: HistorySearchClient = {
    reconcileSessionFiles: async () => ({
      previousRevision: 0,
      revision: 0,
      changed: 0,
      upserts: [],
      removedProviderSessionIds: [],
    }),
    reconcileSessionFilePaths: async () => ({
      previousRevision: 0,
      revision: 0,
      changed: 0,
      upserts: [],
      removedProviderSessionIds: [],
    }),
    sessionFileSnapshot: async () => ({ revision: 0, changed: 0, entries: [] }),
    setIndexingIdle: async () => undefined,
    search: async () => [],
    closeSync: () => undefined,
  };
  const persistence = new HistoryPersistence({
    persistenceClient,
    searchClient,
    onStatusChanged: (status) => statuses.push(status.state),
  });
  const first: TranscriptEvent = {
    id: 'one',
    appSessionId: 'app',
    sourceSessionId: 'app',
    role: 'primary',
    ts: 1,
    kind: 'text',
    text: 'one',
  };
  try {
    persistence.recordEvent(first);
    assert.throws(() => persistence.flushSync(), /worker exited/);
    assert.doesNotThrow(() => persistence.recordEvent({ ...first, id: 'two', text: 'two' }));
    persistence.flushSync();

    assert.deepEqual(statuses, ['degraded', 'healthy']);
  } finally {
    persistence.close();
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test('persistence does not start the independent search worker until the first search', async () => {
  const home = mkdtempSync(join(tmpdir(), 'droidex-lazy-search-worker-'));
  const previousHome = process.env['HOME'];
  process.env['HOME'] = home;
  let searchWorkersCreated = 0;
  const searchClient: HistorySearchClient = {
    reconcileSessionFiles: async () => ({
      previousRevision: 0,
      revision: 0,
      changed: 0,
      upserts: [],
      removedProviderSessionIds: [],
    }),
    reconcileSessionFilePaths: async () => ({
      previousRevision: 0,
      revision: 0,
      changed: 0,
      upserts: [],
      removedProviderSessionIds: [],
    }),
    sessionFileSnapshot: async () => ({ revision: 0, changed: 0, entries: [] }),
    setIndexingIdle: async () => undefined,
    search: async () => [],
    closeSync: () => undefined,
  };
  const persistence = new HistoryPersistence({
    createSearchClient: () => {
      searchWorkersCreated += 1;
      return searchClient;
    },
  });
  try {
    persistence.flushSync();
    assert.equal(searchWorkersCreated, 0);

    await persistence.searchSessions('needle');
    assert.equal(searchWorkersCreated, 1);
  } finally {
    persistence.close();
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});
