import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  HistoryIndex,
  SESSION_INDEX_FILENAME,
  applyCachedSummary,
  type FactoryDefaults,
  type HistoricalSession,
  type HistoricalSummaryFilter,
  type PersistedChildSession,
} from './history.js';
import { HistoryDurabilityPolicy } from './HistoryDurabilityPolicy.js';
import { HistoryPersistenceQueue } from './HistoryPersistenceQueue.js';
import {
  HistoryWorkerClient,
  type HistoryPersistenceClient,
  type HistorySearchClient,
} from './HistoryWorkerClient.js';
import type { HistoryPersistenceBatch } from './historyPersistenceProtocol.js';
import {
  copyPersistenceChild,
  copyPersistenceSummary,
  persistenceChildKey,
  persistenceChildKeyPrefix,
} from './historyPersistenceQueueValues.js';
import { isHistorySearchUnavailableError } from './historySearchSchema.js';
import type { SessionSearchResult, SessionSummary, TranscriptEvent } from './protocol.js';
import type { SessionFileChange, SessionFileReconciliation } from './sessionFileCache.js';
import { hotPathMetrics } from './telemetry/hotPathMetrics.js';

export interface HistoryPersistenceOptions {
  persistenceClient?: HistoryPersistenceClient;
  searchClient?: HistorySearchClient;
  createSearchClient?: () => HistorySearchClient;
  onStatusChanged?: (status: HistoryPersistenceStatus) => void;
  onDurabilityRecovered?: () => void;
}

export type HistoryPersistenceStatus =
  | { state: 'healthy' }
  | { state: 'degraded'; message: string }
  | { state: 'search_unavailable'; message: string };

/**
 * Worker-backed write seam around the existing read/index implementation.
 *
 * HistoryIndex remains the schema and read owner. This class owns live
 * canonical overlays plus the bounded write-behind queue. Ordinary transcript
 * output remains live while SQLite work runs away from the orchestration event
 * loop; settlement and identity publication waits for confirmed durability.
 */
export class HistoryPersistence {
  private readonly core: HistoryIndex;
  private readonly queue: HistoryPersistenceQueue;
  private searchClient: HistorySearchClient | null;
  private readonly createSearchClient: () => HistorySearchClient;
  private readonly onStatusChanged: HistoryPersistenceOptions['onStatusChanged'];
  private readonly runtimeSummaries = new Map<string, SessionSummary>();
  private readonly runtimeChildren = new Map<string, PersistedChildSession>();
  private readonly durability = new HistoryDurabilityPolicy();
  private historyRevision = 0;
  private lastFailureLogAt = 0;
  private indexingIdle = false;
  private searchUnavailable: Error | null = null;
  private searchUnavailableReported = false;

  constructor(options: HistoryPersistenceOptions = {}) {
    if (options.searchClient && options.createSearchClient) {
      throw new Error('Provide either a history search client or a search client factory.');
    }
    this.core = new HistoryIndex();
    const dbPath = join(homedir(), '.factory', 'droidex', SESSION_INDEX_FILENAME);
    this.searchClient = options.searchClient ?? null;
    this.createSearchClient =
      options.createSearchClient ??
      (() => new HistoryWorkerClient({ workerData: { dbPath, lane: 'search' } }));
    this.onStatusChanged = options.onStatusChanged;
    this.queue = new HistoryPersistenceQueue({
      dbPath,
      ...(options.persistenceClient ? { client: options.persistenceClient } : {}),
      onCommitted: (batch, result) => {
        try {
          if (result.initializationMs !== undefined) {
            hotPathMetrics.recordPersistenceStartup(result.initializationMs);
          }
          hotPathMetrics.recordPersist(
            result.durationMs,
            result.eventsWritten + result.summariesWritten + result.childrenWritten,
          );
        } catch (error) {
          console.error('History persistence metrics failed:', error);
        }
        this.noteCommitted(batch);
      },
      onFailure: (error) => {
        hotPathMetrics.recordPersistenceFailure();
        options.onStatusChanged?.({ state: 'degraded', message: error.message });
        const now = Date.now();
        if (now - this.lastFailureLogAt < 5_000) return;
        this.lastFailureLogAt = now;
        console.error(`History persistence worker failed: ${error.message}`);
      },
      onRecovered: () => {
        if (this.durability.isBlocked) {
          try {
            // New writes can arrive after the retrying checkpoint was posted.
            // Drain and checkpoint once more before releasing held owner state.
            this.measurePersistenceBoundary(() => {
              this.queue.flushSync();
            });
            this.durability.noteDurable();
          } catch {
            return;
          }
        }
        hotPathMetrics.recordPersistenceRecovery();
        options.onStatusChanged?.({ state: 'healthy' });
        queueMicrotask(() => options.onDurabilityRecovered?.());
      },
    });
  }

