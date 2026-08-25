import { applyCachedSummary, type HistoricalSession, type HistoryIndex } from './history.js';
import { isAbsolute, relative, resolve } from 'node:path';
import type { BridgeFeature, SessionSummary } from './protocol.js';
import { filterSessionListSummaries, type SessionListFilterOptions } from './sessionListFilter.js';
import { uniqueStrings } from './sessionHelpers.js';

export interface RegisteredSession {
  summary: SessionSummary;
}

type IdentityField =
  | 'appSessionId'
  | 'providerSessionId'
  | 'compactedFromProviderSessionIds'
  | 'missionId';

export type SessionSummaryPatch = Omit<Partial<SessionSummary>, IdentityField>;

type RegistryHistory = Pick<HistoryIndex, 'summaryPatchesAndHidden'> & {
  syncSummaries(summaries: SessionSummary[]): boolean | undefined;
  flushSync?: () => void;
  forgetSession?: (appSessionId: string) => void;
  readonly revision?: number;
};

type SummaryLoader = (options?: SessionListFilterOptions) => HistoricalSession[];

export interface SessionRegistryDependencies {
  history: RegistryHistory;
  loadOrdinarySessions: SummaryLoader;
  loadMissionControlSessions: SummaryLoader;
  projectSummary: (summary: Readonly<SessionSummary>) => SessionSummary;
  onSummaryUpdated: (summary: SessionSummary) => void;
  onLiveProviderReplaced?: (providerSessionId: string) => void;
  now: () => number;
}

export class SessionRegistry<TLive extends RegisteredSession> {
  private readonly sessions = new Map<string, TLive>();
  private readonly publishedLiveSummaries = new Map<string, SessionSummary>();
  private readonly summariesAwaitingDurability = new Map<
    string,
    { liveSession: TLive; summary: SessionSummary }
  >();
  private readonly providerAliases = new Map<string, string>();
  private readonly historicalAliases = new Map<string, string>();
  private historicalSummaries = new Map<string, SessionSummary>();
  private ordinaryHistoricalSummaries = new Map<string, SessionSummary>();
  private historicalPatches = new Map<string, Partial<SessionSummary>>();
  private hiddenHistoricalProviderSessionIds = new Set<string>();
  private historicalRevision: number | undefined;
  private historicalLoaded = false;

  constructor(private readonly dependencies: SessionRegistryDependencies) {}

  register(liveSession: TLive): void {
    // Runtime boundary guard: live session data can carry a child role even
    // though the type forbids it, so the narrow type alone is not sufficient.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Runtime validation despite the narrow declared type.
    if (liveSession.summary.role !== 'primary' && liveSession.summary.role !== 'user') {
      throw new Error('SessionRegistry accepts top-level sessions only.');
    }
    this.persistStrict(liveSession.summary);

    const previous = this.sessions.get(liveSession.summary.appSessionId);
    if (previous) this.removeAliases(previous.summary);

    this.sessions.set(liveSession.summary.appSessionId, liveSession);
    this.publishedLiveSummaries.set(liveSession.summary.appSessionId, liveSession.summary);
    this.summariesAwaitingDurability.delete(liveSession.summary.appSessionId);
    this.indexAliases(liveSession.summary);
  }

  getLive(id: string): TLive | undefined {
    const direct = this.sessions.get(id);
    if (direct) return direct;

    const appSessionId = this.providerAliases.get(id);
    return appSessionId ? this.sessions.get(appSessionId) : undefined;
  }

  // Gauge for hot-path metrics: live top-level sessions currently held.
  get liveCount(): number {
    return this.sessions.size;
  }

  isCurrentLiveProvider(providerSessionId: string): boolean {
    return this.getLive(providerSessionId)?.summary.providerSessionId === providerSessionId;
  }

  getCanonicalSummary(id: string): SessionSummary | undefined {
    const summary = this.resolveCanonicalSummary(id);
    return summary ? copySummary(summary) : undefined;
  }

