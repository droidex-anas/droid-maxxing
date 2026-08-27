import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { createHistorySessionFileCache, SESSION_SEARCH_INDEX_FILENAME } from './history.js';
import { HistorySearchIndex } from './historySearchIndex.js';
import {
  HistorySearchUnavailableError,
  isHistorySearchUnavailableError,
} from './historySearchSchema.js';
import type {
  SearchableSessionFileEntry,
  SessionFileChange,
  SessionFileCacheEntry,
  SessionFileReconciliation,
  SessionFileSnapshot,
} from './sessionFileCache.js';
import type { SessionSearchResult } from './protocol.js';

const RECENT_HISTORY_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;
const RECENT_SLICE_DELAY_MS = 250;
const IDLE_BACKFILL_SLICE_DELAY_MS = 5_000;
const INDEX_RETRY_DELAY_MS = 1_000;
const MAX_INDEX_RETRY_DELAY_MS = 60_000;

interface HistoryIndexDatabaseOptions {
  now?: () => number;
  recentWindowMs?: number;
  recentSliceDelayMs?: number;
  idleBackfillSliceDelayMs?: number;
  schedule?: (
    callback: () => void | Promise<void>,
    delayMs: number,
  ) => ReturnType<typeof setTimeout>;
  cancel?: (timer: ReturnType<typeof setTimeout>) => void;
}

export class HistoryIndexDatabase {
  private readonly canonicalDb: DatabaseSync;
  private readonly derivedDb: DatabaseSync;
  private readonly sessionFiles;
  private readonly searchIndex: HistorySearchIndex | null;
  private readonly searchUnavailable: HistorySearchUnavailableError | null;
  private readonly now: () => number;
  private readonly recentWindowMs: number;
  private readonly recentSliceDelayMs: number;
  private readonly idleBackfillSliceDelayMs: number;
  private readonly schedule: NonNullable<HistoryIndexDatabaseOptions['schedule']>;
  private readonly cancel: NonNullable<HistoryIndexDatabaseOptions['cancel']>;
  private readonly recentQueue = new Map<string, SearchableSessionFileEntry>();
  private readonly backfillQueue = new Map<string, SearchableSessionFileEntry>();
  private indexingTimer: ReturnType<typeof setTimeout> | null = null;
  private activeSlice: Promise<void> | null = null;
  private activeQueueEntry: {
    providerSessionId: string;
    entry: SearchableSessionFileEntry;
    queue: Map<string, SearchableSessionFileEntry>;
    isBackfill: boolean;
    superseded: boolean;
  } | null = null;
  private readonly retryFailures = new Map<string, number>();
  private readonly retryNotBefore = new Map<string, number>();
  private hasPlannedAll = false;
  private isIdle = false;
  private closed = false;

  constructor(dbPath: string, options: HistoryIndexDatabaseOptions = {}) {
    this.canonicalDb = new DatabaseSync(dbPath, { readOnly: true });
    let derived: ReturnType<typeof openDerivedStorage>;
    try {
      const derivedPath = join(dirname(dbPath), SESSION_SEARCH_INDEX_FILENAME);
      derived = openDerivedStorage(derivedPath, this.canonicalDb);
    } catch (error) {
      this.canonicalDb.close();
      throw error;
    }
    this.derivedDb = derived.db;
    this.sessionFiles = derived.sessionFiles;
    this.searchIndex = derived.searchIndex;
    this.searchUnavailable = derived.searchUnavailable;
    this.now = options.now ?? Date.now;
    this.recentWindowMs = options.recentWindowMs ?? RECENT_HISTORY_WINDOW_MS;
    this.recentSliceDelayMs = options.recentSliceDelayMs ?? RECENT_SLICE_DELAY_MS;
    this.idleBackfillSliceDelayMs =
      options.idleBackfillSliceDelayMs ?? IDLE_BACKFILL_SLICE_DELAY_MS;
    this.schedule = options.schedule ?? scheduleTimer;
    this.cancel = options.cancel ?? clearTimeout;
  }