  get sessionFileCacheSize(): number {
    return this.core.sessionFileCacheSize;
  }

  get revision(): number {
    return this.historyRevision;
  }

  sessionLaunchSettings(
    providerSessionId: string,
  ): Pick<FactoryDefaults, 'modelId' | 'reasoningEffort'> | undefined {
    return this.core.sessionLaunchSettings(providerSessionId);
  }

  listHistoricalSessions(options: HistoricalSummaryFilter = {}): HistoricalSession[] {
    const patches = new Map<string, Partial<SessionSummary>>();
    const hidden = new Set<string>();
    overlayRuntimeSummaries(this.runtimeSummaries.values(), patches, hidden);
    return this.core
      .listHistoricalSessions(options)
      .map((historical) => ({
        ...historical,
        summary: applyCachedSummary(historical.summary, patches),
      }))
      .filter((historical) => {
        const providerSessionId =
          historical.summary.providerSessionId ?? historical.summary.appSessionId;
        return !hidden.has(providerSessionId);
      });
  }

  async searchSessions(query: string, isStale?: () => boolean): Promise<SessionSearchResult[]> {
    this.pauseBackgroundIndexing();
    if (isStale?.()) return [];
    const runtimeAliases = searchAliases(this.runtimeSummaries.values());
    const results = await this.withSearchClient((client) => client.search(query));
    if (isStale?.()) return [];
    for (const [providerSessionId, appSessionId] of searchAliases(this.runtimeSummaries.values())) {
      runtimeAliases.set(providerSessionId, appSessionId);
    }
    return applySearchAliases(results, runtimeAliases);
  }

  async setIndexingIdle(isIdle: boolean): Promise<void> {
    this.indexingIdle = isIdle && !this.hasActiveIndexingWork();
    if (!this.searchClient || this.searchUnavailable) return;
    try {
      await this.searchClient.setIndexingIdle(this.indexingIdle);
    } catch (error) {
      if (!isHistorySearchUnavailableError(error)) throw error;
      this.noteSearchUnavailable(asError(error));
    }
  }

  async reconcileSessionFiles(): Promise<number> {
    await this.queue.drain();
    return await this.applySearchReconciliation(
      await this.getSearchClient().reconcileSessionFiles(),
    );
  }

  async reconcileSessionFilePaths(changes: SessionFileChange[]): Promise<number> {
    await this.queue.drain();
    return await this.applySearchReconciliation(
      await this.getSearchClient().reconcileSessionFilePaths(changes),
    );
  }

  syncSummaries(summaries: SessionSummary[]): boolean {
    if (summaries.some((summary) => summary.streaming)) this.pauseBackgroundIndexing();
    const copies = this.queue.enqueueSummaries(summaries);
    for (const summary of copies) {
      this.runtimeSummaries.set(summary.appSessionId, summary);
    }
    const decision = this.durability.acceptSummaries(copies);
    if (this.durability.isBlocked) return !decision.holdWhileBlocked;
    return decision.needsDurability ? this.requestDurability() : true;
  }

