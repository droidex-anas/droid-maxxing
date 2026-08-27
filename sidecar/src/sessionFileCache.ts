/**
 * Canonical derived index of the session files under ~/.factory/sessions.
 * HistoryIndexDatabase owns the SQLite connection; the orchestration thread
 * receives revisioned deltas through its in-memory mirror and never reads the
 * derived database directly.
 */
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { ReasoningEffort, SessionSummary } from './protocol.js';
import {
  parseCachedSessionSummary,
  SESSION_FILE_REASONING_EFFORTS,
  serializeCachedSessionSummary,
} from './sessionFileSummaryCache.js';
import { copySessionFileEntry } from './sessionFileEntries.js';
import { numberValue, stringValue } from './values.js';
import { initializeSessionFileCacheSchema } from './sessionFileCacheSchema.js';

export interface SessionFileLaunchSettings {
  modelId: string;
  reasoningEffort?: ReasoningEffort;
}

export interface SessionFileStat {
  path: string;
  birthtimeMs: number;
  mtimeMs: number;
  sizeBytes: number;
  // Mtime of the sibling <id>.settings.json the summary also reads, null when
  // no settings file exists. Part of the reconcile freshness key.
  settingsMtimeMs: number | null;
}

export interface SessionFileChange {
  providerSessionId: string;
  // Absolute path of the session (.jsonl) file; it may no longer exist.
  path: string;
}

export interface SessionFileScan {
  files: Map<string, SessionFileStat>;
  // False when any subtree vanished or became unreadable during the walk.
  // Upserts are still authoritative, but absences cannot prove deletion.
  isComplete: boolean;
}

export interface SessionFileCacheEntry extends SessionFileStat {
  providerSessionId: string;
  // Null marks a scanned file that was not admitted to durable top-level
  // history, so reconciles skip it until its freshness key changes.
  summary: SessionSummary | null;
  launchSettings?: SessionFileLaunchSettings;
}

// Everything one session file contributes to the cache. Summary and launch
// settings come from the same read: they answer questions about the same
// bytes, and reading the file twice per reconcile is the discovery path's
// dominant cost.
export interface SessionFileSummary {
  summary: SessionSummary | null;
  launchSettings?: SessionFileLaunchSettings;
}

export interface SessionFileReconciliation {
  previousRevision: number;
  revision: number;
  changed: number;
  upserts: SessionFileCacheEntry[];
  removedProviderSessionIds: string[];
}

export interface SessionFileSnapshot {
  revision: number;
  changed: number;
  entries: SessionFileCacheEntry[];
}

// One cached session file as transcript content search needs it: identity,
// location, and the freshness key, plus the base summary for the caller's
// patch overlay.
export interface SearchableSessionFileEntry {
  providerSessionId: string;
  path: string;
  birthtimeMs: number;
  mtimeMs: number;
  sizeBytes: number;
  summary: SessionSummary;
}

interface StoredSessionFileRow extends Record<string, unknown> {
  provider_session_id: unknown;
  path: unknown;
  birthtime_ms: unknown;
  mtime_ms: unknown;
  size_bytes: unknown;
  settings_mtime_ms: unknown;
  summary_json: unknown;
  launch_settings_json: unknown;
}

const UPSERT_SESSION_FILE = `
  INSERT INTO session_file_cache (
    provider_session_id, path, birthtime_ms, mtime_ms, size_bytes, settings_mtime_ms,
    summary_json, launch_settings_json
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(provider_session_id) DO UPDATE SET
    path = excluded.path,
    birthtime_ms = excluded.birthtime_ms,
    mtime_ms = excluded.mtime_ms,
    size_bytes = excluded.size_bytes,
    settings_mtime_ms = excluded.settings_mtime_ms,
    summary_json = excluded.summary_json,
    launch_settings_json = excluded.launch_settings_json
`;
const REMOVE_SESSION_FILE = 'DELETE FROM session_file_cache WHERE provider_session_id = ?';
const READ_REVISION = 'SELECT revision FROM session_file_cache_metadata WHERE id = 1';
const ADVANCE_REVISION =
  'UPDATE session_file_cache_metadata SET revision = revision + 1 WHERE id = 1';

