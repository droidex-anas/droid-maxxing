import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { HistoryIndex as HistoryIndexType } from './history.js';
import type * as Protocol from './protocol.js';
import {
  SessionFileCache,
  type SessionFileStat,
  type SessionFileSummary,
} from './sessionFileCache.js';
import { HistoryPersistenceDatabase } from './historyPersistenceDatabase.js';
import { SessionManager } from './SessionManager.js';
import {
  providerSessionJsonl,
  type ProviderMessageRole,
} from './testing/providerSessionFixtures.js';
import { persistTestSummaries } from './testing/historyPersistenceFixture.js';
import { droidSessionConfiguration } from './providers/providerIdentity.js';

const originalHome = process.env.HOME;
const home = mkdtempSync(join(tmpdir(), 'droid-history-cache-home-'));
process.env.HOME = home;

const {
  HistoryIndex,
  createHistorySessionFileCache,
  loadHistoricalSessions,
  SESSION_INDEX_FILENAME,
  SESSION_SEARCH_INDEX_FILENAME,
} = await import('./history.js');

type SessionListEvent = Extract<Protocol.ServerEvent, { type: 'sessions.list' }>;

function isSessionList(event: Protocol.ServerEvent): event is SessionListEvent {
  return event.type === 'sessions.list';
}

test.after(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
});

function writeSession(
  root: string,
  id: string,
  cwd: string,
  extra: Record<string, unknown> = {},
  messageRoles: ProviderMessageRole[] = ['user', 'assistant'],
): string {
  const dir = join(root, '.factory', 'sessions');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.jsonl`);
  writeFileSync(
    path,
    providerSessionJsonl(
      {
        type: 'session_start',
        cwd,
        sessionTitle: `Chat ${id}`,
        settings: { interactionMode: 'auto' },
        ...extra,
      },
      messageRoles,
    ),
  );
  return path;
}

function writeEmptySession(root: string, id: string, cwd: string): string {
  return writeSession(root, id, cwd, { sessionTitle: 'New Session' }, []);
}

test('compaction summary lookup uses a partial event index instead of scanning all events', () => {
  const history = new HistoryIndex();
  history.close();
  new HistoryPersistenceDatabase(join(home, '.factory', 'droidex', SESSION_INDEX_FILENAME)).close();
  const db = new DatabaseSync(join(home, '.factory', 'droidex', SESSION_INDEX_FILENAME), {
    readOnly: true,
  });
  try {
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT app_session_id,
                SUM(CASE WHEN id LIKE 'compaction-%' THEN 1 ELSE 0 END) AS live_count,
                SUM(CASE WHEN id NOT LIKE 'compaction-%' THEN 1 ELSE 0 END) AS history_count
         FROM events
         WHERE kind = 'compaction'
           AND app_session_id IS NOT NULL
           AND (source_session_id = app_session_id OR source_session_id = 'primary')
         GROUP BY app_session_id`,
      )
      .all() as Array<{ detail: string }>;
    assert.ok(
      plan.some(
        (row) =>
          row.detail.includes('SEARCH events') && row.detail.includes('events_compaction_summary'),
      ),
    );
    assert.ok(!plan.some((row) => row.detail.includes('SCAN events')));
  } finally {
    db.close();
  }
});

function patchFor(appSessionId: string, cwd: string): Protocol.SessionSummary {
  const now = Date.now();
  return {
    appSessionId,
    providerSessionId: appSessionId,
    sessionPurpose: 'chat',
    role: 'primary',
    title: `Chat ${appSessionId}`,
    goal: `Chat ${appSessionId}`,
    cwd,
    workspaceKind: cwd ? 'folder' : 'none',
    configuration: droidSessionConfiguration({
      modelId: 'model-default',
      interactionMode: 'auto',
      autonomy: 'low',
    }),
    phase: 'paused',
    streaming: false,
    queuedSends: 0,
    features: [],
    tokensIn: 0,
    tokensOut: 0,
    contextTokens: 0,
    createdAt: now,
    updatedAt: now,
  };
}

