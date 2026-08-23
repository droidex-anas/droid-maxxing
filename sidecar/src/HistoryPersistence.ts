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
import { HistoryPersistenceQueue } from './HistoryPersistenceQueue.js';
import type { HistoryPersistenceBatch } from './historyPersistenceProtocol.js';
import type { SessionSearchResult, SessionSummary, TranscriptEvent } from './protocol.js';
import { hotPathMetrics } from './telemetry/hotPathMetrics.js';

interface SummaryDurabilityState {
  phase: SessionSummary['phase'];
  streaming: boolean;
  providerSessionId?: string;
  compactedProviderSessionIds: string;
}

interface ChildDurabilityState {
  status: PersistedChildSession['status'];
  providerSessionId?: string;
  previousProviderSessionIds: string;
}

/**
 * Worker-backed write seam around the existing read/index implementation.
 *
 * HistoryIndex remains the schema and read owner. This class owns live
 * canonical overlays plus the bounded write-behind queue, so renderer-visible
 * state updates immediately while SQLite work runs away from the orchestration
 * event loop.
 */
export class HistoryPersistence {
  private readonly core: HistoryIndex;
  private readonly queue: HistoryPersistenceQueue;
  private readonly runtimeSummaries = new Map<string, SessionSummary>();
  private readonly runtimeChildren = new Map<string, PersistedChildSession>();
  private readonly summaryDurability = new Map<string, SummaryDurabilityState>();
  private readonly childDurability = new Map<string, ChildDurabilityState>();
  private readonly summariesAwaitingDurability = new Set<string>();
  private readonly childrenAwaitingDurability = new Set<string>();
  private historyRevision = 0;
  private lastFailureLogAt = 0;

