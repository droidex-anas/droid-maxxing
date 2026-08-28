import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { HistorySearchIndex } from './historySearchIndex.js';
import { sqliteFts5UnavailableSkipReason } from './historySearchSchema.js';
import type { SearchableSessionFileEntry } from './sessionFileCache.js';
import type { SessionSummary } from './protocol.js';
import { droidSessionConfiguration } from './providers/providerIdentity.js';

const FTS5_UNAVAILABLE_REASON = sqliteFts5UnavailableSkipReason();

function createDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE app_sessions (
      app_session_id TEXT PRIMARY KEY,
      provider_session_id TEXT NOT NULL,
      compacted_from_provider_session_ids TEXT NOT NULL DEFAULT '[]',
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE events (id TEXT PRIMARY KEY);
    CREATE TABLE settings (
      scope TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    INSERT INTO events (id) VALUES ('keep-me');
    PRAGMA user_version = 2;
  `);
  return db;
}

function messageLine(id: string, role: 'user' | 'assistant', text: string, ts: number): string {
  return JSON.stringify({
    id,
    type: 'message',
    timestamp: new Date(ts).toISOString(),
    message: { role, content: [{ type: 'text', text }] },
  });
}

function summary(providerSessionId: string, updatedAt: number): SessionSummary {
  return {
    appSessionId: providerSessionId,
    providerSessionId,
    sessionPurpose: 'chat',
    role: 'primary',
    title: providerSessionId,
    goal: providerSessionId,
    cwd: '/repo',
    workspaceKind: 'folder',
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
    createdAt: 1,
    updatedAt,
  };
}

function writeSession(
  directory: string,
  providerSessionId: string,
  lines: string[],
  updatedAt: number,
): SearchableSessionFileEntry {
  const path = join(directory, `${providerSessionId}.jsonl`);
  writeFileSync(path, `${lines.join('\n')}\n`);
  const stat = statSync(path);
  return {
    providerSessionId,
    path,
    birthtimeMs: stat.birthtimeMs,
    mtimeMs: stat.mtimeMs,
    sizeBytes: stat.size,
    summary: summary(providerSessionId, updatedAt),
  };
}

async function reconcileAll(
  index: HistorySearchIndex,
  entries: SearchableSessionFileEntry[],
  isStale?: () => boolean,
): Promise<{ indexedFiles: number; removedFiles: number }> {
  const plan = index.reconcileEntries(entries);
  let indexedFiles = 0;
  for (const entry of plan.pendingEntries) {
    let slices = 0;
    while (index.needsIndexing(entry) && !isStale?.()) {
      const result = await index.indexSlice(entry, isStale);
      slices += 1;
      if (result.complete) {
        indexedFiles += 1;
        break;
      }
      assert.ok(result.indexedBytes > 0, 'an incomplete index slice must make progress');
      assert.ok(slices < 10_000, 'index reconciliation must remain bounded');
    }
  }
  return { indexedFiles, removedFiles: plan.removedFiles };
}

async function applyChanges(
  index: HistorySearchIndex,
  entries: SearchableSessionFileEntry[],
  removedProviderSessionIds: string[],
): Promise<{ indexedFiles: number; removedFiles: number }> {
  const plan = index.applyEntryChanges(entries, removedProviderSessionIds);
  let indexedFiles = 0;
  for (const entry of plan.pendingEntries) {
    while (index.needsIndexing(entry)) {
      const result = await index.indexSlice(entry);
      if (result.complete) {
        indexedFiles += 1;
        break;
      }
      assert.ok(result.indexedBytes > 0);
    }
  }
  return { indexedFiles, removedFiles: plan.removedFiles };
}

test(
  'indexed search survives raw-file removal and preserves aliases and substring behavior',
  { skip: FTS5_UNAVAILABLE_REASON },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'droid-history-fts-'));
    const dbPath = join(directory, 'history.sqlite');
    const db = createDatabase(dbPath);
    try {
      const entry = writeSession(
        directory,
        'provider-one',
        [
          messageLine('one', 'user', 'hi bro whatsapp, long time no see', 1_000),
          messageLine('two', 'assistant', 'The C++ parser is fixed.', 2_000),
        ],
        5_000,
      );
      db.prepare(
        `INSERT INTO app_sessions (
        app_session_id, provider_session_id, compacted_from_provider_session_ids, updated_at
      ) VALUES (?, ?, ?, ?)`,
      ).run('app-main', 'provider-one', JSON.stringify(['provider-old']), 9_000);

      const index = new HistorySearchIndex(db);
      assert.deepEqual(await reconcileAll(index, [entry]), {
        indexedFiles: 1,
        removedFiles: 0,
      });
      unlinkSync(entry.path);

      const word = await index.search('BRO WHATSAPP');
      assert.equal(word[0]?.appSessionId, 'app-main');
      assert.equal(word[0]?.matches[0]?.author, 'user');
      assert.ok(word[0]?.matches[0]?.snippet.includes('bro whatsapp'));
      assert.deepEqual(await index.search('hi'), []);
      assert.equal((await index.search('C++'))[0]?.matches[0]?.author, 'assistant');

      db.close();
      const reopened = new DatabaseSync(dbPath);
      try {
        const reopenedIndex = new HistorySearchIndex(reopened);
        assert.equal((await reopenedIndex.search('whatsapp'))[0]?.appSessionId, 'app-main');
        assert.equal(reopened.prepare('PRAGMA user_version').get()?.['user_version'], 2);
        assert.equal(
          (reopened.prepare('SELECT id FROM events').get() as { id: string }).id,
          'keep-me',
        );
      } finally {
        reopened.close();
      }
    } finally {
      if (db.isOpen) db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  'canonical provider aliases ignore malformed alias lists for one row',
  { skip: FTS5_UNAVAILABLE_REASON },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'droid-history-fts-aliases-'));
    const db = createDatabase(join(directory, 'history.sqlite'));
    try {
      const entry = writeSession(
        directory,
        'provider-malformed-alias',
        [messageLine('one', 'user', 'malformed alias needle', 1_000)],
        1_000,
      );
      const aliasEntry = writeSession(
        directory,
        'provider-old',
        [messageLine('two', 'user', 'old alias needle', 2_000)],
        2_000,
      );
      db.prepare(
        `INSERT INTO app_sessions (
        app_session_id, provider_session_id, compacted_from_provider_session_ids, updated_at
      ) VALUES (?, ?, ?, ?)`,
      ).run('app-malformed-alias', 'provider-malformed-alias', '["provider-old", 42]', 1_000);
      const index = new HistorySearchIndex(db);
      await reconcileAll(index, [entry, aliasEntry]);

      assert.equal(index.search('malformed alias')[0]?.appSessionId, 'app-malformed-alias');
      assert.equal(index.search('old alias')[0]?.appSessionId, 'provider-old');
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  'canonical aliases refresh only when the summary identity revision advances',
  { skip: FTS5_UNAVAILABLE_REASON },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'droid-history-fts-identity-revision-'));
    const dbPath = join(directory, 'history.sqlite');
    const db = createDatabase(dbPath);
    try {
      const entry = writeSession(
        directory,
        'provider-revision',
        [messageLine('one', 'user', 'identity revision needle', 1_000)],
        1_000,
      );
      const index = new HistorySearchIndex(db);
      await reconcileAll(index, [entry]);
      assert.equal(index.search('needle')[0]?.appSessionId, 'provider-revision');

      const otherProcess = new DatabaseSync(dbPath);
      try {
        otherProcess
          .prepare(
            `INSERT INTO app_sessions (
            app_session_id, provider_session_id, compacted_from_provider_session_ids, updated_at
          ) VALUES (?, ?, ?, ?)`,
          )
          .run('app-revision', 'provider-revision', '[]', 2_000);
        assert.equal(
          index.search('needle')[0]?.appSessionId,
          'provider-revision',
          'a commit without an identity revision cannot force an app_sessions scan',
        );
        otherProcess
          .prepare(
            `INSERT INTO settings (scope, value_json, updated_at)
           VALUES ('history.search_identity_revision', '1', ?)`,
          )
          .run(2_000);
        assert.equal(index.search('needle')[0]?.appSessionId, 'app-revision');
      } finally {
        otherProcess.close();
      }
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  'one high-volume provider cannot starve another matching session',
  { skip: FTS5_UNAVAILABLE_REASON },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'droid-history-fts-fairness-'));
    const db = createDatabase(join(directory, 'history.sqlite'));
    try {
      const noisy = writeSession(
        directory,
        'provider-noisy',
        Array.from({ length: 4_200 }, (_, index) =>
          messageLine(`noisy-${String(index)}`, 'assistant', 'shared fairness marker', index),
        ),
        2_000,
      );
      const quiet = writeSession(
        directory,
        'provider-quiet',
        [messageLine('quiet', 'user', 'shared fairness marker', 5_000)],
        1_000,
      );
      const index = new HistorySearchIndex(db);
      await reconcileAll(index, [noisy, quiet]);

      assert.deepEqual(
        index
          .search('fairness marker')
          .map((result) => result.appSessionId)
          .sort(),
        ['provider-noisy', 'provider-quiet'],
      );
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  'overlapping index connections commit each source event exactly once',
  { skip: FTS5_UNAVAILABLE_REASON },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'droid-history-fts-idempotent-'));
    const dbPath = join(directory, 'history.sqlite');
    const firstDb = createDatabase(dbPath);
    const secondDb = new DatabaseSync(dbPath);
    try {
      const entry = writeSession(
        directory,
        'provider-idempotent',
        [messageLine('one', 'user', 'idempotent wombat marker', 1_000)],
        1_000,
      );
      const first = new HistorySearchIndex(firstDb);
      const second = new HistorySearchIndex(secondDb);

      await Promise.all([first.indexSlice(entry), second.indexSlice(entry)]);

      assert.equal(
        firstDb
          .prepare(
            'SELECT count(*) AS count FROM history_search_rows WHERE provider_session_id = ?',
          )
          .get(entry.providerSessionId)?.['count'],
        1,
      );
      assert.equal(first.search('wombat marker')[0]?.matches.length, 1);
    } finally {
      secondDb.close();
      firstDb.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  'reconciliation indexes only changed files and removes deleted sessions',
  { skip: FTS5_UNAVAILABLE_REASON },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'droid-history-fts-refresh-'));
    const db = createDatabase(join(directory, 'history.sqlite'));
    try {
      const index = new HistorySearchIndex(db);
      const first = writeSession(
        directory,
        'provider-refresh',
        [messageLine('one', 'user', 'first version needle', 1_000)],
        1_000,
      );
      assert.equal((await reconcileAll(index, [first])).indexedFiles, 1);
      assert.deepEqual(await reconcileAll(index, [first]), { indexedFiles: 0, removedFiles: 0 });

      const changed = writeSession(
        directory,
        'provider-refresh',
        [messageLine('two', 'assistant', 'second version compass', 2_000)],
        2_000,
      );
      assert.equal((await reconcileAll(index, [changed])).indexedFiles, 1);
      assert.deepEqual(await index.search('needle'), []);
      assert.equal((await index.search('compass'))[0]?.matches[0]?.ts, 2_000);

      assert.deepEqual(await reconcileAll(index, []), { indexedFiles: 0, removedFiles: 1 });
      assert.deepEqual(await index.search('compass'), []);
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  'a same-size rewrite with a new session revision rebuilds indexed content',
  { skip: FTS5_UNAVAILABLE_REASON },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'droid-history-fts-same-size-'));
    const db = createDatabase(join(directory, 'history.sqlite'));
    try {
      const index = new HistorySearchIndex(db);
      const first = writeSession(
        directory,
        'provider-same-size',
        [messageLine('one', 'user', 'first rewrite marker', 1_000)],
        1_000,
      );
      assert.equal((await reconcileAll(index, [first])).indexedFiles, 1);
      const originalDate = new Date(first.mtimeMs);

      const rewritten = writeSession(
        directory,
        'provider-same-size',
        [messageLine('two', 'user', 'other rewrite marker', 2_000)],
        2_000,
      );
      assert.equal(rewritten.sizeBytes, first.sizeBytes);
      utimesSync(rewritten.path, originalDate, originalDate);
      const sameStatRewrite = { ...rewritten, mtimeMs: first.mtimeMs };

      assert.equal((await applyChanges(index, [sameStatRewrite], [])).indexedFiles, 1);
      assert.deepEqual(await index.search('first rewrite'), []);
      assert.equal((await index.search('other rewrite'))[0]?.appSessionId, 'provider-same-size');
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  'an appended session preserves indexed rows and adds only the new tail',
  { skip: FTS5_UNAVAILABLE_REASON },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'droid-history-fts-append-'));
    const db = createDatabase(join(directory, 'history.sqlite'));
    try {
      const index = new HistorySearchIndex(db);
      const first = writeSession(
        directory,
        'provider-append',
        [messageLine('one', 'user', 'first immutable transcript row', 1_000)],
        1_000,
      );
      await reconcileAll(index, [first]);
      const firstRowIds = db
        .prepare(
          'SELECT rowid FROM history_search_rows WHERE provider_session_id = ? ORDER BY rowid',
        )
        .all('provider-append')
        .map((row) => Number(row['rowid']));

      const appended = writeSession(
        directory,
        'provider-append',
        [
          messageLine('one', 'user', 'first immutable transcript row', 1_000),
          messageLine('two', 'assistant', 'second appended transcript row', 2_000),
        ],
        2_000,
      );
      assert.equal((await applyChanges(index, [appended], [])).indexedFiles, 1);

      const rowIds = db
        .prepare(
          'SELECT rowid FROM history_search_rows WHERE provider_session_id = ? ORDER BY rowid',
        )
        .all('provider-append')
        .map((row) => Number(row['rowid']));
      assert.deepEqual(rowIds.slice(0, firstRowIds.length), firstRowIds);
      assert.equal(rowIds.length, firstRowIds.length + 1);
      assert.equal((await index.search('second appended'))[0]?.appSessionId, 'provider-append');
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  'partial indexing resumes from its committed byte cursor after restart',
  { skip: FTS5_UNAVAILABLE_REASON },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'droid-history-fts-resume-'));
    const dbPath = join(directory, 'history.sqlite');
    const lines = Array.from({ length: 2_000 }, (_, index) =>
      messageLine(
        `resume-${String(index)}`,
        index % 2 === 0 ? 'user' : 'assistant',
        `restartable history row ${String(index)} ${'x'.repeat(120)}`,
        1_000 + index,
      ),
    );
    const entry = writeSession(directory, 'provider-resume', lines, 5_000);
    const firstDb = createDatabase(dbPath);
    let rowsBeforeRestart = 0;
    try {
      const firstIndex = new HistorySearchIndex(firstDb);
      const firstSlice = await firstIndex.indexSlice(entry);
      assert.equal(firstSlice.complete, false);
      rowsBeforeRestart = Number(
        (
          firstDb.prepare('SELECT count(*) AS count FROM history_search_rows').get() as {
            count: number;
          }
        ).count,
      );
      const state = firstDb
        .prepare(
          'SELECT indexed_bytes, size_bytes FROM history_search_state WHERE provider_session_id = ?',
        )
        .get('provider-resume') as { indexed_bytes: number; size_bytes: number };
      assert.ok(state.indexed_bytes > 0 && state.indexed_bytes < state.size_bytes);
    } finally {
      firstDb.close();
    }

    const reopened = new DatabaseSync(dbPath);
    try {
      const resumedIndex = new HistorySearchIndex(reopened);
      assert.equal(
        (
          reopened.prepare('SELECT count(*) AS count FROM history_search_rows').get() as {
            count: number;
          }
        ).count,
        rowsBeforeRestart,
        'committed rows survive restart instead of being rebuilt',
      );
      assert.equal((await reconcileAll(resumedIndex, [entry])).indexedFiles, 1);
      assert.equal(
        (await resumedIndex.search('history row 1999'))[0]?.appSessionId,
        'provider-resume',
      );
    } finally {
      reopened.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  'invalid persisted byte cursors are discarded and rebuilt safely',
  { skip: FTS5_UNAVAILABLE_REASON },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'droid-history-fts-invalid-cursor-'));
    const db = createDatabase(join(directory, 'history.sqlite'));
    try {
      const entry = writeSession(
        directory,
        'provider-invalid-cursor',
        [messageLine('one', 'user', 'rebuilt cursor needle', 1_000)],
        1_000,
      );
      const first = new HistorySearchIndex(db);
      await reconcileAll(first, [entry]);
      db.prepare(
        `UPDATE history_search_state
       SET indexed_bytes = size_bytes + 1
       WHERE provider_session_id = ?`,
      ).run(entry.providerSessionId);

      const reopened = new HistorySearchIndex(db);
      assert.equal(reopened.needsIndexing(entry), true);
      assert.equal((await reconcileAll(reopened, [entry])).indexedFiles, 1);
      assert.equal(reopened.search('cursor needle')[0]?.appSessionId, entry.providerSessionId);
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  'reconciliation indexes messages before the newest five megabytes',
  { skip: FTS5_UNAVAILABLE_REASON },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'droid-history-fts-full-file-'));
    const db = createDatabase(join(directory, 'history.sqlite'));
    try {
      const entry = writeSession(
        directory,
        'provider-oversized',
        [
          messageLine('early', 'user', 'the archival albatross is searchable', 1_000),
          messageLine('filler', 'assistant', 'x'.repeat(5_100_000), 2_000),
          messageLine('tail', 'assistant', 'latest message', 3_000),
        ],
        3_000,
      );

      const index = new HistorySearchIndex(db);
      assert.equal((await reconcileAll(index, [entry])).indexedFiles, 1);
      assert.equal(
        (await index.search('archival albatross'))[0]?.appSessionId,
        'provider-oversized',
      );
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  'stale reconciliation and search stop without publishing results',
  { skip: FTS5_UNAVAILABLE_REASON },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'droid-history-fts-stale-'));
    const db = createDatabase(join(directory, 'history.sqlite'));
    try {
      const entry = writeSession(
        directory,
        'provider-stale',
        [messageLine('one', 'user', 'do not publish this needle', 1_000)],
        1_000,
      );
      const index = new HistorySearchIndex(db);
      assert.deepEqual(await reconcileAll(index, [entry], () => true), {
        indexedFiles: 0,
        removedFiles: 0,
      });
      assert.deepEqual(await index.search('needle', () => true), []);
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  'a corrupt derived search schema rebuilds without touching canonical history rows',
  { skip: FTS5_UNAVAILABLE_REASON },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'droid-history-fts-recovery-'));
    const db = createDatabase(join(directory, 'history.sqlite'));
    try {
      db.exec(`
      CREATE TABLE history_search_metadata (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
      INSERT INTO history_search_metadata (key, value) VALUES ('version', 1);
      CREATE TABLE history_search_state (broken TEXT);
      CREATE TABLE history_search_fts (broken TEXT);
    `);
      const entry = writeSession(
        directory,
        'provider-recovery',
        [messageLine('one', 'user', 'recoverable search needle', 1_000)],
        1_000,
      );

      const index = new HistorySearchIndex(db);
      assert.equal((await reconcileAll(index, [entry])).indexedFiles, 1);
      assert.equal((await index.search('needle'))[0]?.appSessionId, 'provider-recovery');
      assert.equal(db.prepare('PRAGMA user_version').get()?.['user_version'], 2);
      assert.equal((db.prepare('SELECT id FROM events').get() as { id: string }).id, 'keep-me');
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