// The freshness key: a cached row is current while the session file and its
// settings sidecar have the same file identity and mtime/size as when it was
// summarized. Birth time distinguishes a replacement that happens to reuse
// the same path, size, and mtime.
function matchesFreshnessKey(cached: SessionFileCacheEntry, file: SessionFileStat): boolean {
  return (
    cached.path === file.path &&
    cached.birthtimeMs === file.birthtimeMs &&
    cached.mtimeMs === file.mtimeMs &&
    cached.sizeBytes === file.sizeBytes &&
    cached.settingsMtimeMs === file.settingsMtimeMs
  );
}

export class SessionFileCache {
  private readonly files = new Map<string, SessionFileCacheEntry>();
  private revisionValue = 0;

  constructor(
    private readonly db: DatabaseSync,
    private readonly scanFiles: () => SessionFileScan,
    private readonly summarizeFile: (
      providerSessionId: string,
      file: SessionFileStat,
    ) => SessionFileSummary,
    // Stats one session file and its settings sidecar; null when the file is
    // gone. Used by the targeted reconcile so watcher events do not trigger
    // a full sessions-tree walk.
    private readonly statFile: (path: string) => SessionFileStat | null,
  ) {
    initializeSessionFileCacheSchema(db);
    this.revisionValue = this.readRevision();
    this.loadRows();
  }

  get size(): number {
    return this.files.size;
  }

  get revision(): number {
    return this.revisionValue;
  }

  snapshot(changed = 0): SessionFileSnapshot {
    return {
      revision: this.revisionValue,
      changed,
      entries: [...this.files.values()].map(copySessionFileEntry),
    };
  }

  // Base summaries of every cached top-level session file, as of the last
  // reconcile. Callers apply the app_sessions patch overlay and filtering.
  summaries(): SessionSummary[] {
    const rows: SessionSummary[] = [];
    for (const entry of this.files.values()) {
      if (entry.summary) rows.push(entry.summary);
    }
    return rows;
  }

  // Path, stat, and base summary for every cached top-level session file, so
  // transcript content search can open the files without re-walking the
  // sessions tree. Callers apply the app_sessions patch overlay.
  searchableEntries(): SearchableSessionFileEntry[] {
    const rows: SearchableSessionFileEntry[] = [];
    for (const entry of this.files.values()) {
      if (entry.summary) {
        rows.push({
          providerSessionId: entry.providerSessionId,
          path: entry.path,
          birthtimeMs: entry.birthtimeMs,
          mtimeMs: entry.mtimeMs,
          sizeBytes: entry.sizeBytes,
          summary: entry.summary,
        });
      }
    }
    return rows;
  }

  pathIndex(): Map<string, string> {
    return new Map(
      [...this.files.values()].map((entry) => [entry.providerSessionId, entry.path] as const),
    );
  }

  // Diff cached session files against the files on disk, re-summarizing only
  // new or changed files and dropping deleted ones. A file that vanishes or
  // breaks mid-reconcile is skipped and retried on the next reconcile, so
  // one bad file cannot abort the whole diff. Returns the number of cache
  // entries written or removed.
  reconcileChanges(): SessionFileReconciliation {
    const previousRevision = this.revisionValue;
    const { files: onDisk, isComplete } = this.scanFiles();
    const removals = this.collectRemovals(onDisk, isComplete);
    const candidates = this.collectCandidates(onDisk);
    // Provider files that cannot be read are omitted from candidates and
    // retried on the next watcher event or full reconcile. Once candidates
    // are prepared, SQLite persistence is transactional and fail-fast.
    return this.persistReconciliation(previousRevision, candidates, removals);
  }

  applyReconciliation(result: SessionFileReconciliation): boolean {
    if (result.previousRevision !== this.revisionValue) return false;
    for (const providerSessionId of result.removedProviderSessionIds) {
      this.files.delete(providerSessionId);
    }
    for (const entry of result.upserts) {
      this.files.set(entry.providerSessionId, copySessionFileEntry(entry));
    }
    this.revisionValue = result.revision;
    return true;
  }