  reconcileSessionFiles(): SessionFileReconciliation {
    this.assertOpen();
    const result = this.sessionFiles.reconcileChanges();
    const removed = [
      ...result.removedProviderSessionIds,
      ...result.upserts
        .filter((entry) => entry.summary === null)
        .map((entry) => entry.providerSessionId),
    ];
    for (const providerSessionId of removed) this.removeQueued(providerSessionId);
    const searchIndex = this.searchIndex;
    if (!searchIndex) return result;
    const plan = searchIndex.reconcileEntries(this.sessionFiles.searchableEntries());
    this.hasPlannedAll = true;
    this.enqueueEntries(plan.pendingEntries, false);
    return result;
  }

  reconcileSessionFilePaths(changes: SessionFileChange[]): SessionFileReconciliation {
    this.assertOpen();
    const result = this.sessionFiles.reconcilePathChanges(changes);
    const searchIndex = this.searchIndex;
    if (!searchIndex) return result;
    if (!this.hasPlannedAll) {
      const plan = searchIndex.reconcileEntries(this.sessionFiles.searchableEntries());
      this.hasPlannedAll = true;
      this.enqueueEntries(plan.pendingEntries, false);
      return result;
    }
    const searchable = result.upserts.filter(isSearchableEntry);
    const removed = [
      ...result.removedProviderSessionIds,
      ...result.upserts
        .filter((entry) => entry.summary === null)
        .map((entry) => entry.providerSessionId),
    ];
    const plan = searchIndex.applyEntryChanges(searchable, removed);
    for (const providerSessionId of removed) this.removeQueued(providerSessionId);
    this.enqueueEntries(plan.pendingEntries, true);
    return result;
  }

  sessionFileSnapshot(): SessionFileSnapshot {
    this.assertOpen();
    return this.sessionFiles.snapshot();
  }

  search(query: string, isStale?: () => boolean): SessionSearchResult[] {
    this.assertOpen();
    if (this.searchUnavailable) throw this.searchUnavailable;
    this.ensurePlannedAll();
    this.pauseActiveBackfill();
    const results = isStale?.() ? [] : this.requireSearchIndex().search(query, isStale);
    this.scheduleNext();
    return results;
  }