function summaryFor(appSessionId: string, cwd: string): SessionFileSummary {
  return { summary: patchFor(appSessionId, cwd) };
}

function reconcileHistoryIndex(index: HistoryIndexType): number {
  return reconcileHistoryIndexChanges(index).changed;
}

function reconcileHistoryIndexPaths(
  index: HistoryIndexType,
  changes: Array<{ providerSessionId: string; path: string }>,
): number {
  const db = new DatabaseSync(
    join(process.env.HOME ?? '', '.factory', 'droidex', SESSION_SEARCH_INDEX_FILENAME),
  );
  try {
    const cache = createHistorySessionFileCache(db);
    const result = cache.reconcilePathChanges(changes);
    if (!index.applySessionFileReconciliation(result)) {
      index.replaceSessionFileSnapshot(cache.snapshot(result.changed));
    }
    return result.changed;
  } finally {
    db.close();
  }
}

function reconcileHistoryIndexChanges(index: HistoryIndexType) {
  const db = new DatabaseSync(
    join(process.env.HOME ?? '', '.factory', 'droidex', SESSION_SEARCH_INDEX_FILENAME),
  );
  try {
    const cache = createHistorySessionFileCache(db);
    const result = cache.reconcileChanges();
    if (!index.applySessionFileReconciliation(result)) {
      index.replaceSessionFileSnapshot(cache.snapshot(result.changed));
    }
    return result;
  } finally {
    db.close();
  }
}

test('reconcile populates the cache and the cached list matches the uncached scan', () => {
  writeSession(home, 'cache-plain', '');
  const workspace = join(home, 'workspace-a');
  writeSession(home, 'cache-workspace', workspace);
  writeSession(home, 'cache-child', workspace, {
    callingSessionId: 'cache-workspace',
    callingToolUseId: 'tool-1',
  });

  const index = new HistoryIndex();
  try {
    assert.equal(reconcileHistoryIndex(index), 3);
    // The Task child is cached as a known non-top-level file, not re-read later.
    assert.equal(index.sessionFileCacheSize, 3);

    const cached = index.listHistoricalSessions();
    const uncached = loadHistoricalSessions();
    for (const id of ['cache-plain', 'cache-workspace']) {
      const cachedRow = cached.find((row) => row.summary.appSessionId === id);
      const uncachedRow = uncached.find((row) => row.summary.appSessionId === id);
      assert.ok(cachedRow, `cached list contains ${id}`);
      assert.ok(uncachedRow, `uncached scan contains ${id}`);
      assert.equal(cachedRow.summary.title, uncachedRow.summary.title);
      assert.equal(cachedRow.summary.cwd, uncachedRow.summary.cwd);
      assert.equal(cachedRow.summary.createdAt, uncachedRow.summary.createdAt);
      assert.equal(cachedRow.summary.updatedAt, uncachedRow.summary.updatedAt);
    }
    assert.equal(
      cached.some((row) => row.summary.appSessionId === 'cache-child'),
      false,
    );
  } finally {
    index.close();
  }
});