  replaceSnapshot(snapshot: SessionFileSnapshot): boolean {
    const changed = snapshot.revision !== this.revisionValue;
    this.files.clear();
    for (const entry of snapshot.entries) {
      this.files.set(entry.providerSessionId, copySessionFileEntry(entry));
    }
    this.revisionValue = snapshot.revision;
    return changed;
  }

  private collectRemovals(onDisk: Map<string, SessionFileStat>, isComplete: boolean): string[] {
    // A partial scan cannot distinguish a deleted file from a temporarily
    // unreadable subtree. Preserve unmatched rows until a complete scan can
    // authoritatively remove them.
    if (!isComplete) return [];
    return [...this.files.keys()].filter((id) => !onDisk.has(id));
  }

  private collectCandidates(onDisk: Map<string, SessionFileStat>): SessionFileCacheEntry[] {
    const candidates: SessionFileCacheEntry[] = [];
    for (const [id, file] of onDisk) {
      const cached = this.files.get(id);
      if (cached && matchesFreshnessKey(cached, file)) continue;
      try {
        const { summary, launchSettings } = this.summarizeFile(id, file);
        candidates.push({
          providerSessionId: id,
          ...file,
          summary,
          ...(launchSettings ? { launchSettings } : {}),
        });
      } catch {
        // The file was deleted or rotated between the scan and the read;
        // the next watcher event or boot reconcile retries it.
      }
    }
    return candidates;
  }

  // Reconcile exactly the session files a watcher event reported, so live
  // external changes cost a stat (and at most one re-parse) per changed file
  // instead of a walk of the whole sessions tree. A reported file that no
  // longer exists is dropped from the cache; a file that vanished or broke
  // mid-reconcile is skipped and retried on the next event. Returns the
  // number of cache entries written or removed.
  reconcilePathChanges(changes: SessionFileChange[]): SessionFileReconciliation {
    const previousRevision = this.revisionValue;
    const upserts: SessionFileCacheEntry[] = [];
    const removedProviderSessionIds: string[] = [];
    for (const { providerSessionId, path } of changes) {
      const file = this.statFile(path);
      if (!file) {
        if (this.files.has(providerSessionId)) {
          removedProviderSessionIds.push(providerSessionId);
        }
        continue;
      }
      const cached = this.files.get(providerSessionId);
      if (cached && matchesFreshnessKey(cached, file)) continue;
      try {
        const { summary, launchSettings } = this.summarizeFile(providerSessionId, file);
        upserts.push({
          providerSessionId,
          ...file,
          summary,
          ...(launchSettings ? { launchSettings } : {}),
        });
      } catch {
        // The file was deleted or rotated between the stat and the read;
        // the next watcher event or boot reconcile retries it.
      }
    }
    return this.persistReconciliation(previousRevision, upserts, removedProviderSessionIds);
  }

