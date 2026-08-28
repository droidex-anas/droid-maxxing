import type { DatabaseSync, StatementSync } from 'node:sqlite';

import type { SearchableSessionFileEntry } from './sessionFileCache.js';
import { HistorySearchReader } from './historySearchReader.js';
import { initializeHistorySearchSchema } from './historySearchSchema.js';
import {
  readSessionSearchSlice,
  sessionSearchFingerprint,
  type SessionSearchSlice,
} from './sessionSearch.js';
import type { SessionSearchResult } from './protocol.js';
import { numberValue, stringValue } from './values.js';

interface SearchIndexState {
  path: string;
  birthtimeMs: number;
  mtimeMs: number;
  sizeBytes: number;
  indexedBytes: number;
  updatedAt: number;
  tailFingerprint: string;
}

interface SearchStateRow extends Record<string, unknown> {
  provider_session_id: unknown;
  path: unknown;
  birthtime_ms: unknown;
  mtime_ms: unknown;
  size_bytes: unknown;
  indexed_bytes: unknown;
  updated_at: unknown;
  tail_fingerprint: unknown;
}

interface HistorySearchReconciliationPlan {
  pendingEntries: SearchableSessionFileEntry[];
  removedFiles: number;
}

interface HistorySearchIndexSliceResult {
  indexedBytes: number;
  indexedRecords: number;
  complete: boolean;
}

export class HistorySearchIndex {
  private readonly deleteContent: StatementSync;
  private readonly deleteRows: StatementSync;
  private readonly deleteState: StatementSync;
  private readonly insertRow: StatementSync;
  private readonly insertContent: StatementSync;
  private readonly upsertState: StatementSync;
  private readonly stateStatement: StatementSync;
  private readonly currentFileStatement: StatementSync | null;
  private readonly reader: HistorySearchReader;
  private readonly stateByProvider = new Map<string, SearchIndexState>();

  constructor(
    private readonly db: DatabaseSync,
    private readonly canonicalDb: DatabaseSync = db,
  ) {
    initializeHistorySearchSchema(db);
    this.deleteContent = db.prepare(`
      DELETE FROM history_search_fts
      WHERE rowid IN (
        SELECT rowid FROM history_search_rows WHERE provider_session_id = ?
      )
    `);
    this.deleteRows = db.prepare('DELETE FROM history_search_rows WHERE provider_session_id = ?');
    this.deleteState = db.prepare('DELETE FROM history_search_state WHERE provider_session_id = ?');
    this.insertRow = db.prepare(`
      INSERT OR IGNORE INTO history_search_rows (
        provider_session_id, source_offset, event_index
      ) VALUES (?, ?, ?)
    `);
    this.insertContent = db.prepare(
      'INSERT INTO history_search_fts (rowid, author, ts, text) VALUES (?, ?, ?, ?)',
    );
    this.upsertState = db.prepare(`
      INSERT INTO history_search_state (
        provider_session_id, path, birthtime_ms, mtime_ms, size_bytes,
        indexed_bytes, updated_at, tail_fingerprint
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider_session_id) DO UPDATE SET
        path = excluded.path,
        birthtime_ms = excluded.birthtime_ms,
        mtime_ms = excluded.mtime_ms,
        size_bytes = excluded.size_bytes,
        indexed_bytes = excluded.indexed_bytes,
        updated_at = excluded.updated_at,
        tail_fingerprint = excluded.tail_fingerprint
    `);
    this.stateStatement = db.prepare(`
      SELECT provider_session_id, path, birthtime_ms, mtime_ms,
             size_bytes, indexed_bytes, updated_at, tail_fingerprint
      FROM history_search_state
      WHERE provider_session_id = ?
    `);
    this.reader = new HistorySearchReader(db, canonicalDb);
    this.currentFileStatement = hasTable(db, 'session_file_cache')
      ? db.prepare(`
          SELECT path, birthtime_ms, mtime_ms, size_bytes
          FROM session_file_cache
          WHERE provider_session_id = ? AND summary_json IS NOT NULL
        `)
      : null;
    this.loadState();
  }

  reconcileEntries(entries: SearchableSessionFileEntry[]): HistorySearchReconciliationPlan {
    const providerIds = new Set(entries.map((entry) => entry.providerSessionId));
    const removed = [...this.stateByProvider.keys()].filter((id) => !providerIds.has(id));
    const removedFiles = this.removeProviders(removed);
    return {
      pendingEntries: entries.filter((entry) => this.needsIndexing(entry)),
      removedFiles,
    };
  }

  applyEntryChanges(
    entries: SearchableSessionFileEntry[],
    removedProviderSessionIds: string[],
  ): HistorySearchReconciliationPlan {
    const removedFiles = this.removeProviders(removedProviderSessionIds);
    return {
      pendingEntries: entries.filter((entry) => this.needsIndexing(entry)),
      removedFiles,
    };
  }