test('reconciliation deltas update a second in-memory cache without scanning files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'droid-history-cache-delta-'));
  const path = join(dir, 'history.sqlite');
  const writerDb = new DatabaseSync(path);
  const readerDb = new DatabaseSync(path);
  try {
    const stat = (providerSessionId: string, mtimeMs: number): SessionFileStat => ({
      path: `/sessions/${providerSessionId}.jsonl`,
      birthtimeMs: 1,
      mtimeMs,
      sizeBytes: 10 + mtimeMs,
      settingsMtimeMs: null,
    });
    const onDisk = new Map<string, SessionFileStat>([
      ['alpha', stat('alpha', 1)],
      ['beta', stat('beta', 1)],
    ]);
    const writer = new SessionFileCache(
      writerDb,
      () => ({ files: onDisk, isComplete: true }),
      (providerSessionId, file) => summaryFor(providerSessionId, file.path),
      () => null,
    );
    const reader = new SessionFileCache(
      readerDb,
      () => {
        throw new Error('reader cache must not scan provider files');
      },
      () => {
        throw new Error('reader cache must not summarize provider files');
      },
      () => null,
    );

    const initial = writer.reconcileChanges();
    assert.equal(initial.changed, 2);
    assert.deepEqual(
      initial.upserts.map((entry) => entry.providerSessionId),
      ['alpha', 'beta'],
    );
    assert.deepEqual(initial.removedProviderSessionIds, []);
    reader.applyReconciliation(initial);
    assert.deepEqual(
      reader.summaries().map((summary) => summary.appSessionId),
      ['alpha', 'beta'],
    );

    onDisk.set('alpha', stat('alpha', 2));
    onDisk.delete('beta');
    const update = writer.reconcileChanges();
    assert.equal(update.changed, 2);
    assert.deepEqual(
      update.upserts.map((entry) => [entry.providerSessionId, entry.mtimeMs]),
      [['alpha', 2]],
    );
    assert.deepEqual(update.removedProviderSessionIds, ['beta']);
    reader.applyReconciliation(update);
    assert.deepEqual(
      reader.searchableEntries().map((entry) => [entry.providerSessionId, entry.mtimeMs]),
      [['alpha', 2]],
    );

    onDisk.set('alpha', { ...stat('alpha', 2), birthtimeMs: 2 });
    const replacement = writer.reconcileChanges();
    assert.equal(
      replacement.changed,
      1,
      'a replacement with the same path, mtime, and size is re-summarized',
    );
    assert.equal(replacement.upserts[0]?.birthtimeMs, 2);
  } finally {
    readerDb.close();
    writerDb.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('metadata-only session files never become historical sidebar rows', () => {
  const freshHome = mkdtempSync(join(tmpdir(), 'droid-history-empty-session-'));
  const previousHome = process.env.HOME;
  process.env.HOME = freshHome;
  try {
    const workspace = join(freshHome, 'workspace-empty');
    writeEmptySession(freshHome, 'empty-session', workspace);
    const index = new HistoryIndex();
    try {
      assert.equal(reconcileHistoryIndex(index), 1);
      assert.equal(
        index
          .listHistoricalSessions({ workspaceCwds: [workspace] })
          .some((row) => row.summary.appSessionId === 'empty-session'),
        false,
      );
    } finally {
      index.close();
    }
  } finally {
    process.env.HOME = previousHome;
    rmSync(freshHome, { recursive: true, force: true });
  }
});

test('sessions without a model response never become historical sidebar rows', () => {
  const freshHome = mkdtempSync(join(tmpdir(), 'droid-history-no-response-'));
  const previousHome = process.env.HOME;
  process.env.HOME = freshHome;
  try {
    const workspace = join(freshHome, 'workspace-no-response');
    writeSession(freshHome, 'no-response-session', workspace, {}, ['user']);
    const index = new HistoryIndex();
    try {
      assert.equal(reconcileHistoryIndex(index), 1);
      assert.equal(
        index
          .listHistoricalSessions({ workspaceCwds: [workspace] })
          .some((row) => row.summary.appSessionId === 'no-response-session'),
        false,
      );
    } finally {
      index.close();
    }
  } finally {
    process.env.HOME = previousHome;
    rmSync(freshHome, { recursive: true, force: true });
  }
});

test('internal llm_only context cannot admit a session without a real user turn', () => {
  const freshHome = mkdtempSync(join(tmpdir(), 'droid-history-llm-only-'));
  const previousHome = process.env.HOME;
  process.env.HOME = freshHome;
  try {
    const workspace = join(freshHome, 'workspace-llm-only');
    const path = writeEmptySession(freshHome, 'llm-only-session', workspace);
    writeFileSync(
      path,
      `${[
        {
          type: 'session_start',
          cwd: workspace,
          sessionTitle: 'New Session',
          settings: { interactionMode: 'auto' },
        },
        {
          type: 'message',
          message: {
            role: 'user',
            visibility: 'llm_only',
            content: [{ type: 'text', text: 'internal context' }],
          },
        },
        {
          type: 'message',
          message: { role: 'assistant', content: [{ type: 'text', text: 'response' }] },
        },
      ]
        .map((line) => JSON.stringify(line))
        .join('\n')}\n`,
    );

    const index = new HistoryIndex();
    try {
      assert.equal(reconcileHistoryIndex(index), 1);
      assert.equal(index.listHistoricalSessions({ workspaceCwds: [workspace] }).length, 0);
    } finally {
      index.close();
    }
  } finally {
    process.env.HOME = previousHome;
    rmSync(freshHome, { recursive: true, force: true });
  }
});

test('opening the canonical index does not open or mutate the worker-owned derived cache', () => {
  const upgradeHome = mkdtempSync(join(tmpdir(), 'droid-history-cache-upgrade-'));
  const previousHome = process.env.HOME;
  process.env.HOME = upgradeHome;
  try {
    const existing = new HistoryIndex();
    persistTestSummaries([patchFor('existing-session', '/workspace/existing')]);
    existing.close();

    const databasePath = join(upgradeHome, '.factory', 'droidex', SESSION_INDEX_FILENAME);
    const searchDatabasePath = join(
      upgradeHome,
      '.factory',
      'droidex',
      SESSION_SEARCH_INDEX_FILENAME,
    );
    const upgraded = new HistoryIndex();
    upgraded.close();

    const verified = new DatabaseSync(databasePath);
    const session = verified
      .prepare('SELECT app_session_id, cwd FROM app_sessions WHERE app_session_id = ?')
      .get('existing-session') as { app_session_id: string; cwd: string } | undefined;
    verified.close();
    assert.equal(session?.app_session_id, 'existing-session');
    assert.equal(session?.cwd, '/workspace/existing');
    assert.equal(existsSync(searchDatabasePath), false);
  } finally {
    process.env.HOME = previousHome;
    rmSync(upgradeHome, { recursive: true, force: true });
  }
});

test('a second boot with unchanged files reconciles nothing', () => {
  const index = new HistoryIndex();
  try {
    assert.equal(index.sessionFileCacheSize, 0, 'the main-thread mirror starts without disk IO');
    assert.equal(reconcileHistoryIndex(index), 0);
    assert.equal(index.sessionFileCacheSize, 3, 'the worker snapshot hydrates the mirror');
  } finally {
    index.close();
  }
});

test('rewriting a session file refreshes its cached summary', () => {
  const workspace = join(home, 'workspace-a');
  const path = writeSession(home, 'cache-workspace', workspace, {
    sessionTitle: 'Renamed chat',
  });
  // Force a distinct mtime so the change does not depend on clock granularity.
  const later = new Date(Date.now() + 10_000);
  utimesSync(path, later, later);

  const index = new HistoryIndex();
  try {
    assert.equal(reconcileHistoryIndex(index), 1);
    const rows = index.listHistoricalSessions();
    const row = rows.find((item) => item.summary.appSessionId === 'cache-workspace');
    assert.equal(row?.summary.title, 'Renamed chat');
  } finally {
    index.close();
  }
});

test('deleting a session file removes it from the cached list', () => {
  unlinkSync(join(home, '.factory', 'sessions', 'cache-plain.jsonl'));

  const index = new HistoryIndex();
  try {
    assert.equal(reconcileHistoryIndex(index), 1);
    assert.equal(index.sessionFileCacheSize, 2);
    const rows = index.listHistoricalSessions();
    assert.equal(
      rows.some((row) => row.summary.appSessionId === 'cache-plain'),
      false,
    );
  } finally {
    index.close();
  }
});

test('cached list applies app summary patches before filtering', () => {
  const workspace = join(home, 'workspace-patch');
  writeSession(home, 'cache-patched', workspace);

  const index = new HistoryIndex();
  try {
    reconcileHistoryIndex(index);
    persistTestSummaries([patchFor('cache-patched', '')]);

    const plain = index.listHistoricalSessions({ includePlainChats: true });
    const plainRow = plain.find((row) => row.summary.appSessionId === 'cache-patched');
    assert.ok(plainRow);
    assert.equal(plainRow.summary.cwd, '');
    assert.equal(plainRow.summary.workspaceKind, 'none');

    const scoped = index.listHistoricalSessions({ workspaceCwds: [workspace] });
    assert.equal(
      scoped.some((row) => row.summary.appSessionId === 'cache-patched'),
      false,
    );
  } finally {
    index.close();
  }
});

test('a corrupt cache row is dropped and rebuilt on the next boot', () => {
  const freshHome = mkdtempSync(join(tmpdir(), 'droid-history-cache-corrupt-'));
  const previousHome = process.env.HOME;
  process.env.HOME = freshHome;
  try {
    writeSession(freshHome, 'corrupt-row', join(freshHome, 'workspace'));
    const dbPath = join(freshHome, '.factory', 'droidex', SESSION_SEARCH_INDEX_FILENAME);

    const first = new HistoryIndex();
    try {
      assert.equal(reconcileHistoryIndex(first), 1);
      assert.equal(first.sessionFileCacheSize, 1);
    } finally {
      first.close();
    }

    const db = new DatabaseSync(dbPath);
    try {
      db.prepare(
        'UPDATE session_file_cache SET summary_json = ? WHERE provider_session_id = ?',
      ).run('{not json', 'corrupt-row');
    } finally {
      db.close();
    }

    const second = new HistoryIndex();
    try {
      // The main-thread mirror never opens the derived database.
      assert.equal(second.sessionFileCacheSize, 0);
      assert.equal(reconcileHistoryIndex(second), 1);
      const revisionDb = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const metadata = revisionDb
          .prepare('SELECT revision FROM session_file_cache_metadata WHERE id = 1')
          .get() as { revision: number };
        assert.equal(
          metadata.revision,
          3,
          'the worker drops the corrupt row and commits its rebuilt replacement',
        );
      } finally {
        revisionDb.close();
      }
      const rows = second.listHistoricalSessions();
      assert.ok(rows.some((row) => row.summary.appSessionId === 'corrupt-row'));
    } finally {
      second.close();
    }

    const nullSummary = new DatabaseSync(dbPath);
    try {
      nullSummary
        .prepare('UPDATE session_file_cache SET summary_json = ? WHERE provider_session_id = ?')
        .run(JSON.stringify({ cacheVersion: 1, summary: null }), 'corrupt-row');
    } finally {
      nullSummary.close();
    }

    const rebuilt = new HistoryIndex();
    try {
      assert.equal(rebuilt.sessionFileCacheSize, 0, 'a null summary is rejected intentionally');
      assert.equal(reconcileHistoryIndex(rebuilt), 1);
    } finally {
      rebuilt.close();
    }
  } finally {
    process.env.HOME = previousHome;
    rmSync(freshHome, { recursive: true, force: true });
  }
});

test('pre-classification cache rows are discarded so empty sessions are re-evaluated', () => {
  const freshHome = mkdtempSync(join(tmpdir(), 'droid-history-cache-version-'));
  const previousHome = process.env.HOME;
  process.env.HOME = freshHome;
  try {
    writeEmptySession(freshHome, 'previously-cached-empty', join(freshHome, 'workspace'));
    const dbPath = join(freshHome, '.factory', 'droidex', SESSION_SEARCH_INDEX_FILENAME);
    const first = new HistoryIndex();
    try {
      assert.equal(reconcileHistoryIndex(first), 1);
    } finally {
      first.close();
    }

    const db = new DatabaseSync(dbPath);
    try {
      db.prepare(
        'UPDATE session_file_cache SET summary_json = ? WHERE provider_session_id = ?',
      ).run(
        JSON.stringify(patchFor('previously-cached-empty', join(freshHome, 'workspace'))),
        'previously-cached-empty',
      );
    } finally {
      db.close();
    }

    const second = new HistoryIndex();
    try {
      assert.equal(second.sessionFileCacheSize, 0, 'the superseded cache shape is rejected');
      assert.equal(reconcileHistoryIndex(second), 1);
      assert.equal(second.listHistoricalSessions().length, 0);
    } finally {
      second.close();
    }
  } finally {
    process.env.HOME = previousHome;
    rmSync(freshHome, { recursive: true, force: true });
  }
});

test('a settings sidecar change refreshes the cached summary', () => {
  const workspace = join(home, 'workspace-settings');
  writeSession(home, 'cache-settings', workspace);

  const first = new HistoryIndex();
  try {
    reconcileHistoryIndex(first);
    const before = first
      .listHistoricalSessions()
      .find((row) => row.summary.appSessionId === 'cache-settings');
    assert.equal(before?.summary.configuration.providerSelection.modelId, 'default');
  } finally {
    first.close();
  }

  // The session file is untouched; only its settings sidecar appears.
  writeFileSync(
    join(home, '.factory', 'sessions', 'cache-settings.settings.json'),
    JSON.stringify({ modelId: 'cached-settings-model' }),
  );

  const second = new HistoryIndex();
  try {
    assert.equal(
      reconcileHistoryIndex(second),
      1,
      'settings mtime drift re-summarizes the session',
    );
    const after = second
      .listHistoricalSessions()
      .find((row) => row.summary.appSessionId === 'cache-settings');
    assert.equal(after?.summary.configuration.providerSelection.modelId, 'cached-settings-model');
  } finally {
    second.close();
  }
});

test('reconcileSessionFilePaths touches exactly the reported files', () => {
  const workspace = join(home, 'workspace-targeted');
  const keepPath = writeSession(home, 'cache-target-keep', workspace);
  const changePath = writeSession(home, 'cache-target-change', workspace);

  const first = new HistoryIndex();
  try {
    reconcileHistoryIndex(first);
  } finally {
    first.close();
  }

  writeSession(home, 'cache-target-change', workspace, { sessionTitle: 'Targeted rename' });
  // Force a distinct mtime so the change does not depend on clock granularity.
  const later = new Date(Date.now() + 30_000);
  utimesSync(changePath, later, later);

  const second = new HistoryIndex();
  try {
    // An unchanged reported file costs only a stat.
    assert.equal(
      reconcileHistoryIndexPaths(second, [
        { providerSessionId: 'cache-target-keep', path: keepPath },
      ]),
      0,
    );
    assert.equal(
      reconcileHistoryIndexPaths(second, [
        { providerSessionId: 'cache-target-change', path: changePath },
      ]),
      1,
    );
    const renamed = second
      .listHistoricalSessions()
      .find((row) => row.summary.appSessionId === 'cache-target-change');
    assert.equal(renamed?.summary.title, 'Targeted rename');

    // A reported file that no longer exists is dropped from the cache.
    unlinkSync(changePath);
    assert.equal(
      reconcileHistoryIndexPaths(second, [
        { providerSessionId: 'cache-target-change', path: changePath },
      ]),
      1,
    );
    assert.equal(
      second
        .listHistoricalSessions()
        .some((row) => row.summary.appSessionId === 'cache-target-change'),
      false,
    );

    // A settings-sidecar-only change (the session file itself untouched)
    // still re-summarizes the reported file.
    writeFileSync(
      join(home, '.factory', 'sessions', 'cache-target-keep.settings.json'),
      JSON.stringify({ modelId: 'targeted-settings-model' }),
    );
    assert.equal(
      reconcileHistoryIndexPaths(second, [
        { providerSessionId: 'cache-target-keep', path: keepPath },
      ]),
      1,
    );
    const reconfigured = second
      .listHistoricalSessions()
      .find((row) => row.summary.appSessionId === 'cache-target-keep');
    assert.equal(
      reconfigured?.summary.configuration.providerSelection.modelId,
      'targeted-settings-model',
    );
  } finally {
    second.close();
  }
});

test('a file that breaks mid-reconcile is skipped without aborting the diff', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const stat = (path: string): SessionFileStat => ({
      path,
      birthtimeMs: 1,
      mtimeMs: 1,
      sizeBytes: 10,
      settingsMtimeMs: null,
    });
    const onDisk = new Map<string, SessionFileStat>([
      ['good-session', stat('/sessions/good.jsonl')],
      ['bad-session', stat('/sessions/bad.jsonl')],
    ]);
    const cache = new SessionFileCache(
      db,
      () => ({ files: onDisk, isComplete: true }),
      (providerSessionId, file) => {
        // The bad file vanished between the scan and the read.
        if (providerSessionId === 'bad-session') throw new Error('ENOENT');
        return summaryFor(providerSessionId, file.path);
      },
      () => null,
    );
    assert.equal(
      cache.reconcileChanges().changed,
      1,
      'the good file is cached despite the broken one',
    );
    assert.deepEqual(
      cache.summaries().map((summary) => summary.appSessionId),
      ['good-session'],
    );
  } finally {
    db.close();
  }
});