  resolveSummary(id: string): SessionSummary | undefined {
    const summary = this.resolveCanonicalSummary(id);
    return summary ? this.project(summary) : undefined;
  }

  listSummaries(options?: SessionListFilterOptions): SessionSummary[] {
    const projected = [...this.mergeCanonicalSummaries().values()]
      .map((summary) => this.project(summary))
      .sort((left, right) => right.updatedAt - left.updatedAt);

    return filterSessionListSummaries(projected, options);
  }

  updateSummary(
    id: string,
    patch: SessionSummaryPatch,
    options: { touchActivity?: boolean } = {},
  ): SessionSummary | undefined {
    const liveSession = this.getLive(id);
    if (!liveSession) return undefined;

    const updated = this.withPatch(liveSession.summary, patch, options.touchActivity !== false);
    const durable = this.persist(updated);
    liveSession.summary = updated;
    if (durable === false) {
      this.summariesAwaitingDurability.set(updated.appSessionId, { liveSession, summary: updated });
      return copySummary(updated);
    }
    this.summariesAwaitingDurability.delete(updated.appSessionId);
    this.publishedLiveSummaries.set(updated.appSessionId, updated);
    this.publish(updated);
    return updated;
  }

  reanchorHistoricalCwd(fromCwd: string, toCwd: string): SessionSummary[] {
    if (!isAbsolute(fromCwd) || !isAbsolute(toCwd)) {
      throw new Error('Session cwd re-anchoring requires absolute paths.');
    }

    const from = resolve(fromCwd);
    const summaries = [...this.mergeCanonicalSummaries().values()];
    if (
      summaries.some(
        (summary) => this.sessions.has(summary.appSessionId) && isInside(from, summary.cwd),
      )
    ) {
      throw new Error('A live session is still using this worktree.');
    }
    const affected = summaries.filter((summary) => isInside(from, summary.cwd));
    const updated = affected.map((summary) =>
      this.withPatch(
        summary,
        {
          cwd: resolve(toCwd, relative(from, resolve(summary.cwd))),
          workspaceKind: 'folder',
        },
        false,
      ),
    );
    if (updated.length === 0) return [];

    this.dependencies.history.syncSummaries(updated);
    this.dependencies.history.flushSync?.();
    for (const summary of updated) {
      this.cacheHistoricalSummary(summary);
      this.publish(summary);
    }
    this.rebuildHistoricalAliases(this.historicalSummaries.values());
    return updated.map(copySummary);
  }

  replaceProvider(
    id: string,
    providerSessionId: string,
    patch: SessionSummaryPatch = {},
  ): SessionSummary | undefined {
    const current = this.resolveCanonicalSummary(id);
    if (!current) return undefined;
    if (current.providerSessionId === providerSessionId) return current;
    const liveSession = this.sessions.get(current.appSessionId);

    // A provider swap is compaction bookkeeping, not user-visible activity:
    // updatedAt (sidebar order, unread marker) stays where the turn left it.
    const updated = {
      ...this.withPatch(current, patch, false),
      providerSessionId,
      compactedFromProviderSessionIds: uniqueStrings([
        ...(current.compactedFromProviderSessionIds ?? []),
        current.providerSessionId,
      ]),
    };

    this.persistStrict(updated);
    if (liveSession) {
      this.removeAliases(current);
      liveSession.summary = updated;
      this.summariesAwaitingDurability.delete(updated.appSessionId);
      this.publishedLiveSummaries.set(updated.appSessionId, updated);
      this.indexAliases(updated);
    } else {
      this.cacheHistoricalSummary(updated);
      this.rebuildHistoricalAliases(this.historicalSummaries.values());
    }

    this.publish(updated);
    if (liveSession && current.providerSessionId) {
      this.dependencies.onLiveProviderReplaced?.(current.providerSessionId);
    }
    return updated;
  }

