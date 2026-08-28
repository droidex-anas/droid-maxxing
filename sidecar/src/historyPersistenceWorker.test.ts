import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Worker } from 'node:worker_threads';

import { HistoryPersistenceQueue } from './HistoryPersistenceQueue.js';
import { HistoryWorkerClient } from './HistoryWorkerClient.js';
import { HistoryPersistence } from './HistoryPersistence.js';
import { SESSION_INDEX_FILENAME, SESSION_SEARCH_INDEX_FILENAME } from './history.js';
import type { HistoryPersistenceBatch } from './historyPersistenceProtocol.js';
import type { SessionSummary } from './protocol.js';
import { droidSessionConfiguration } from './providers/providerIdentity.js';
import {
  HistorySearchUnavailableError,
  isHistorySearchUnavailableError,
  sqliteFts5UnavailableSkipReason,
} from './historySearchSchema.js';
import { providerSessionJsonl } from './testing/providerSessionFixtures.js';

// Leave cold-worker headroom while staying below the search DB's 5s lock wait.
const LOCKED_DERIVED_DB_PROBE_TIMEOUT_MS = 3_000;
const FTS5_UNAVAILABLE_REASON = sqliteFts5UnavailableSkipReason();

function createSchema(path: string): void {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE app_sessions (
      app_session_id TEXT PRIMARY KEY,
      provider_session_id TEXT NOT NULL,
      compacted_from_provider_session_ids TEXT NOT NULL DEFAULT '[]',
      session_purpose TEXT NOT NULL,
      interaction_mode TEXT NOT NULL,
      title TEXT NOT NULL,
      cwd TEXT,
      workspace_kind TEXT,
      updated_at INTEGER NOT NULL,
      model_id TEXT,
      reasoning_effort TEXT,
      compaction_model TEXT,
      worker_model_id TEXT,
      worker_reasoning_effort TEXT,
      validator_model_id TEXT,
      validator_reasoning_effort TEXT,
      autonomy TEXT,
      tokens_in INTEGER NOT NULL DEFAULT 0,
      tokens_out INTEGER NOT NULL DEFAULT 0,
      context_tokens INTEGER NOT NULL DEFAULT 0,
      context_remaining_tokens INTEGER,
      context_accuracy TEXT,
      context_updated_at TEXT,
      max_context_tokens INTEGER,
      auto_compactions INTEGER
    );
    CREATE TABLE child_sessions (
      parent_app_session_id TEXT NOT NULL,
      child_session_id TEXT NOT NULL,
      provider_session_id TEXT,
      previous_provider_session_ids TEXT NOT NULL DEFAULT '[]',
      role TEXT NOT NULL CHECK (role IN ('worker', 'validator')),
      label TEXT,
      prompt TEXT,
      status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'paused', 'completed')),
      model_id TEXT NOT NULL,
      reasoning_effort TEXT,
      spawn_link_kind TEXT CHECK (spawn_link_kind IN ('tool-use', 'spawn')),
      spawn_link_id TEXT,
      transcript_available INTEGER NOT NULL CHECK (transcript_available IN (0, 1)),
      started_at INTEGER,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (parent_app_session_id, child_session_id)
    );
    CREATE TABLE events (
      id TEXT PRIMARY KEY,
      source_session_id TEXT NOT NULL,
      app_session_id TEXT,
      kind TEXT NOT NULL,
      ts INTEGER NOT NULL
    );
    CREATE TABLE settings (
      scope TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  db.close();
}

function summary(): SessionSummary {
  return {
    appSessionId: 'app',
    providerSessionId: 'provider',
    sessionPurpose: 'chat',
    role: 'primary',
    title: 'Worker-backed persistence',
    goal: 'Persist off the orchestration thread',
    cwd: '/repo',
    configuration: droidSessionConfiguration({
      modelId: 'model-default',
      interactionMode: 'auto',
      autonomy: 'low',
    }),
    phase: 'paused',
    features: [],
    tokensIn: 10,
    tokensOut: 20,
    contextTokens: 30,
    createdAt: 1,
    updatedAt: 2,
  };
}