  private persistReconciliation(
    previousRevision: number,
    upserts: SessionFileCacheEntry[],
    removedProviderSessionIds: string[],
  ): SessionFileReconciliation {
    if (upserts.length === 0 && removedProviderSessionIds.length === 0) {
      return {
        previousRevision,
        revision: previousRevision,
        changed: 0,
        upserts: [],
        removedProviderSessionIds: [],
      };
    }

    const upsert = this.db.prepare(UPSERT_SESSION_FILE);
    const remove = this.db.prepare(REMOVE_SESSION_FILE);
    const persisted: SessionFileCacheEntry[] = [];
    this.db.exec('BEGIN');
    try {
      for (const providerSessionId of removedProviderSessionIds) remove.run(providerSessionId);
      for (const entry of upserts) {
        writeCacheEntry(upsert, entry);
        persisted.push(entry);
      }
      if (persisted.length + removedProviderSessionIds.length > 0) {
        this.db.exec(ADVANCE_REVISION);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      rollback(this.db);
      throw error;
    }

    const changed = persisted.length + removedProviderSessionIds.length;
    const result = {
      previousRevision,
      revision: changed > 0 ? previousRevision + 1 : previousRevision,
      changed,
      upserts: persisted,
      removedProviderSessionIds,
    };
    this.applyReconciliation(result);
    return result;
  }

  private readRevision(): number {
    const row = this.db.prepare(READ_REVISION).get() as { revision: unknown } | undefined;
    const revision = numberValue(row?.revision);
    return revision !== undefined && Number.isSafeInteger(revision) && revision >= 0 ? revision : 0;
  }

  private loadRows(): void {
    const rows = this.db
      .prepare(
        `SELECT provider_session_id, path, birthtime_ms, mtime_ms, size_bytes,
                settings_mtime_ms, summary_json, launch_settings_json
         FROM session_file_cache`,
      )
      .all() as StoredSessionFileRow[];
    const removeCorrupt = this.db.prepare(
      'DELETE FROM session_file_cache WHERE provider_session_id = ?',
    );
    const invalidIds: string[] = [];
    for (const record of rows) {
      const id = stringValue(record.provider_session_id);
      const path = stringValue(record.path);
      if (!id) continue;
      if (!path) {
        invalidIds.push(id);
        continue;
      }
      const summary = parseCachedSessionSummary(record.summary_json);
      const launchSettings = parseLaunchSettings(record.launch_settings_json);
      if (summary === undefined || launchSettings === null) {
        // An unparseable row is dropped so the next reconcile rebuilds it.
        invalidIds.push(id);
        continue;
      }
      this.files.set(id, {
        providerSessionId: id,
        path,
        birthtimeMs: numberValue(record.birthtime_ms) ?? 0,
        mtimeMs: numberValue(record.mtime_ms) ?? 0,
        sizeBytes: numberValue(record.size_bytes) ?? 0,
        settingsMtimeMs: numberValue(record.settings_mtime_ms) ?? null,
        summary,
        ...(launchSettings ? { launchSettings } : {}),
      });
    }
    if (invalidIds.length === 0) return;

    this.db.exec('BEGIN');
    try {
      for (const id of invalidIds) removeCorrupt.run(id);
      this.db.exec(ADVANCE_REVISION);
      this.db.exec('COMMIT');
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // Preserve the original SQLite failure.
      }
      throw error;
    }
    this.revisionValue += 1;
  }
}

function writeCacheEntry(statement: StatementSync, entry: SessionFileCacheEntry): void {
  statement.run(
    entry.providerSessionId,
    entry.path,
    entry.birthtimeMs,
    entry.mtimeMs,
    entry.sizeBytes,
    entry.settingsMtimeMs,
    serializeCachedSessionSummary(entry.summary),
    entry.launchSettings ? JSON.stringify(entry.launchSettings) : null,
  );
}

function parseLaunchSettings(raw: unknown): SessionFileLaunchSettings | null | undefined {
  if (raw === null) return undefined;
  const serialized = stringValue(raw);
  if (serialized === undefined) return null;
  try {
    const value = JSON.parse(serialized) as Record<string, unknown>;
    const modelId: unknown = Reflect.get(value, 'modelId');
    if (typeof modelId !== 'string' || modelId.length === 0) return null;
    const reasoningEffort: unknown = Reflect.get(value, 'reasoningEffort');
    if (reasoningEffort !== undefined && !isSessionFileReasoningEffort(reasoningEffort))
      return null;
    return {
      modelId,
      ...(reasoningEffort ? { reasoningEffort } : {}),
    };
  } catch {
    return null;
  }
}

function isSessionFileReasoningEffort(
  value: unknown,
): value is NonNullable<SessionFileLaunchSettings['reasoningEffort']> {
  return typeof value === 'string' && value in SESSION_FILE_REASONING_EFFORTS;
}

function rollback(db: DatabaseSync): void {
  try {
    db.exec('ROLLBACK');
  } catch {
    // Preserve the transaction failure.
  }
}