  setIdle(isIdle: boolean): void {
    this.assertOpen();
    this.isIdle = isIdle;
    if (this.searchUnavailable) return;
    if (isIdle) this.ensurePlannedAll();
    else this.pauseActiveBackfill();
    if (this.indexingTimer && this.recentQueue.size === 0) this.cancelScheduledSlice();
    this.scheduleNext();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.indexingTimer) {
      this.cancel(this.indexingTimer);
      this.indexingTimer = null;
    }
    let firstError: unknown;
    try {
      if (this.activeSlice) await this.activeSlice;
    } catch (error) {
      firstError = error;
    }
    try {
      this.derivedDb.close();
    } catch (error) {
      firstError ??= error;
    }
    try {
      this.canonicalDb.close();
    } catch (error) {
      firstError ??= error;
    }
    if (firstError !== undefined) {
      throw firstError instanceof Error
        ? firstError
        : new Error('History index shutdown failed.', { cause: firstError });
    }
  }

  private ensurePlannedAll(): void {
    if (this.hasPlannedAll || this.searchUnavailable) return;
    const plan = this.requireSearchIndex().reconcileEntries(this.sessionFiles.searchableEntries());
    this.hasPlannedAll = true;
    this.enqueueEntries(plan.pendingEntries, false);
  }

  private enqueueEntries(entries: SearchableSessionFileEntry[], forceRecent: boolean): void {
    const recentCutoff = this.now() - this.recentWindowMs;
    const ordered = [...entries].sort(
      (left, right) => right.summary.updatedAt - left.summary.updatedAt,
    );
    for (const entry of ordered) {
      this.removeQueued(entry.providerSessionId);
      const isRecent = forceRecent || entry.summary.updatedAt >= recentCutoff;
      (isRecent ? this.recentQueue : this.backfillQueue).set(entry.providerSessionId, entry);
    }
    this.cancelScheduledSlice();
    this.scheduleNext();
  }

  private removeQueued(providerSessionId: string): void {
    this.recentQueue.delete(providerSessionId);
    this.backfillQueue.delete(providerSessionId);
    this.retryFailures.delete(providerSessionId);
    this.retryNotBefore.delete(providerSessionId);
    if (this.activeQueueEntry?.providerSessionId === providerSessionId) {
      this.activeQueueEntry.superseded = true;
    }
  }

  private scheduleNext(): void {
    if (this.closed || this.indexingTimer || this.activeSlice) return;
    const now = this.now();
    const recentDueAt = this.queueDueAt(this.recentQueue, this.recentSliceDelayMs, now);
    const backfillDueAt = this.isIdle
      ? this.queueDueAt(this.backfillQueue, this.idleBackfillSliceDelayMs, now)
      : undefined;
    const dueAt = minimumDefined(recentDueAt, backfillDueAt);
    if (dueAt === undefined) return;
    const delayMs = Math.max(0, dueAt - now);
    this.indexingTimer = this.schedule(() => {
      this.indexingTimer = null;
      return this.runScheduledSlice();
    }, delayMs);
  }

  private cancelScheduledSlice(): void {
    if (!this.indexingTimer) return;
    this.cancel(this.indexingTimer);
    this.indexingTimer = null;
  }

  private async runScheduledSlice(): Promise<void> {
    try {
      await this.runOneSlice();
    } catch (error) {
      console.error('History search indexing slice failed:', error);
    } finally {
      this.scheduleNext();
    }
  }

  private async runOneSlice(): Promise<void> {
    if (this.activeSlice) {
      await this.activeSlice;
      return;
    }
    const now = this.now();
    let queue: Map<string, SearchableSessionFileEntry> | null = this.hasEligibleEntry(
      this.recentQueue,
      now,
    )
      ? this.recentQueue
      : null;
    if (!queue && this.isIdle && this.hasEligibleEntry(this.backfillQueue, now)) {
      queue = this.backfillQueue;
    }
    if (!queue) return;
    const next = this.firstEligibleEntry(queue, now);
    if (!next) return;
    const [providerSessionId, entry] = next;
    queue.delete(providerSessionId);
    const activeQueueEntry = {
      providerSessionId,
      entry,
      queue,
      isBackfill: queue === this.backfillQueue,
      superseded: false,
    };
    this.activeQueueEntry = activeQueueEntry;
    const operation = this.indexEntrySlice(queue, entry, activeQueueEntry);
    this.activeSlice = operation;
    try {
      await operation;
    } finally {
      if (this.activeSlice === operation) this.activeSlice = null;
      if (this.activeQueueEntry === activeQueueEntry) this.activeQueueEntry = null;
    }
  }

  private async indexEntrySlice(
    queue: Map<string, SearchableSessionFileEntry>,
    entry: SearchableSessionFileEntry,
    activeQueueEntry: { providerSessionId: string; superseded: boolean },
  ): Promise<void> {
    try {
      const result = await this.requireSearchIndex().indexSlice(
        entry,
        () => this.closed || activeQueueEntry.superseded,
      );
      if (this.closed || activeQueueEntry.superseded) return;
      this.retryFailures.delete(entry.providerSessionId);
      this.retryNotBefore.delete(entry.providerSessionId);
      if (!result.complete && result.indexedBytes > 0) {
        queue.set(entry.providerSessionId, entry);
      }
    } catch (error) {
      if (this.closed || activeQueueEntry.superseded) return;
      queue.set(entry.providerSessionId, entry);
      const failures = (this.retryFailures.get(entry.providerSessionId) ?? 0) + 1;
      this.retryFailures.set(entry.providerSessionId, failures);
      const retryDelayMs = Math.min(
        INDEX_RETRY_DELAY_MS * 2 ** Math.min(failures - 1, 6),
        MAX_INDEX_RETRY_DELAY_MS,
      );
      this.retryNotBefore.set(entry.providerSessionId, this.now() + retryDelayMs);
      throw error;
    }
  }

  private queueDueAt(
    queue: Map<string, SearchableSessionFileEntry>,
    laneDelayMs: number,
    now: number,
  ): number | undefined {
    if (queue.size === 0) return undefined;
    let earliestRetry: number | undefined;
    for (const providerSessionId of queue.keys()) {
      const retryAt = this.retryNotBefore.get(providerSessionId) ?? 0;
      if (retryAt <= now) return now + laneDelayMs;
      earliestRetry = earliestRetry === undefined ? retryAt : Math.min(earliestRetry, retryAt);
    }
    return earliestRetry;
  }

  private hasEligibleEntry(queue: Map<string, SearchableSessionFileEntry>, now: number): boolean {
    return this.firstEligibleEntry(queue, now) !== undefined;
  }

  private firstEligibleEntry(
    queue: Map<string, SearchableSessionFileEntry>,
    now: number,
  ): [string, SearchableSessionFileEntry] | undefined {
    for (const entry of queue) {
      if ((this.retryNotBefore.get(entry[0]) ?? 0) <= now) return entry;
    }
    return undefined;
  }

  private pauseActiveBackfill(): void {
    const active = this.activeQueueEntry;
    if (!active?.isBackfill || active.superseded) return;
    active.superseded = true;
    active.queue.set(active.providerSessionId, active.entry);
  }

  private requireSearchIndex(): HistorySearchIndex {
    if (this.searchIndex) return this.searchIndex;
    throw this.searchUnavailable ?? new HistorySearchUnavailableError();
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('History index database is closed.');
  }
}

