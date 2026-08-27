import { DatabaseSync } from 'node:sqlite';

import { numberValue, stringValue } from './values.js';

const SEARCH_INDEX_VERSION = 4;

export class HistorySearchUnavailableError extends Error {
  readonly code = 'history.search_unavailable' as const;

  constructor() {
    super(
      'This host SQLite build does not include FTS5, so derived history search cannot start. ' +
        'Canonical session history is stored and durable. Rebuild Node with SQLite FTS5 enabled to restore search.',
    );
    this.name = 'HistorySearchUnavailableError';
  }
}

function isMissingFts5Module(error: unknown): boolean {
  return error instanceof Error && /no such module:\s*fts5/i.test(error.message);
}

export function isHistorySearchUnavailableError(error: unknown): boolean {
  return (
    error instanceof HistorySearchUnavailableError ||
    (error instanceof Error && error.name === 'HistorySearchUnavailableError')
  );
}

const SQLITE_FTS5_UNAVAILABLE_REASON = 'SQLite FTS5 is unavailable on this host';

export function sqliteSupportsFts5(): boolean {
  const db = new DatabaseSync(':memory:');
  try {
    probeFts5(db);
    return true;
  } catch (error) {
    if (error instanceof HistorySearchUnavailableError) return false;
    throw error;
  } finally {
    db.close();
  }
}

export function sqliteFts5UnavailableSkipReason(): false | string {
  return sqliteSupportsFts5() ? false : SQLITE_FTS5_UNAVAILABLE_REASON;
}

export function initializeHistorySearchSchema(db: DatabaseSync): void {
  // Probe before dropping existing search tables so a missing FTS5 module cannot
  // destroy a derived index that another SQLite build could still read.
  probeFts5(db);
  const hasMetadata = hasExactColumns(db, 'history_search_metadata', ['key', 'value']);
  const version = hasMetadata
    ? (db.prepare("SELECT value FROM history_search_metadata WHERE key = 'version'").get() as
        | { value?: unknown }
        | undefined)
    : undefined;
  const ftsSchema = db
    .prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'history_search_fts'")
    .get() as { sql?: unknown } | undefined;
  const ftsSql = stringValue(ftsSchema?.sql)?.toLowerCase().replace(/\s+/g, ' ');
  const isCanonical =
    numberValue(version?.value) === SEARCH_INDEX_VERSION &&
    hasExactColumns(db, 'history_search_state', [
      'provider_session_id',
      'path',
      'birthtime_ms',
      'mtime_ms',
      'size_bytes',
      'indexed_bytes',
      'updated_at',
      'tail_fingerprint',
    ]) &&
    hasExactColumns(db, 'history_search_rows', [
      'rowid',
      'provider_session_id',
      'source_offset',
      'event_index',
    ]) &&
    hasExactColumns(db, 'history_search_fts', ['author', 'ts', 'text']) &&
    ftsSql?.includes('using fts5') === true &&
    ftsSql.includes("tokenize='trigram'");
  if (!isCanonical) {
    db.exec(`
      DROP TABLE IF EXISTS history_search_fts;
      DROP TABLE IF EXISTS history_search_rows;
      DROP TABLE IF EXISTS history_search_state;
      DROP TABLE IF EXISTS history_search_metadata;
    `);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS history_search_metadata (
      key TEXT PRIMARY KEY,
      value INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS history_search_state (
      provider_session_id TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      birthtime_ms REAL NOT NULL,
      mtime_ms REAL NOT NULL,
      size_bytes INTEGER NOT NULL,
      indexed_bytes INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      tail_fingerprint TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS history_search_rows (
      rowid INTEGER PRIMARY KEY,
      provider_session_id TEXT NOT NULL,
      source_offset INTEGER NOT NULL,
      event_index INTEGER NOT NULL,
      UNIQUE (provider_session_id, source_offset, event_index)
    );
    CREATE INDEX IF NOT EXISTS history_search_rows_provider
      ON history_search_rows (provider_session_id, rowid);
    CREATE VIRTUAL TABLE IF NOT EXISTS history_search_fts USING fts5(
      author UNINDEXED,
      ts UNINDEXED,
      text,
      tokenize='trigram'
    );
    INSERT INTO history_search_metadata (key, value)
    VALUES ('version', ${String(SEARCH_INDEX_VERSION)})
    ON CONFLICT(key) DO UPDATE SET value = excluded.value;
  `);
}

export function matchingHistoryProvidersSql(): string {
  return `
    SELECT rows.provider_session_id, MAX(state.updated_at) AS session_updated_at
    FROM history_search_fts AS fts
    JOIN history_search_rows AS rows ON rows.rowid = fts.rowid
    JOIN history_search_state AS state
      ON state.provider_session_id = rows.provider_session_id
    WHERE history_search_fts MATCH ?
    GROUP BY rows.provider_session_id
    ORDER BY session_updated_at DESC, rows.provider_session_id ASC
    LIMIT ?
  `;
}

export function providerHistoryMatchesSql(): string {
  return `
    SELECT rows.provider_session_id, fts.author, fts.ts,
           state.updated_at AS session_updated_at, fts.text
    FROM history_search_fts AS fts
    JOIN history_search_rows AS rows ON rows.rowid = fts.rowid
    JOIN history_search_state AS state
      ON state.provider_session_id = rows.provider_session_id
    WHERE history_search_fts MATCH ? AND rows.provider_session_id = ?
    ORDER BY CAST(fts.ts AS REAL) DESC
    LIMIT ?
  `;
}

function probeFts5(db: DatabaseSync): void {
  try {
    db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS droidex_fts5_probe USING fts5(x)');
    db.exec('DROP TABLE IF EXISTS droidex_fts5_probe');
  } catch (error) {
    if (isMissingFts5Module(error)) throw new HistorySearchUnavailableError();
    throw error;
  }
}

function hasExactColumns(db: DatabaseSync, table: string, expected: string[]): boolean {
  const columns = db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((row) => stringValue((row as { name: unknown }).name));
  return (
    columns.length === expected.length &&
    expected.every((column, index) => columns[index] === column)
  );
}