test('an incomplete tree scan does not delete rows from unreadable subtrees', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const stat = (path: string): SessionFileStat => ({
      path,
      birthtimeMs: 1,
      mtimeMs: 1,
      sizeBytes: 10,
      settingsMtimeMs: null,
    });
    const onDisk = new Map<string, SessionFileStat>([
      ['visible-session', stat('/sessions/visible.jsonl')],
      ['temporarily-hidden-session', stat('/sessions/hidden/session.jsonl')],
    ]);
    let isComplete = true;
    const cache = new SessionFileCache(
      db,
      () => ({ files: onDisk, isComplete }),
      (providerSessionId, file) => summaryFor(providerSessionId, file.path),
      () => null,
    );
    assert.equal(cache.reconcileChanges().changed, 2);

    onDisk.delete('temporarily-hidden-session');
    isComplete = false;
    assert.equal(
      cache.reconcileChanges().changed,
      0,
      'a partial scan only applies files it could observe',
    );
    assert.deepEqual(
      new Set(cache.summaries().map((summary) => summary.appSessionId)),
      new Set(['visible-session', 'temporarily-hidden-session']),
      'an unreadable subtree does not look like an authoritative deletion',
    );

    isComplete = true;
    assert.equal(
      cache.reconcileChanges().changed,
      1,
      'a later complete scan removes the absent file',
    );
    assert.deepEqual(
      cache.summaries().map((summary) => summary.appSessionId),
      ['visible-session'],
    );
  } finally {
    db.close();
  }
});