  summaryPatchesAndHidden(): {
    patches: Map<string, Partial<SessionSummary>>;
    hiddenProviderSessionIds: Set<string>;
  } {
    const { patches, hiddenProviderSessionIds } = this.core.summaryPatchesAndHidden();
    overlayRuntimeSummaries(this.runtimeSummaries.values(), patches, hiddenProviderSessionIds);
    return { patches, hiddenProviderSessionIds };
  }

  recordEvent(event: TranscriptEvent): void {
    this.pauseBackgroundIndexing();
    this.queue.enqueueEvent(event);
    if (event.kind === 'compaction' && !this.durability.isBlocked) this.requestDurability();
  }

  upsertChildSession(child: PersistedChildSession): boolean {
    if (child.status === 'pending' || child.status === 'running') this.pauseBackgroundIndexing();
    const key = persistenceChildKey(child.parentAppSessionId, child.childSessionId);
    const copy = this.queue.enqueueChild(child);
    const decision = this.durability.acceptChild(copy);
    this.runtimeChildren.set(key, copy);
    if (this.durability.isBlocked) return !decision.holdWhileBlocked;
    return decision.needsDurability ? this.requestDurability() : true;
  }

  childSessions(parentAppSessionId: string): PersistedChildSession[] {
    const persisted = this.core.childSessions(parentAppSessionId);
    this.durability.observeChildren(persisted);
    const merged = new Map(persisted.map((child) => [child.childSessionId, child] as const));
    for (const child of this.runtimeChildren.values()) {
      if (child.parentAppSessionId === parentAppSessionId) {
        merged.set(child.childSessionId, copyPersistenceChild(child));
      }
    }
    return [...merged.values()].sort(
      (left, right) =>
        left.updatedAt - right.updatedAt || left.childSessionId.localeCompare(right.childSessionId),
    );
  }

  childSession(
    parentAppSessionId: string,
    childSessionId: string,
  ): PersistedChildSession | undefined {
    const live = this.runtimeChildren.get(persistenceChildKey(parentAppSessionId, childSessionId));
    if (live) return copyPersistenceChild(live);
    const persisted = this.core.childSession(parentAppSessionId, childSessionId);
    if (persisted) this.durability.observeChildren([persisted]);
    return persisted;
  }

  flushSync(): void {
    this.flushPendingSync();
  }

  forgetSession(appSessionId: string): void {
    this.runtimeSummaries.delete(appSessionId);
    this.durability.forgetSession(appSessionId);
    const childPrefix = persistenceChildKeyPrefix(appSessionId);
    for (const key of this.runtimeChildren.keys()) {
      if (key.startsWith(childPrefix)) this.runtimeChildren.delete(key);
    }
  }

  close(): void {
    let persistenceError: Error | undefined;
    try {
      this.queue.close();
    } catch (error) {
      persistenceError = asError(error);
    } finally {
      try {
        this.searchClient?.closeSync();
      } catch (error) {
        persistenceError ??= asError(error);
      } finally {
        this.core.close();
      }
    }
    if (persistenceError) throw persistenceError;
  }

  private noteCommitted(batch: HistoryPersistenceBatch): void {
    for (const summary of batch.summaries) {
      if (this.runtimeSummaries.get(summary.appSessionId) === summary) {
        this.runtimeSummaries.delete(summary.appSessionId);
      }
    }
    for (const child of batch.children) {
      const key = persistenceChildKey(child.parentAppSessionId, child.childSessionId);
      if (this.runtimeChildren.get(key) === child) this.runtimeChildren.delete(key);
    }
  }

  private getSearchClient(): HistorySearchClient {
    if (!this.searchClient) {
      this.searchClient = this.createSearchClient();
      if (this.indexingIdle) {
        void this.searchClient.setIndexingIdle(true).catch((error: unknown) => {
          console.error(`Could not start idle history search indexing: ${asError(error).message}`);
        });
      }
    }
    return this.searchClient;
  }