function isSearchableEntry(
  entry: SessionFileCacheEntry,
): entry is SessionFileCacheEntry & { summary: NonNullable<SessionFileCacheEntry['summary']> } {
  return entry.summary !== null;
}

function scheduleTimer(
  callback: () => void | Promise<void>,
  delayMs: number,
): ReturnType<typeof setTimeout> {
  const timer = setTimeout(() => void callback(), delayMs);
  timer.unref();
  return timer;
}

function minimumDefined(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.min(left, right);
}

function openDerivedStorage(path: string, canonicalDb: DatabaseSync) {
  try {
    return createDerivedStorage(path, canonicalDb);
  } catch (error) {
    // Missing FTS5 is a host capability gap, not a corrupt derived file.
    if (isHistorySearchUnavailableError(error) || !isDatabaseCorruption(error)) throw error;
    removeDerivedStorage(path);
    try {
      return createDerivedStorage(path, canonicalDb);
    } catch (rebuildError) {
      throw new Error(
        `History search index is corrupt and could not be rebuilt. Quit DROIDEX, delete ${path} ` +
          `and its -wal/-shm files, then restart. Raw session history is unaffected.`,
        { cause: rebuildError },
      );
    }
  }
}

function createDerivedStorage(path: string, canonicalDb: DatabaseSync) {
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 5000');
    const sessionFiles = createHistorySessionFileCache(db);
    try {
      return {
        db,
        sessionFiles,
        searchIndex: new HistorySearchIndex(db, canonicalDb),
        searchUnavailable: null,
      };
    } catch (error) {
      if (!isHistorySearchUnavailableError(error)) throw error;
      return {
        db,
        sessionFiles,
        searchIndex: null,
        searchUnavailable: new HistorySearchUnavailableError(),
      };
    }
  } catch (error) {
    try {
      db.close();
    } catch {
      // Preserve the initialization failure.
    }
    throw error;
  }
}

function removeDerivedStorage(path: string): void {
  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
    rmSync(candidate, { force: true });
  }
}

function isDatabaseCorruption(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const rawCode: unknown = Reflect.get(error, 'code');
  const code = typeof rawCode === 'string' ? rawCode.toLowerCase() : '';
  const message = error.message.toLowerCase();
  return (
    code.includes('corrupt') ||
    code.includes('notadb') ||
    message.includes('database disk image is malformed') ||
    message.includes('file is not a database')
  );
}