  needsIndexing(entry: SearchableSessionFileEntry): boolean {
    const state = this.refreshProviderState(entry.providerSessionId);
    return !state || !matchesCompleteState(state, entry);
  }

  async indexSlice(
    entry: SearchableSessionFileEntry,
    isStale?: () => boolean,
  ): Promise<HistorySearchIndexSliceResult> {
    if (staleRequest(isStale)) return emptySlice(false);
    let state = this.refreshProviderState(entry.providerSessionId);
    if (state && mustRebuild(state, entry)) {
      if (!this.removeProviderForCurrentEntry(entry)) return emptySlice(false);
      state = undefined;
    }
    if (state && entry.sizeBytes > state.sizeBytes) {
      const fingerprint = await sessionSearchFingerprint(entry.path, state.indexedBytes);
      if (fingerprint !== state.tailFingerprint) {
        if (!this.removeProviderForCurrentEntry(entry)) return emptySlice(false);
        state = undefined;
      }
    }
    if (state && matchesCompleteState(state, entry)) return emptySlice(true);

    const startByteOffset = state?.indexedBytes ?? 0;
    const slice = await readSessionSearchSlice(
      {
        providerSessionId: entry.providerSessionId,
        appSessionId: entry.summary.appSessionId,
        path: entry.path,
        sizeBytes: entry.sizeBytes,
      },
      startByteOffset,
    );
    if (staleRequest(isStale)) return emptySlice(false);
    return this.commitIndexSlice(entry, startByteOffset, slice);
  }

  private commitIndexSlice(
    entry: SearchableSessionFileEntry,
    startByteOffset: number,
    slice: SessionSearchSlice,
  ): HistorySearchIndexSliceResult {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (!this.isCurrentFileEntry(entry)) {
        this.db.exec('COMMIT');
        return emptySlice(false);
      }
      let committed = this.readState(entry.providerSessionId);
      if (committed && mustRebuild(committed, entry)) {
        this.deleteProvider(entry.providerSessionId);
        committed = undefined;
      }
      if (committed && committed.indexedBytes !== startByteOffset) {
        this.db.exec('COMMIT');
        this.stateByProvider.set(entry.providerSessionId, committed);
        return {
          indexedBytes: Math.max(0, committed.indexedBytes - startByteOffset),
          indexedRecords: 0,
          complete: matchesCompleteState(committed, entry),
        };
      }
      if (!committed && startByteOffset !== 0) {
        this.db.exec('COMMIT');
        this.stateByProvider.delete(entry.providerSessionId);
        return emptySlice(false);
      }
      let indexedRecords = 0;
      for (const record of slice.records) {
        const inserted = this.insertRow.run(
          entry.providerSessionId,
          record.sourceByteOffset,
          record.eventIndex,
        );
        if (Number(inserted.changes) === 0) continue;
        this.insertContent.run(inserted.lastInsertRowid, record.author, record.ts, record.text);
        indexedRecords += 1;
      }
      this.upsertState.run(
        entry.providerSessionId,
        entry.path,
        entry.birthtimeMs,
        entry.mtimeMs,
        entry.sizeBytes,
        slice.nextByteOffset,
        entry.summary.updatedAt,
        slice.tailFingerprint,
      );
      this.db.exec('COMMIT');
      this.stateByProvider.set(entry.providerSessionId, {
        path: entry.path,
        birthtimeMs: entry.birthtimeMs,
        mtimeMs: entry.mtimeMs,
        sizeBytes: entry.sizeBytes,
        indexedBytes: slice.nextByteOffset,
        updatedAt: entry.summary.updatedAt,
        tailFingerprint: slice.tailFingerprint,
      });
      return {
        indexedBytes: slice.nextByteOffset - startByteOffset,
        indexedRecords,
        complete: slice.reachedEnd,
      };
    } catch (error) {
      rollback(this.db);
      throw error;
    }
  }

  search(query: string, isStale?: () => boolean): SessionSearchResult[] {
    return this.reader.search(query, isStale);
  }

  private refreshProviderState(providerSessionId: string): SearchIndexState | undefined {
    const state = this.readState(providerSessionId);
    if (state) this.stateByProvider.set(providerSessionId, state);
    else this.stateByProvider.delete(providerSessionId);
    return state;
  }

  private readState(providerSessionId: string): SearchIndexState | undefined {
    const row = this.stateStatement.get(providerSessionId) as SearchStateRow | undefined;
    return row ? searchStateFromRow(row) : undefined;
  }

  private removeProviderForCurrentEntry(entry: SearchableSessionFileEntry): boolean {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (!this.isCurrentFileEntry(entry)) {
        this.db.exec('COMMIT');
        return false;
      }
      this.deleteProvider(entry.providerSessionId);
      this.db.exec('COMMIT');
      this.stateByProvider.delete(entry.providerSessionId);
      return true;
    } catch (error) {
      rollback(this.db);
      throw error;
    }
  }

  private isCurrentFileEntry(entry: SearchableSessionFileEntry): boolean {
    if (!this.currentFileStatement) return true;
    const row = this.currentFileStatement.get(entry.providerSessionId) as
      | {
          path: unknown;
          birthtime_ms: unknown;
          mtime_ms: unknown;
          size_bytes: unknown;
        }
      | undefined;
    return (
      stringValue(row?.path) === entry.path &&
      numberValue(row?.birthtime_ms) === entry.birthtimeMs &&
      numberValue(row?.mtime_ms) === entry.mtimeMs &&
      numberValue(row?.size_bytes) === entry.sizeBytes
    );
  }

  private deleteProvider(providerSessionId: string): void {
    this.deleteContent.run(providerSessionId);
    this.deleteRows.run(providerSessionId);
    this.deleteState.run(providerSessionId);
  }

  private removeProviders(providerSessionIds: string[]): number {
    if (providerSessionIds.length === 0) return 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const providerSessionId of providerSessionIds) {
        this.deleteProvider(providerSessionId);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      rollback(this.db);
      throw error;
    }
    for (const providerSessionId of providerSessionIds) {
      this.stateByProvider.delete(providerSessionId);
    }
    return providerSessionIds.length;
  }

  private loadState(): void {
    const rows = this.db
      .prepare(
        `SELECT provider_session_id, path, birthtime_ms, mtime_ms,
                size_bytes, indexed_bytes, updated_at, tail_fingerprint
         FROM history_search_state`,
      )
      .all() as SearchStateRow[];
    for (const row of rows) {
      const providerSessionId = stringValue(row.provider_session_id);
      const state = searchStateFromRow(row);
      if (!providerSessionId || !state) {
        if (providerSessionId) this.removeProviders([providerSessionId]);
        continue;
      }
      this.stateByProvider.set(providerSessionId, state);
    }
  }
}