  private async withSearchClient<T>(
    operation: (client: HistorySearchClient) => Promise<T>,
  ): Promise<T> {
    if (this.searchUnavailable) throw this.searchUnavailable;
    try {
      return await operation(this.getSearchClient());
    } catch (error) {
      if (!isHistorySearchUnavailableError(error)) throw error;
      const unavailable = asError(error);
      this.noteSearchUnavailable(unavailable);
      throw unavailable;
    }
  }

  private async applySearchReconciliation(result: SessionFileReconciliation): Promise<number> {
    let changed = result.changed;
    if (!this.core.applySessionFileReconciliation(result)) {
      const snapshot = await this.getSearchClient().sessionFileSnapshot();
      if (this.core.replaceSessionFileSnapshot(snapshot)) changed = Math.max(1, changed);
    }
    if (changed > 0) {
      this.historyRevision += 1;
    }
    return changed;
  }

  private noteSearchUnavailable(error: Error): void {
    this.searchUnavailable = error;
    if (this.searchUnavailableReported) return;
    this.searchUnavailableReported = true;
    try {
      this.onStatusChanged?.({ state: 'search_unavailable', message: error.message });
    } catch (reportError) {
      console.error('History search unavailability reporting failed:', reportError);
    }
  }

  private pauseBackgroundIndexing(): void {
    if (!this.indexingIdle) return;
    this.indexingIdle = false;
    if (this.searchClient) {
      void this.searchClient.setIndexingIdle(false).catch((error: unknown) => {
        console.error(`Could not pause history search indexing: ${asError(error).message}`);
      });
    }
  }

  private hasActiveIndexingWork(): boolean {
    return this.durability.hasActiveWork();
  }

  private flushPendingSync(): void {
    this.measurePersistenceBoundary(() => {
      this.queue.flushSync();
    });
    this.durability.noteDurable();
  }

  private requestDurability(): boolean {
    try {
      this.flushPendingSync();
      return true;
    } catch {
      // The bounded queue retained the accepted state and owns backoff. Its
      // owner holds renderer publication until the confirmed recovery callback.
      this.durability.noteFailure();
      return false;
    }
  }

  private measurePersistenceBoundary(operation: () => void): void {
    const startedAt = performance.now();
    try {
      operation();
    } finally {
      hotPathMetrics.recordPersistenceBoundary(performance.now() - startedAt);
    }
  }
}

function searchAliases(summaries: Iterable<SessionSummary>): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const summary of summaries) {
    aliases.set(summary.appSessionId, summary.appSessionId);
    if (summary.providerSessionId) {
      aliases.set(summary.providerSessionId, summary.appSessionId);
    }
    for (const providerSessionId of summary.compactedFromProviderSessionIds ?? []) {
      aliases.set(providerSessionId, summary.appSessionId);
    }
  }
  return aliases;
}

function applySearchAliases(
  results: SessionSearchResult[],
  aliases: ReadonlyMap<string, string>,
): SessionSearchResult[] {
  if (aliases.size === 0) return results;
  const merged = new Map<string, SessionSearchResult['matches']>();
  for (const result of results) {
    const appSessionId = aliases.get(result.appSessionId) ?? result.appSessionId;
    const matches = merged.get(appSessionId) ?? [];
    matches.push(...result.matches);
    merged.set(appSessionId, matches);
  }
  return [...merged].map(([appSessionId, matches]) => ({
    appSessionId,
    matches: matches.sort((left, right) => right.ts - left.ts).slice(0, 3),
  }));
}

function overlayRuntimeSummaries(
  summaries: Iterable<SessionSummary>,
  patches: Map<string, Partial<SessionSummary>>,
  hiddenProviderSessionIds: Set<string>,
): void {
  for (const summary of summaries) {
    const copy = copyPersistenceSummary(summary);
    patches.set(copy.appSessionId, copy);
    patches.set(copy.providerSessionId ?? copy.appSessionId, copy);
    for (const providerSessionId of copy.compactedFromProviderSessionIds ?? []) {
      patches.set(providerSessionId, copy);
      if (providerSessionId !== copy.appSessionId) hiddenProviderSessionIds.add(providerSessionId);
    }
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