  unregister(id: string): TLive | undefined {
    const liveSession = this.getLive(id);
    if (!liveSession) return undefined;

    // SessionLifecycle emits session.closed immediately after unregister. Make
    // queued transcript and summary state durable before that user-visible
    // boundary rather than claiming a closed session whose final rows are only
    // in memory.
    this.dependencies.history.flushSync?.();
    this.dependencies.history.forgetSession?.(liveSession.summary.appSessionId);
    this.historicalLoaded = false;
    this.sessions.delete(liveSession.summary.appSessionId);
    this.publishedLiveSummaries.delete(liveSession.summary.appSessionId);
    this.summariesAwaitingDurability.delete(liveSession.summary.appSessionId);
    this.removeAliases(liveSession.summary);
    return liveSession;
  }

  retryPendingDurability(): void {
    for (const [appSessionId, pending] of this.summariesAwaitingDurability) {
      if (this.sessions.get(appSessionId) !== pending.liveSession) {
        this.summariesAwaitingDurability.delete(appSessionId);
        continue;
      }
      if (pending.liveSession.summary !== pending.summary) continue;
      this.summariesAwaitingDurability.delete(appSessionId);
      this.publishedLiveSummaries.set(appSessionId, pending.summary);
      this.publish(pending.summary);
    }
  }

  liveSessionsSnapshot(): readonly TLive[] {
    return [...this.sessions.values()];
  }

  private resolveCanonicalSummary(id: string): SessionSummary | undefined {
    const liveSession = this.getLive(id);
    if (liveSession) return liveSession.summary;

    this.ensureHistoricalSummaries();
    const direct = this.historicalSummaries.get(id);
    if (direct) return direct;
    const indexed = this.historicalAliases.get(id);
    return indexed ? this.historicalSummaries.get(indexed) : undefined;
  }

  private mergeCanonicalSummaries(): Map<string, SessionSummary> {
    this.ensureHistoricalSummaries();
    const summaries = new Map(this.historicalSummaries);
    for (const liveSession of this.sessions.values()) {
      const appSessionId = liveSession.summary.appSessionId;
      summaries.set(
        appSessionId,
        this.publishedLiveSummaries.get(appSessionId) ?? liveSession.summary,
      );
    }
    return summaries;
  }

  private ensureHistoricalSummaries(): void {
    const revision = this.dependencies.history.revision;
    const ordinaryHistoryChanged =
      !this.historicalLoaded || revision === undefined || revision !== this.historicalRevision;
    if (ordinaryHistoryChanged) {
      const { patches, hiddenProviderSessionIds } =
        this.dependencies.history.summaryPatchesAndHidden();
      this.historicalPatches = patches;
      this.hiddenHistoricalProviderSessionIds = hiddenProviderSessionIds;
      this.ordinaryHistoricalSummaries = new Map<string, SessionSummary>();
      this.mergeHistoricalSummaries(
        this.ordinaryHistoricalSummaries,
        this.dependencies.loadOrdinarySessions(),
        patches,
        hiddenProviderSessionIds,
      );
      this.historicalRevision = revision;
      this.historicalLoaded = true;
    }

    const summaries = new Map(this.ordinaryHistoricalSummaries);
    this.mergeHistoricalSummaries(
      summaries,
      this.dependencies.loadMissionControlSessions(),
      this.historicalPatches,
      this.hiddenHistoricalProviderSessionIds,
    );
    this.historicalSummaries = summaries;
    this.rebuildHistoricalAliases(summaries.values());
  }

  private mergeHistoricalSummaries(
    target: Map<string, SessionSummary>,
    sessions: HistoricalSession[],
    patches: Map<string, Partial<SessionSummary>>,
    hiddenProviderSessionIds: Set<string>,
  ): void {
    for (const historical of sessions) {
      const summary = applyCachedSummary(historical.summary, patches);
      const providerSessionId = summary.providerSessionId ?? summary.appSessionId;
      if (hiddenProviderSessionIds.has(providerSessionId)) continue;

      target.set(summary.appSessionId, summary);
    }
  }