function searchStateFromRow(row: SearchStateRow): SearchIndexState | undefined {
  const path = stringValue(row.path);
  const birthtimeMs = numberValue(row.birthtime_ms);
  const mtimeMs = numberValue(row.mtime_ms);
  const sizeBytes = numberValue(row.size_bytes);
  const indexedBytes = numberValue(row.indexed_bytes);
  const updatedAt = numberValue(row.updated_at);
  const tailFingerprint = stringValue(row.tail_fingerprint);
  if (
    !path ||
    !nonNegativeNumber(birthtimeMs) ||
    !nonNegativeNumber(mtimeMs) ||
    !nonNegativeSafeInteger(sizeBytes) ||
    !nonNegativeSafeInteger(indexedBytes) ||
    indexedBytes > sizeBytes ||
    !nonNegativeNumber(updatedAt) ||
    tailFingerprint === undefined
  ) {
    return undefined;
  }
  return {
    path,
    birthtimeMs,
    mtimeMs,
    sizeBytes,
    indexedBytes,
    updatedAt,
    tailFingerprint,
  };
}

function nonNegativeNumber(value: number | undefined): value is number {
  return value !== undefined && value >= 0;
}

function nonNegativeSafeInteger(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0;
}

function matchesCompleteState(state: SearchIndexState, entry: SearchableSessionFileEntry): boolean {
  return (
    state.path === entry.path &&
    state.birthtimeMs === entry.birthtimeMs &&
    state.mtimeMs === entry.mtimeMs &&
    state.sizeBytes === entry.sizeBytes &&
    state.indexedBytes >= entry.sizeBytes &&
    state.updatedAt === entry.summary.updatedAt
  );
}

function mustRebuild(state: SearchIndexState, entry: SearchableSessionFileEntry): boolean {
  return (
    state.path !== entry.path ||
    state.birthtimeMs !== entry.birthtimeMs ||
    entry.sizeBytes < state.indexedBytes ||
    (entry.sizeBytes === state.sizeBytes &&
      (entry.mtimeMs !== state.mtimeMs || entry.summary.updatedAt !== state.updatedAt))
  );
}

function staleRequest(isStale: (() => boolean) | undefined): boolean {
  return isStale?.() ?? false;
}

function hasTable(db: DatabaseSync, table: string): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table) !==
    undefined
  );
}

function rollback(db: DatabaseSync): void {
  try {
    db.exec('ROLLBACK');
  } catch {
    // Preserve the original SQLite error.
  }
}

function emptySlice(complete: boolean): HistorySearchIndexSliceResult {
  return { indexedBytes: 0, indexedRecords: 0, complete };
}