test('a SQLite write failure leaves the in-memory cache unchanged', () => {
  // A failure-injecting database double: every prepared statement is created
  // normally, but the upsert's run() throws, simulating a busy/closed handle
  // mid-reconcile. The cache must mirror the database, so the row the write
  // never stored must not appear in the in-memory cache or its summaries.
  const throwingStatement = {
    all: () => [] as unknown[],
    run: () => {
      throw new Error('sqlite busy');
    },
  };
  const db = {
    exec: () => {},
    prepare: (sql: string) =>
      sql.includes('PRAGMA')
        ? {
            all: () => [
              { name: 'provider_session_id' },
              { name: 'path' },
              { name: 'birthtime_ms' },
              { name: 'mtime_ms' },
              { name: 'size_bytes' },
              { name: 'settings_mtime_ms' },
              { name: 'summary_json' },
            ],
            run: () => {},
          }
        : sql.includes('SELECT revision')
          ? { get: () => ({ revision: 0 }) }
          : throwingStatement,
  } as unknown as DatabaseSync;
  const stat = (path: string): SessionFileStat => ({
    path,
    birthtimeMs: 1,
    mtimeMs: 1,
    sizeBytes: 10,
    settingsMtimeMs: null,
  });
  const onDisk = new Map<string, SessionFileStat>([['fail-write', stat('/sessions/fail.jsonl')]]);
  const cache = new SessionFileCache(
    db,
    () => ({ files: onDisk, isComplete: true }),
    (providerSessionId) => summaryFor(providerSessionId, '/sessions/fail.jsonl'),
    () => null,
  );
  assert.throws(() => cache.reconcileChanges(), /sqlite busy/);
  assert.equal(cache.size, 0, 'the in-memory cache holds nothing the database never stored');
  assert.deepEqual(cache.summaries(), [], 'summaries stay empty');
});