  private withPatch(
    summary: SessionSummary,
    patch: SessionSummaryPatch,
    touchActivity = true,
  ): SessionSummary {
    // updatedAt drives sidebar ordering and the renderer's unread marker, so it
    // must only move for user-visible activity. Passive telemetry patches
    // (token usage, context stats, compaction counters) keep the timestamp.
    return copySummary({
      ...summary,
      ...withoutIdentityFields(patch),
      updatedAt: touchActivity ? this.dependencies.now() : summary.updatedAt,
    });
  }

  private project(summary: SessionSummary): SessionSummary {
    const canonical = copySummary(summary);
    const projected = this.dependencies.projectSummary(canonical);
    return copySummary({ ...canonical, ...withoutIdentityFields(projected) });
  }

  private persist(summary: SessionSummary): boolean | undefined {
    return this.dependencies.history.syncSummaries([summary]);
  }

  private persistStrict(summary: SessionSummary): void {
    if (this.persist(summary) !== false) return;
    if (!this.dependencies.history.flushSync) {
      throw new Error('History durability is pending and no strict flush is available.');
    }
    this.dependencies.history.flushSync();
  }

  private publish(summary: SessionSummary): void {
    this.dependencies.onSummaryUpdated(this.project(summary));
  }

  private indexAliases(summary: SessionSummary): void {
    for (const providerSessionId of providerIds(summary)) {
      this.providerAliases.set(providerSessionId, summary.appSessionId);
    }
  }

  private removeAliases(summary: SessionSummary): void {
    for (const providerSessionId of providerIds(summary)) {
      if (this.providerAliases.get(providerSessionId) === summary.appSessionId) {
        this.providerAliases.delete(providerSessionId);
      }
    }
  }

  private rebuildHistoricalAliases(summaries: Iterable<SessionSummary>): void {
    this.historicalAliases.clear();
    for (const summary of summaries) {
      this.historicalAliases.set(summary.appSessionId, summary.appSessionId);
      for (const providerSessionId of providerIds(summary)) {
        this.historicalAliases.set(providerSessionId, summary.appSessionId);
      }
    }
  }

  private cacheHistoricalSummary(summary: SessionSummary): void {
    const cached = copySummary(summary);
    this.historicalSummaries.set(cached.appSessionId, cached);
    if (cached.sessionPurpose !== 'mission-control') {
      this.ordinaryHistoricalSummaries.set(cached.appSessionId, cached);
    }
    this.historicalPatches.set(cached.appSessionId, cached);
    for (const providerSessionId of providerIds(cached)) {
      this.historicalPatches.set(providerSessionId, cached);
    }
  }
}

function providerIds(summary: SessionSummary): string[] {
  return uniqueStrings([
    summary.providerSessionId,
    ...(summary.compactedFromProviderSessionIds ?? []),
  ]);
}

function withoutIdentityFields(patch: Partial<SessionSummary>): SessionSummaryPatch {
  const safePatch = { ...patch };
  delete safePatch.appSessionId;
  delete safePatch.providerSessionId;
  delete safePatch.compactedFromProviderSessionIds;
  delete safePatch.missionId;
  return safePatch;
}

function copySummary(summary: SessionSummary): SessionSummary {
  return {
    ...summary,
    ...(summary.compactedFromProviderSessionIds
      ? { compactedFromProviderSessionIds: [...summary.compactedFromProviderSessionIds] }
      : {}),
    features: summary.features.map(copyFeature),
  };
}

function copyFeature(feature: BridgeFeature): BridgeFeature {
  return {
    ...feature,
    preconditions: [...feature.preconditions],
    expectedBehavior: [...feature.expectedBehavior],
    verificationSteps: [...feature.verificationSteps],
    ...(feature.fulfills ? { fulfills: [...feature.fulfills] } : {}),
  };
}

function isInside(parent: string, candidate: string): boolean {
  if (!candidate || !isAbsolute(candidate)) return false;
  const path = relative(parent, resolve(candidate));
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}
