import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { HistoryIndexDatabase } from './historyIndexDatabase.js';
import { LiveRuntimeJournal, liveRuntimeJournalPath } from './liveRuntimeJournal.js';
import { initializeSessionFileCacheSchema } from './sessionFileCacheSchema.js';
import { persistTestSummaries } from './testing/historyPersistenceFixture.js';
import { providerSessionJsonl } from './testing/providerSessionFixtures.js';
import { droidSessionConfiguration } from './providers/providerIdentity.js';

const { HistoryIndex, SESSION_INDEX_FILENAME, SESSION_SEARCH_INDEX_FILENAME } =
  await import('./history.js');

const ORIGIN_MAIN_SESSION_FILE_CACHE = `
  CREATE TABLE session_file_cache (
    provider_session_id TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    birthtime_ms REAL NOT NULL,
    mtime_ms REAL NOT NULL,
    size_bytes INTEGER NOT NULL,
    settings_mtime_ms REAL,
    summary_json TEXT
  )
`;

function withIsolatedHome(fn: (home: string) => void | Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'droidex-upgrade-from-main-'));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  return Promise.resolve()
    .then(() => fn(home))
    .finally(() => {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(home, { recursive: true, force: true });
    });
}

function writeSessionFile(home: string, id: string, cwd: string): string {
  const dir = join(home, '.factory', 'sessions');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.jsonl`);
  writeFileSync(
    path,
    providerSessionJsonl({
      type: 'session_start',
      cwd,
      sessionTitle: `Chat ${id}`,
      settings: { interactionMode: 'auto' },
    }),
  );
  return path;
}

function summary(appSessionId: string, cwd: string) {
  const now = Date.now();
  return {
    appSessionId,
    providerSessionId: appSessionId,
    sessionPurpose: 'chat' as const,
    role: 'primary' as const,
    title: `Chat ${appSessionId}`,
    goal: `Chat ${appSessionId}`,
    cwd,
    workspaceKind: 'folder' as const,
    configuration: droidSessionConfiguration({
      modelId: 'model-default',
      interactionMode: 'auto' as const,
      autonomy: 'low' as const,
    }),
    phase: 'paused' as const,
    streaming: false,
    features: [],
    tokensIn: 0,
    tokensOut: 0,
    contextTokens: 0,
    createdAt: now,
    updatedAt: now,
  };
}

function tableNames(path: string): string[] {
  const db = new DatabaseSync(path);
  try {
    return (
      db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all() as { name: string }[]
    ).map((row) => row.name);
  } finally {
    db.close();
  }
}

function columnNames(path: string, table: string): string[] {
  const db = new DatabaseSync(path);
  try {
    return db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => String((row as { name: unknown }).name));
  } finally {
    db.close();
  }
}

test('an origin/main canonical index with a leftover file cache still opens', async () => {
  await withIsolatedHome((home) => {
    const workspace = join(home, 'workspace');
    writeSessionFile(home, 'kept-chat', workspace);
    const created = new HistoryIndex();
    persistTestSummaries([summary('kept-chat', workspace)]);
    created.close();

    const canonicalPath = join(home, '.factory', 'droidex', SESSION_INDEX_FILENAME);
    const canonical = new DatabaseSync(canonicalPath);
    canonical.exec(ORIGIN_MAIN_SESSION_FILE_CACHE);
    canonical
      .prepare(
        `INSERT INTO session_file_cache (
          provider_session_id, path, birthtime_ms, mtime_ms, size_bytes, settings_mtime_ms, summary_json
        ) VALUES (?, ?, 1, 1, 1, NULL, NULL)`,
      )
      .run('stale-cache-row', join(home, '.factory', 'sessions', 'missing.jsonl'));
    canonical.close();

    const upgraded = new HistoryIndex();
    try {
      const rows = upgraded.listHistoricalSessions({ workspaceCwds: [workspace] });
      assert.equal(
        rows.some((row) => row.summary.appSessionId === 'kept-chat'),
        false,
        'the main-thread mirror does not read the leftover canonical cache',
      );
    } finally {
      upgraded.close();
    }

    const verified = new DatabaseSync(canonicalPath);
    const session = verified
      .prepare('SELECT app_session_id, cwd FROM app_sessions WHERE app_session_id = ?')
      .get('kept-chat') as { app_session_id: string; cwd: string } | undefined;
    const leftover = verified
      .prepare('SELECT provider_session_id FROM session_file_cache WHERE provider_session_id = ?')
      .get('stale-cache-row') as { provider_session_id: string } | undefined;
    verified.close();
    assert.equal(session?.app_session_id, 'kept-chat');
    assert.equal(session?.cwd, workspace);
    assert.equal(leftover?.provider_session_id, 'stale-cache-row');
    assert.equal(
      columnNames(canonicalPath, 'session_file_cache').includes('launch_settings_json'),
      false,
    );
  });
});

test('the first derived index rebuilds the file cache and leaves canonical history alone', async () => {
  await withIsolatedHome((home) => {
    const workspace = join(home, 'workspace');
    writeSessionFile(home, 'kept-chat', workspace);
    const created = new HistoryIndex();
    persistTestSummaries([summary('kept-chat', workspace)]);
    created.close();

    const canonicalPath = join(home, '.factory', 'droidex', SESSION_INDEX_FILENAME);
    const canonical = new DatabaseSync(canonicalPath);
    canonical.exec(ORIGIN_MAIN_SESSION_FILE_CACHE);
    canonical.close();

    const derived = new HistoryIndexDatabase(canonicalPath);
    try {
      const result = derived.reconcileSessionFiles();
      const rebuilt = result.upserts.find((entry) => entry.providerSessionId === 'kept-chat');
      assert.equal(rebuilt?.summary?.appSessionId, 'kept-chat');
      assert.equal(rebuilt?.summary?.title, 'Chat kept-chat');
      const snapshot = derived.sessionFileSnapshot();
      assert.equal(
        snapshot.entries.some((entry) => entry.providerSessionId === 'kept-chat' && entry.summary),
        true,
      );
    } finally {
      derived.close();
    }

    const searchPath = join(home, '.factory', 'droidex', SESSION_SEARCH_INDEX_FILENAME);
    assert.deepEqual(columnNames(searchPath, 'session_file_cache'), [
      'provider_session_id',
      'path',
      'birthtime_ms',
      'mtime_ms',
      'size_bytes',
      'settings_mtime_ms',
      'summary_json',
      'launch_settings_json',
    ]);
    assert.ok(tableNames(canonicalPath).includes('session_file_cache'));
    assert.equal(
      columnNames(canonicalPath, 'session_file_cache').includes('launch_settings_json'),
      false,
    );
  });
});

test('an origin/main-shaped derived cache is dropped and recreated', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(ORIGIN_MAIN_SESSION_FILE_CACHE);
  db.exec(
    `INSERT INTO session_file_cache (
      provider_session_id, path, birthtime_ms, mtime_ms, size_bytes, settings_mtime_ms, summary_json
    ) VALUES ('old-row', '/tmp/old.jsonl', 1, 1, 1, NULL, '{"cacheVersion":1}')`,
  );
  initializeSessionFileCacheSchema(db);
  assert.deepEqual(columnNamesFrom(db, 'session_file_cache'), [
    'provider_session_id',
    'path',
    'birthtime_ms',
    'mtime_ms',
    'size_bytes',
    'settings_mtime_ms',
    'summary_json',
    'launch_settings_json',
  ]);
  const leftover = db.prepare('SELECT count(*) AS count FROM session_file_cache').get() as {
    count: number;
  };
  assert.equal(leftover.count, 0);
  db.close();
});

test('a journal written without lastActiveAt adopts nothing and keeps children', () => {
  const dir = mkdtempSync(join(tmpdir(), 'droidex-upgrade-journal-'));
  try {
    writeFileSync(
      liveRuntimeJournalPath(dir),
      JSON.stringify({
        sessions: [
          {
            appSessionId: 'live-chat',
            providerSessionId: 'provider-live-chat',
            phase: 'running',
            streaming: true,
          },
        ],
        children: [
          {
            parentAppSessionId: 'live-chat',
            childSessionId: 'worker-1',
            status: 'running',
          },
        ],
      }),
    );
    const journal = new LiveRuntimeJournal(liveRuntimeJournalPath(dir));
    const identities = journal.read();
    assert.deepEqual(identities.sessions, []);
    assert.equal(identities.children.length, 1);
    assert.equal(identities.children[0]?.childSessionId, 'worker-1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing live-runtime journal is an empty live set', () => {
  const dir = mkdtempSync(join(tmpdir(), 'droidex-upgrade-no-journal-'));
  try {
    const journal = new LiveRuntimeJournal(liveRuntimeJournalPath(dir));
    assert.deepEqual(journal.read(), { sessions: [], children: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function columnNamesFrom(db: DatabaseSync, table: string): string[] {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((row) => String((row as { name: unknown }).name));
}