test('a SQLite delete failure leaves the in-memory cache unchanged', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const path = '/sessions/fail-delete.jsonl';
    const file: SessionFileStat = {
      path,
      birthtimeMs: 1,
      mtimeMs: 1,
      sizeBytes: 10,
      settingsMtimeMs: null,
    };
    const onDisk = new Map<string, SessionFileStat>([['fail-delete', file]]);
    const cache = new SessionFileCache(
      db,
      () => ({ files: onDisk, isComplete: true }),
      (providerSessionId) => summaryFor(providerSessionId, path),
      (candidate) => (candidate === path ? (onDisk.get('fail-delete') ?? null) : null),
    );
    assert.equal(cache.reconcileChanges().changed, 1);
    onDisk.clear();
    db.exec(`
      CREATE TRIGGER fail_session_file_delete
      BEFORE DELETE ON session_file_cache
      BEGIN
        SELECT RAISE(ABORT, 'sqlite busy');
      END
    `);

    assert.throws(() => cache.reconcileChanges(), /sqlite busy/);
    assert.equal(cache.size, 1, 'a failed full-reconcile delete keeps the cached row');
    assert.throws(
      () => cache.reconcilePathChanges([{ providerSessionId: 'fail-delete', path }]),
      /sqlite busy/,
    );
    assert.equal(cache.size, 1, 'a failed targeted delete keeps the cached row');
    assert.equal(cache.summaries()[0]?.appSessionId, 'fail-delete');
  } finally {
    db.close();
  }
});