test('worker persists a complete batch and supports synchronous durability waits', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'droidex-history-worker-'));
  const dbPath = join(dir, 'history.sqlite');
  let client: HistoryWorkerClient | undefined;
  try {
    createSchema(dbPath);
    client = new HistoryWorkerClient({
      workerData: { dbPath, lane: 'persistence' },
    });
    const batch: HistoryPersistenceBatch = {
      events: [{ id: 'event', sourceSessionId: 'app', appSessionId: 'app', kind: 'text', ts: 1 }],
      summaries: [summary()],
      children: [],
      estimatedBytes: 1_024,
    };

    const result = client.startPersist(batch).waitSync();
    assert.equal(result.eventsWritten, 1);
    assert.equal(result.summariesWritten, 1);
    assert.ok((result.initializationMs ?? -1) >= 0);

    const db = new DatabaseSync(dbPath, { readOnly: true });
    assert.equal(
      (
        db.prepare('SELECT tokens_out FROM app_sessions WHERE app_session_id = ?').get('app') as {
          tokens_out: number;
        }
      ).tokens_out,
      20,
    );
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS count FROM events').get() as { count: number }).count,
      1,
    );
    db.close();
  } finally {
    client?.closeSync();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a locked derived search database cannot delay canonical durability', () => {
  const dir = mkdtempSync(join(tmpdir(), 'droidex-history-worker-lanes-'));
  const dbPath = join(dir, 'history.sqlite');
  const derivedPath = join(dir, SESSION_SEARCH_INDEX_FILENAME);
  let derived: DatabaseSync | undefined;
  let client: HistoryWorkerClient | undefined;
  try {
    createSchema(dbPath);
    derived = new DatabaseSync(derivedPath);
    derived.exec('CREATE TABLE lock_holder (id INTEGER PRIMARY KEY); BEGIN IMMEDIATE');
    client = new HistoryWorkerClient({ workerData: { dbPath, lane: 'persistence' } });
    const result = client
      .startPersist({
        events: [],
        summaries: [summary()],
        children: [],
        estimatedBytes: 1_024,
      })
      .waitSync(LOCKED_DERIVED_DB_PROBE_TIMEOUT_MS);
    assert.equal(result.summariesWritten, 1);
    assert.deepEqual(client.startDurabilityBarrier().waitSync(LOCKED_DERIVED_DB_PROBE_TIMEOUT_MS), {
      durable: true,
    });
  } finally {
    try {
      derived?.exec('ROLLBACK');
    } catch {
      // The assertion failure remains authoritative.
    }
    derived?.close();
    client?.closeSync();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('worker lanes reject requests from the other persistence contract', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'droidex-history-worker-lane-contract-'));
  const dbPath = join(dir, 'history.sqlite');
  let searchClient: HistoryWorkerClient | undefined;
  try {
    createSchema(dbPath);
    searchClient = new HistoryWorkerClient({
      workerData: { dbPath, lane: 'search' },
    });
    await assert.rejects(
      searchClient.startPersist({ events: [], summaries: [], children: [], estimatedBytes: 0 })
        .promise,
      /search worker cannot handle persist/,
    );
  } finally {
    searchClient?.closeSync();
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  'index worker reconciles, searches, and removes provider files without candidate payloads',
  { skip: FTS5_UNAVAILABLE_REASON },
  async () => {
    const home = mkdtempSync(join(tmpdir(), 'droidex-history-index-worker-'));
    const previousHome = process.env['HOME'];
    process.env['HOME'] = home;
    const databaseDirectory = join(home, '.factory', 'droidex');
    const sessionsDirectory = join(home, '.factory', 'sessions', '2026', '08');
    mkdirSync(databaseDirectory, { recursive: true });
    mkdirSync(sessionsDirectory, { recursive: true });
    const dbPath = join(databaseDirectory, 'session-index.sqlite');
    const providerSessionId = 'indexed-provider';
    const sessionPath = join(sessionsDirectory, `${providerSessionId}.jsonl`);
    writeFileSync(
      sessionPath,
      providerSessionJsonl({
        type: 'session_start',
        cwd: '/repo',
        sessionTitle: 'Indexed worker session',
        settings: { interactionMode: 'auto' },
      }),
    );
    let client: HistoryWorkerClient | undefined;
    try {
      createSchema(dbPath);
      client = new HistoryWorkerClient({ workerData: { dbPath, lane: 'search' } });

      const reconciliation = await client.reconcileSessionFiles();
      assert.equal(reconciliation.changed, 1);
      assert.equal(reconciliation.upserts[0]?.providerSessionId, providerSessionId);
      const firstSearch = await client.search('hello');
      assert.deepEqual(
        firstSearch.results,
        [],
        'search does not block on an uncommitted indexing slice',
      );
      assert.equal(firstSearch.indexingIncomplete, true);

      unlinkSync(sessionPath);
      const removal = await client.reconcileSessionFilePaths([
        { providerSessionId, path: sessionPath },
      ]);
      assert.deepEqual(removal.removedProviderSessionIds, [providerSessionId]);
      const afterRemoval = await client.search('hello');
      assert.deepEqual(afterRemoval.results, []);
      assert.equal(afterRemoval.indexingIncomplete, false);
    } finally {
      client?.closeSync();
      if (previousHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = previousHome;
      rmSync(home, { recursive: true, force: true });
    }
  },
);

test(
  'a recreated index worker rebuilds derived search state before a targeted no-op',
  { skip: FTS5_UNAVAILABLE_REASON },
  async () => {
    const home = mkdtempSync(join(tmpdir(), 'droidex-history-index-backfill-'));
    const previousHome = process.env['HOME'];
    process.env['HOME'] = home;
    const databaseDirectory = join(home, '.factory', 'droidex');
    const sessionsDirectory = join(home, '.factory', 'sessions');
    mkdirSync(databaseDirectory, { recursive: true });
    mkdirSync(sessionsDirectory, { recursive: true });
    const dbPath = join(databaseDirectory, 'session-index.sqlite');
    const providerSessionId = 'backfill-provider';
    const sessionPath = join(sessionsDirectory, `${providerSessionId}.jsonl`);
    writeFileSync(
      sessionPath,
      providerSessionJsonl({
        type: 'session_start',
        cwd: '/repo',
        sessionTitle: 'Backfill worker session',
        settings: { interactionMode: 'auto' },
      }),
    );
    let first: HistoryWorkerClient | undefined;
    let recreated: HistoryWorkerClient | undefined;
    try {
      createSchema(dbPath);
      first = new HistoryWorkerClient({ workerData: { dbPath, lane: 'search' } });
      await first.reconcileSessionFiles();
      first.closeSync();

      const db = new DatabaseSync(join(databaseDirectory, SESSION_SEARCH_INDEX_FILENAME));
      db.exec(`
      DROP TABLE history_search_fts;
      DROP TABLE history_search_state;
      DROP TABLE history_search_metadata;
    `);
      db.close();

      recreated = new HistoryWorkerClient({ workerData: { dbPath, lane: 'search' } });
      const unchanged = await recreated.reconcileSessionFilePaths([
        { providerSessionId, path: sessionPath },
      ]);
      assert.equal(unchanged.changed, 0);
      assert.equal(
        (await recreated.sessionFileSnapshot()).entries[0]?.providerSessionId,
        providerSessionId,
      );
      recreated.closeSync();
    } finally {
      first?.closeSync();
      recreated?.closeSync();
      if (previousHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = previousHome;
      rmSync(home, { recursive: true, force: true });
    }
  },
);

test('missing FTS5 degrades search without affecting canonical persistence', async () => {
  const home = mkdtempSync(join(tmpdir(), 'droidex-history-fts5-unavailable-'));
  const previousHome = process.env['HOME'];
  process.env['HOME'] = home;
  const databaseDirectory = join(home, '.factory', 'droidex');
  mkdirSync(databaseDirectory, { recursive: true });
  const dbPath = join(databaseDirectory, SESSION_INDEX_FILENAME);
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  const statuses: Array<string> = [];
  let persistence: HistoryPersistence | undefined;
  try {
    const searchClient = new HistoryWorkerClient({
      workerUrl: new URL(
        './testing/historyPersistenceWorkerFts5UnavailableLoader.mjs',
        import.meta.url,
      ),
      workerData: { dbPath, lane: 'search' },
    });
    persistence = new HistoryPersistence({
      searchClient,
      onStatusChanged: (status) => statuses.push(status.state),
    });

    persistence.recordEvent({
      id: 'durable-event',
      appSessionId: 'app',
      sourceSessionId: 'app',
      role: 'primary',
      ts: 1,
      kind: 'text',
      text: 'canonical history stays durable',
    });
    persistence.flushSync();

    const canonical = new DatabaseSync(dbPath, { readOnly: true });
    try {
      assert.equal(
        (canonical.prepare('SELECT COUNT(*) AS count FROM events').get() as { count: number })
          .count,
        1,
      );
    } finally {
      canonical.close();
    }

    await assert.rejects(persistence.searchSessions('needle'), (error: unknown) =>
      isHistorySearchUnavailableError(error),
    );
    await assert.rejects(
      persistence.searchSessions('needle'),
      (error: unknown) => error instanceof HistorySearchUnavailableError,
    );
    assert.equal(await persistence.reconcileSessionFiles(), 0);

    persistence.recordEvent({
      id: 'after-search',
      appSessionId: 'app',
      sourceSessionId: 'app',
      role: 'primary',
      ts: 2,
      kind: 'text',
      text: 'writes continue after search degrades',
    });
    persistence.flushSync();

    const afterSearch = new DatabaseSync(dbPath, { readOnly: true });
    try {
      assert.equal(
        (afterSearch.prepare('SELECT COUNT(*) AS count FROM events').get() as { count: number })
          .count,
        2,
      );
    } finally {
      afterSearch.close();
    }

    assert.deepEqual(statuses, ['search_unavailable']);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
    persistence?.close();
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test('a synchronous timeout does not leak an unhandled promise rejection', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'droidex-history-worker-timeout-'));
  const dbPath = join(dir, 'history.sqlite');
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => unhandled.push(error);
  const workers: Worker[] = [];
  process.on('unhandledRejection', onUnhandled);
  try {
    createSchema(dbPath);
    const client = new HistoryWorkerClient({
      syncTimeoutMs: 0,
      workerFactory: () => {
        const worker = new Worker(
          new URL('./historyPersistenceWorkerLoader.mjs', import.meta.url),
          { workerData: { dbPath, lane: 'persistence' }, execArgv: [] },
        );
        workers.push(worker);
        return worker;
      },
    });
    assert.throws(() => client.closeSync(), /did not respond within 0ms/);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
    await Promise.all(workers.map(async (worker) => await worker.terminate()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the worker client recreates a failed worker before the next persistence attempt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'droidex-history-worker-restart-'));
  const dbPath = join(dir, 'history.sqlite');
  const workers: Worker[] = [];
  try {
    createSchema(dbPath);
    const client = new HistoryWorkerClient({
      workerFactory: () => {
        const worker = new Worker(
          new URL('./historyPersistenceWorkerLoader.mjs', import.meta.url),
          { workerData: { dbPath, lane: 'persistence' }, execArgv: [] },
        );
        workers.push(worker);
        return worker;
      },
    });
    const firstBatch: HistoryPersistenceBatch = {
      events: [],
      summaries: [summary()],
      children: [],
      estimatedBytes: 512,
    };
    client.startPersist(firstBatch).waitSync();
    await workers[0]?.terminate();

    const secondBatch: HistoryPersistenceBatch = {
      events: [
        { id: 'after-restart', sourceSessionId: 'app', appSessionId: 'app', kind: 'text', ts: 2 },
      ],
      summaries: [],
      children: [],
      estimatedBytes: 256,
    };
    assert.equal(client.startPersist(secondBatch).waitSync().eventsWritten, 1);
    assert.equal(workers.length, 2);
    client.closeSync();

    const db = new DatabaseSync(dbPath, { readOnly: true });
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS count FROM events').get() as { count: number }).count,
      1,
    );
    db.close();
  } finally {
    await Promise.all(workers.map(async (worker) => await worker.terminate()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a synchronous transport timeout recreates the worker for the next persistence attempt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'droidex-history-worker-hung-'));
  const dbPath = join(dir, 'history.sqlite');
  const workers: Worker[] = [];
  try {
    createSchema(dbPath);
    const hungWorker = new Worker('setInterval(() => undefined, 1_000);', { eval: true });
    workers.push(hungWorker);
    const client = new HistoryWorkerClient({
      worker: hungWorker,
      workerFactory: () => {
        const worker = new Worker(
          new URL('./historyPersistenceWorkerLoader.mjs', import.meta.url),
          { workerData: { dbPath, lane: 'persistence' }, execArgv: [] },
        );
        workers.push(worker);
        return worker;
      },
    });
    const batch: HistoryPersistenceBatch = {
      events: [
        { id: 'after-timeout', sourceSessionId: 'app', appSessionId: 'app', kind: 'text', ts: 3 },
      ],
      summaries: [],
      children: [],
      estimatedBytes: 256,
    };
    const pending = client.startPersist({
      events: [
        {
          id: 'pending-before-timeout',
          sourceSessionId: 'app',
          appSessionId: 'app',
          kind: 'text',
          ts: 2,
        },
      ],
      summaries: [],
      children: [],
      estimatedBytes: 256,
    }).promise;

    assert.throws(() => client.startPersist(batch).waitSync(20), /did not respond within 20ms/);
    await assert.rejects(pending, /did not respond within 20ms/);
    assert.equal(client.startPersist(batch).waitSync().eventsWritten, 1);
    assert.equal(workers.length, 2);
    client.closeSync();
  } finally {
    await Promise.all(workers.map(async (worker) => await worker.terminate()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an asynchronous persistence timeout recreates the worker without a synchronous boundary', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'droidex-history-worker-async-hung-'));
  const dbPath = join(dir, 'history.sqlite');
  const workers: Worker[] = [];
  const watchdogs = createWatchdogScheduler();
  try {
    createSchema(dbPath);
    const hungWorker = new Worker('setInterval(() => undefined, 1_000);', { eval: true });
    workers.push(hungWorker);
    const client = new HistoryWorkerClient({
      worker: hungWorker,
      workerFactory: () => {
        const worker = new Worker(
          new URL('./historyPersistenceWorkerLoader.mjs', import.meta.url),
          { workerData: { dbPath, lane: 'persistence' }, execArgv: [] },
        );
        workers.push(worker);
        return worker;
      },
      scheduleWatchdog: watchdogs.schedule,
      cancelWatchdog: watchdogs.cancel,
    });
    const batch: HistoryPersistenceBatch = {
      events: [
        {
          id: 'after-async-timeout',
          sourceSessionId: 'app',
          appSessionId: 'app',
          kind: 'text',
          ts: 4,
        },
      ],
      summaries: [],
      children: [],
      estimatedBytes: 256,
    };

    const first = client.startPersist(batch).promise;
    void first.catch(() => undefined);
    watchdogs.fireNext();
    await assert.rejects(settleWithin(first, 2_000), /did not respond within 10000ms/);
    assert.equal((await settleWithin(client.startPersist(batch).promise, 2_000)).eventsWritten, 1);
    assert.equal(workers.length, 2);
    assert.equal(watchdogs.pendingCount(), 0);
    client.closeSync();
  } finally {
    await Promise.all(workers.map(async (worker) => await worker.terminate()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an asynchronous durability timeout recreates the worker without another boundary', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'droidex-history-barrier-async-hung-'));
  const dbPath = join(dir, 'history.sqlite');
  const workers: Worker[] = [];
  const watchdogs = createWatchdogScheduler();
  try {
    createSchema(dbPath);
    const hungWorker = new Worker('setInterval(() => undefined, 1_000);', { eval: true });
    workers.push(hungWorker);
    const client = new HistoryWorkerClient({
      worker: hungWorker,
      workerFactory: () => {
        const worker = new Worker(
          new URL('./historyPersistenceWorkerLoader.mjs', import.meta.url),
          { workerData: { dbPath, lane: 'persistence' }, execArgv: [] },
        );
        workers.push(worker);
        return worker;
      },
      scheduleWatchdog: watchdogs.schedule,
      cancelWatchdog: watchdogs.cancel,
    });

    const first = client.startDurabilityBarrier().promise;
    void first.catch(() => undefined);
    watchdogs.fireNext();
    await assert.rejects(settleWithin(first, 2_000), /did not respond within 10000ms/);
    assert.deepEqual(await settleWithin(client.startDurabilityBarrier().promise, 2_000), {
      durable: true,
    });
    assert.equal(workers.length, 2);
    assert.equal(watchdogs.pendingCount(), 0);
    client.closeSync();
  } finally {
    await Promise.all(workers.map(async (worker) => await worker.terminate()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a search transport timeout fails only that call', async () => {
  const watchdogs = createWatchdogScheduler();
  const worker = new Worker(
    `
      const { parentPort } = require('node:worker_threads');
      parentPort.on('message', ({ request, replyPort }) => {
        if (request.type === 'search') return;
        replyPort.postMessage({ ok: true, value: { accepted: true } });
        replyPort.close();
      });
    `,
    { eval: true },
  );
  try {
    const client = new HistoryWorkerClient({
      worker,
      scheduleWatchdog: watchdogs.schedule,
      cancelWatchdog: watchdogs.cancel,
    });

    const search = client.search('needle');
    void search.catch(() => undefined);
    watchdogs.fireNext();
    await assert.rejects(settleWithin(search, 2_000), /did not respond within 60000ms/);
    await assert.doesNotReject(() => settleWithin(client.setIndexingIdle(true), 2_000));
    assert.equal(watchdogs.pendingCount(), 0);
    client.closeSync();
  } finally {
    await worker.terminate();
  }
});

test('an asynchronous worker timeout lets the queue retry without a synchronous boundary', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'droidex-history-queue-async-hung-'));
  const dbPath = join(dir, 'history.sqlite');
  const workers: Worker[] = [];
  const scheduledCallbacks: Array<() => void> = [];
  const watchdogs = createWatchdogScheduler();
  let notifyFailure: (() => void) | undefined;
  let notifyCommit: (() => void) | undefined;
  const failed = new Promise<void>((resolve) => {
    notifyFailure = resolve;
  });
  const committed = new Promise<void>((resolve) => {
    notifyCommit = resolve;
  });
  try {
    createSchema(dbPath);
    const hungWorker = new Worker('setInterval(() => undefined, 1_000);', { eval: true });
    workers.push(hungWorker);
    const client = new HistoryWorkerClient({
      worker: hungWorker,
      workerFactory: () => {
        const worker = new Worker(
          new URL('./historyPersistenceWorkerLoader.mjs', import.meta.url),
          { workerData: { dbPath, lane: 'persistence' }, execArgv: [] },
        );
        workers.push(worker);
        return worker;
      },
      scheduleWatchdog: watchdogs.schedule,
      cancelWatchdog: watchdogs.cancel,
    });
    const queue = new HistoryPersistenceQueue({
      dbPath,
      client,
      schedule: (callback) => {
        scheduledCallbacks.push(callback);
        return dormantTimer();
      },
      onFailure: () => notifyFailure?.(),
      onCommitted: () => notifyCommit?.(),
    });

    queue.enqueueEvent({
      id: 'queued-after-timeout',
      appSessionId: 'app',
      sourceSessionId: 'app',
      role: 'primary',
      ts: 5,
      kind: 'text',
      text: 'queued asynchronously',
    });
    const initialFlush = scheduledCallbacks.shift();
    assert.ok(initialFlush);
    initialFlush();
    watchdogs.fireNext();
    await settleWithin(failed, 2_000);
    const retry = scheduledCallbacks.shift();
    assert.ok(retry);
    retry();
    await settleWithin(committed, 2_000);

    assert.equal(queue.snapshot().pendingEntries, 0);
    assert.equal(queue.snapshot().inFlightEntries, 0);
    assert.equal(queue.snapshot().retries, 1);
    assert.equal(workers.length, 2);
    assert.equal(watchdogs.pendingCount(), 0);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS count FROM events').get() as { count: number }).count,
      1,
    );
    db.close();
    client.closeSync();
  } finally {
    await Promise.all(workers.map(async (worker) => await worker.terminate()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a serialized persistence error does not restart the worker', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'droidex-history-worker-operation-error-'));
  const dbPath = join(dir, 'history.sqlite');
  const workers: Worker[] = [];
  try {
    createSchema(dbPath);
    const client = new HistoryWorkerClient({
      workerFactory: () => {
        const worker = new Worker(
          new URL('./historyPersistenceWorkerLoader.mjs', import.meta.url),
          { workerData: { dbPath, lane: 'persistence' }, execArgv: [] },
        );
        workers.push(worker);
        return worker;
      },
    });
    const invalidSummary = summary();
    Object.defineProperty(invalidSummary, 'title', { value: undefined });

    assert.throws(
      () =>
        client
          .startPersist({
            events: [],
            summaries: [invalidSummary],
            children: [],
            estimatedBytes: 256,
          })
          .waitSync(),
      /cannot be bound/,
    );
    assert.equal(
      client
        .startPersist({
          events: [
            {
              id: 'after-operation-error',
              sourceSessionId: 'app',
              appSessionId: 'app',
              kind: 'text',
              ts: 6,
            },
          ],
          summaries: [],
          children: [],
          estimatedBytes: 256,
        })
        .waitSync().eventsWritten,
      1,
    );
    assert.equal(workers.length, 1);
    client.closeSync();
  } finally {
    await Promise.all(workers.map(async (worker) => await worker.terminate()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a postMessage failure does not leak an unhandled rejection', async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => unhandled.push(error);
  const worker = new Worker('setInterval(() => undefined, 1_000);', { eval: true });
  Object.defineProperty(worker, 'postMessage', {
    value: () => {
      throw new Error('Worker postMessage failed.');
    },
  });
  process.on('unhandledRejection', onUnhandled);
  try {
    const client = new HistoryWorkerClient({ worker });
    const batch: HistoryPersistenceBatch = {
      events: [],
      summaries: [],
      children: [],
      estimatedBytes: 0,
    };

    assert.throws(() => client.startPersist(batch), /Worker postMessage failed/);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
    client.closeSync();
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
    await worker.terminate();
  }
});

function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Test timed out after ${String(timeoutMs)}ms.`)),
      timeoutMs,
    );
  });
  return Promise.race([promise, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function dormantTimer(): ReturnType<typeof setTimeout> {
  const timer = setTimeout(() => undefined, 60_000);
  timer.unref();
  return timer;
}

function createWatchdogScheduler(): {
  schedule: (callback: () => void, timeoutMs: number) => ReturnType<typeof setTimeout>;
  cancel: (timer: ReturnType<typeof setTimeout>) => void;
  fireNext(): void;
  pendingCount(): number;
} {
  const callbacks = new Map<ReturnType<typeof setTimeout>, () => void>();
  return {
    schedule: (callback) => {
      const timer = dormantTimer();
      callbacks.set(timer, callback);
      return timer;
    },
    cancel: (timer) => {
      clearTimeout(timer);
      callbacks.delete(timer);
    },
    fireNext: () => {
      for (const callback of callbacks.values()) {
        callback();
        return;
      }
      throw new Error('Expected a transport watchdog.');
    },
    pendingCount: () => callbacks.size,
  };
}