  constructor() {
    this.core = new HistoryIndex();
    const dbPath = join(homedir(), '.factory', 'droidex', SESSION_INDEX_FILENAME);
    this.queue = new HistoryPersistenceQueue({
      dbPath,
      onCommitted: (batch, result) => {
        try {
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
        const now = Date.now();
        if (now - this.lastFailureLogAt < 5_000) return;
        this.lastFailureLogAt = now;
        console.error(`History persistence worker failed: ${error.message}`);
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
    if (isStale?.()) return [];
    const results = await this.queue.search(query, this.core.searchCandidates());
    this.clearDurabilityRequirements();
    return isStale?.() ? [] : results;
  }

  reconcileSessionFiles(): number {
    this.flushPendingSync();
    const changed = this.core.reconcileSessionFiles();
    if (changed > 0) {
      this.historyRevision += 1;
      this.queue.invalidateSearch();
    }
    return changed;
  }

  reconcileSessionFilePaths(changes: { providerSessionId: string; path: string }[]): number {
    this.flushPendingSync();
    const changed = this.core.reconcileSessionFilePaths(changes);
    if (changed > 0) {
      this.historyRevision += 1;
      this.queue.invalidateSearch();
    }
    return changed;
  }

  syncSummaries(summaries: SessionSummary[]): void {
    const copies = this.queue.enqueueSummaries(summaries);
    let durable = false;
    for (const summary of copies) {
      const needsDurability =
        this.summariesAwaitingDurability.has(summary.appSessionId) ||
        summaryNeedsDurability(this.summaryDurability.get(summary.appSessionId), summary);
      if (needsDurability) this.summariesAwaitingDurability.add(summary.appSessionId);
      durable ||= needsDurability;
      this.summaryDurability.set(summary.appSessionId, summaryDurabilityState(summary));
      this.runtimeSummaries.set(summary.appSessionId, summary);
    }
    if (durable) this.flushPendingSync();
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
    this.queue.enqueueEvent(event);
    if (event.kind === 'compaction') this.flushPendingSync();
  }

  upsertChildSession(child: PersistedChildSession): void {
    const key = childIdentityKey(child.parentAppSessionId, child.childSessionId);
    const copy = this.queue.enqueueChild(child);
    const durable =
      this.childrenAwaitingDurability.has(key) ||
      childNeedsDurability(this.childDurability.get(key), copy);
    if (durable) this.childrenAwaitingDurability.add(key);
    this.childDurability.set(key, childDurabilityState(copy));
    this.runtimeChildren.set(key, copy);
    if (durable) this.flushPendingSync();
  }

  childSessions(parentAppSessionId: string): PersistedChildSession[] {
    const merged = new Map(
      this.core
        .childSessions(parentAppSessionId)
        .map((child) => [child.childSessionId, child] as const),
    );
    for (const child of this.runtimeChildren.values()) {
      if (child.parentAppSessionId === parentAppSessionId) {
        merged.set(child.childSessionId, copyChild(child));
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
    const live = this.runtimeChildren.get(childIdentityKey(parentAppSessionId, childSessionId));
    return live ? copyChild(live) : this.core.childSession(parentAppSessionId, childSessionId);
  }

  flushSync(): void {
    this.flushPendingSync();
  }

  close(): void {
    let persistenceError: Error | undefined;
    try {
      this.queue.close();
    } catch (error) {
      persistenceError = asError(error);
    } finally {
      this.core.close();
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
      const key = childIdentityKey(child.parentAppSessionId, child.childSessionId);
      if (this.runtimeChildren.get(key) === child) this.runtimeChildren.delete(key);
    }
  }

  private flushPendingSync(): void {
    this.queue.flushSync();
    this.clearDurabilityRequirements();
  }

  private clearDurabilityRequirements(): void {
    this.summariesAwaitingDurability.clear();
    this.childrenAwaitingDurability.clear();
  }
}

function summaryNeedsDurability(
  previous: SummaryDurabilityState | undefined,
  summary: SessionSummary,
): boolean {
  const next = summaryDurabilityState(summary);
  if (previous === undefined) return true;
  if (next.streaming) return false;
  const terminal = next.phase === 'paused' || next.phase === 'completed' || next.phase === 'failed';
  const turnSettled = previous.streaming;
  const durableIdentityChanged =
    previous.providerSessionId !== next.providerSessionId ||
    previous.compactedProviderSessionIds !== next.compactedProviderSessionIds;
  return turnSettled || durableIdentityChanged || (terminal && previous.phase !== next.phase);
}

function summaryDurabilityState(summary: SessionSummary): SummaryDurabilityState {
  return {
    phase: summary.phase,
    streaming: summary.streaming === true,
    ...(summary.providerSessionId ? { providerSessionId: summary.providerSessionId } : {}),
    compactedProviderSessionIds: JSON.stringify(summary.compactedFromProviderSessionIds ?? []),
  };
}

function childNeedsDurability(
  previous: ChildDurabilityState | undefined,
  child: PersistedChildSession,
): boolean {
  const next = childDurabilityState(child);
  const identityChanged =
    previous !== undefined &&
    (previous.providerSessionId !== next.providerSessionId ||
      previous.previousProviderSessionIds !== next.previousProviderSessionIds);
  if (identityChanged) return true;
  if (next.status !== 'paused' && next.status !== 'completed') return false;
  return previous?.status !== next.status;
}

function childDurabilityState(child: PersistedChildSession): ChildDurabilityState {
  return {
    status: child.status,
    ...(child.providerSessionId ? { providerSessionId: child.providerSessionId } : {}),
    previousProviderSessionIds: JSON.stringify(child.previousProviderSessionIds ?? []),
  };
}

function overlayRuntimeSummaries(
  summaries: Iterable<SessionSummary>,
  patches: Map<string, Partial<SessionSummary>>,
  hiddenProviderSessionIds: Set<string>,
): void {
  for (const summary of summaries) {
    const copy = copySummary(summary);
    patches.set(copy.appSessionId, copy);
    patches.set(copy.providerSessionId ?? copy.appSessionId, copy);
    for (const providerSessionId of copy.compactedFromProviderSessionIds ?? []) {
      patches.set(providerSessionId, copy);
      if (providerSessionId !== copy.appSessionId) hiddenProviderSessionIds.add(providerSessionId);
    }
  }
}

function childIdentityKey(parentAppSessionId: string, childSessionId: string): string {
  return JSON.stringify([parentAppSessionId, childSessionId]);
}

function copySummary(summary: SessionSummary): SessionSummary {
  return {
    ...summary,
    ...(summary.compactedFromProviderSessionIds
      ? { compactedFromProviderSessionIds: [...summary.compactedFromProviderSessionIds] }
      : {}),
    features: summary.features.map((feature) => ({
      ...feature,
      preconditions: [...feature.preconditions],
      expectedBehavior: [...feature.expectedBehavior],
      verificationSteps: [...feature.verificationSteps],
      ...(feature.fulfills ? { fulfills: [...feature.fulfills] } : {}),
    })),
  };
}

function copyChild(child: PersistedChildSession): PersistedChildSession {
  return {
    ...child,
    ...(child.previousProviderSessionIds
      ? { previousProviderSessionIds: [...child.previousProviderSessionIds] }
      : {}),
    ...(child.spawnLink ? { spawnLink: { ...child.spawnLink } } : {}),
  };
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