test('first sessions.list waits for worker reconciliation and serves discovered rows', async () => {
  const freshHome = mkdtempSync(join(tmpdir(), 'droid-history-cache-boot-'));
  const previousHome = process.env.HOME;
  process.env.HOME = freshHome;
  try {
    writeSession(freshHome, 'boot-session', join(freshHome, 'workspace'));
    const events: Protocol.ServerEvent[] = [];
    const manager = new SessionManager((event) => events.push(event));
    try {
      await manager.handle({ type: 'sessions.list' });
      const list = events.filter(isSessionList).at(-1);
      assert.ok(list);
      assert.ok(list.sessions.some((session) => session.appSessionId === 'boot-session'));
    } finally {
      await manager.shutdown();
    }
  } finally {
    process.env.HOME = previousHome;
    rmSync(freshHome, { recursive: true, force: true });
  }
});

test('a warm cache publishes an authoritative first list before the command resolves', async () => {
  const freshHome = mkdtempSync(join(tmpdir(), 'droid-history-cache-warm-'));
  const previousHome = process.env.HOME;
  process.env.HOME = freshHome;
  try {
    const path = writeSession(freshHome, 'warm-session', join(freshHome, 'workspace'));
    const firstBootEvents: Protocol.ServerEvent[] = [];
    const firstBoot = new SessionManager((event) => firstBootEvents.push(event));
    try {
      await firstBoot.handle({ type: 'sessions.list' });
    } finally {
      await firstBoot.shutdown();
    }

    // The file changes while the app is closed.
    writeSession(freshHome, 'warm-session', join(freshHome, 'workspace'), {
      sessionTitle: 'Edited elsewhere',
    });
    const later = new Date(Date.now() + 10_000);
    utimesSync(path, later, later);

    const events: Protocol.ServerEvent[] = [];
    const manager = new SessionManager((event) => events.push(event));
    try {
      await manager.handle({ type: 'sessions.list' });
      const lists = events.filter(isSessionList);
      assert.equal(lists.length, 1);
      assert.equal(
        lists[0]?.sessions.find((session) => session.appSessionId === 'warm-session')?.title,
        'Edited elsewhere',
      );
    } finally {
      await manager.shutdown();
    }
  } finally {
    process.env.HOME = previousHome;
    rmSync(freshHome, { recursive: true, force: true });
  }
});
