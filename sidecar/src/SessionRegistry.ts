import { isAbsolute, relative, resolve } from 'node:path';

import { applyCachedSummary, type HistoricalSession, type HistoryIndex } from './history.js';
import type { SessionSummary } from './protocol.js';
import type { ProviderBinding, SessionStore } from './persistence/SessionStore.js';
import { decodeSummaryJson, encodeSummaryJson } from './persistence/sessionSummaryJson.js';
import {
  filterSessionListSummaries,
  type SessionListFilterOptions,
  type SessionListPage,
} from './sessionListFilter.js';
import {
  copySummary,
  factoryFacingSummary,
  liveBindingFromSummary,
  nativeIds,
  projectWireSessionSummary,
  providerIds,
  withoutIdentityFields,
  type SessionSummaryPatch,
} from './sessionRegistryProjection.js';
import { uniqueStrings } from './sessionHelpers.js';

export type { SessionSummaryPatch } from './sessionRegistryProjection.js';
export { liveBindingFromSummary } from './sessionRegistryProjection.js';

export interface RegisteredSession {
  summary: SessionSummary;
  binding?: ProviderBinding;
}

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
  onLiveSetChanged?: () => void;
  now: () => number;
  sessionStore?: Pick<SessionStore, 'get' | 'updateSummary' | 'replaceProviderRuntime'>;
}

export class SessionRegistry<TLive extends RegisteredSession> {
  private readonly sessions = new Map<string, TLive>();
  private readonly publishedLiveSummaries = new Map<string, SessionSummary>();
  private readonly summariesAwaitingDurability = new Map<
    string,
    { liveSession: TLive; summary: SessionSummary }
  >();
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
    const binding = this.bindingOf(liveSession);
    liveSession.binding = binding;
    this.persistStrict(factoryFacingSummary(liveSession.summary, binding));

    this.sessions.set(liveSession.summary.appSessionId, liveSession);
    this.publishedLiveSummaries.set(liveSession.summary.appSessionId, liveSession.summary);
    this.summariesAwaitingDurability.delete(liveSession.summary.appSessionId);
    this.indexLiveAliases(liveSession);
    this.dependencies.onLiveSetChanged?.();
  }

  getLive(appSessionId: string): TLive | undefined {
    return this.sessions.get(appSessionId);
  }

  get liveCount(): number {
    return this.sessions.size;
  }

  isCurrentLiveProvider(providerSessionId: string): boolean {
    for (const live of this.sessions.values()) {
      if (this.bindingOf(live).providerSessionId === providerSessionId) return true;
    }
    return false;
  }

  getCanonicalSummary(id: string): SessionSummary | undefined {
    const summary = this.resolveCanonicalSummary(id);
    return summary ? copySummary(summary) : undefined;
  }

  resolveSummary(id: string): SessionSummary | undefined {
    const resolved = this.resolveCanonicalAndBinding(id);
    return resolved ? this.project(resolved.summary, resolved.binding) : undefined;
  }

  listSummaries(options: SessionListFilterOptions = {}): SessionListPage {
    const projected = [...this.mergeCanonicalSummaries().values()]
      .map((entry) => this.project(entry.summary, entry.binding))
      .sort((left, right) => right.updatedAt - left.updatedAt);

    return filterSessionListSummaries(projected, options, (summary) => this.isAppOwned(summary));
  }

  private isAppOwned(summary: SessionSummary): boolean {
    return (
      this.sessions.has(summary.appSessionId) ||
      this.historicalPatches.has(summary.appSessionId) ||
      (summary.providerSessionId !== undefined &&
        this.historicalPatches.has(summary.providerSessionId))
    );
  }

  updateSummary(
    appSessionId: string,
    patch: SessionSummaryPatch,
    options: { touchActivity?: boolean } = {},
  ): SessionSummary | undefined {
    const liveSession = this.sessions.get(appSessionId);
    if (!liveSession) return undefined;

    const updated = this.withPatch(liveSession.summary, patch, options.touchActivity !== false);
    const binding = this.bindingOf(liveSession);
    const durable = this.persist(factoryFacingSummary(updated, binding), {
      touchActivity: options.touchActivity !== false,
    });
    liveSession.summary = updated;
    if (durable === false) {
      this.summariesAwaitingDurability.set(updated.appSessionId, { liveSession, summary: updated });
      return this.project(updated, binding);
    }
    this.summariesAwaitingDurability.delete(updated.appSessionId);
    this.publishedLiveSummaries.set(updated.appSessionId, updated);
    this.publish(updated, binding);
    return this.project(updated, binding);
  }

  reanchorHistoricalCwd(fromCwd: string, toCwd: string): SessionSummary[] {
    if (!isAbsolute(fromCwd) || !isAbsolute(toCwd)) {
      throw new Error('Session cwd re-anchoring requires absolute paths.');
    }

    const from = resolve(fromCwd);
    const summaries = [...this.mergeCanonicalSummaries().values()].map((entry) => entry.summary);
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
      this.publish(summary, liveBindingFromSummary(summary));
    }
    this.rebuildHistoricalAliases(this.historicalSummaries.values());
    return updated.map((summary) => this.project(summary, liveBindingFromSummary(summary)));
  }

  replaceProvider(
    id: string,
    providerSessionId: string,
    patch: SessionSummaryPatch = {},
  ): SessionSummary | undefined {
    const current = this.resolveCanonicalSummary(id);
    if (!current) return undefined;
    const liveSession = this.sessions.get(current.appSessionId);
    const liveBinding = liveSession ? this.bindingOf(liveSession) : undefined;
    const currentNative = liveBinding?.providerSessionId ?? current.providerSessionId;
    if (currentNative === providerSessionId) return current;

    const previous = uniqueStrings([
      ...(liveBinding?.previousProviderSessionIds ?? current.compactedFromProviderSessionIds ?? []),
      currentNative,
    ]);
    const updated = {
      ...this.withPatch(current, patch, false),
      providerSessionId,
      compactedFromProviderSessionIds: previous,
    };
    const nextBinding: ProviderBinding = liveBinding
      ? {
          ...liveBinding,
          providerSessionId,
          previousProviderSessionIds: previous,
          runtimeGeneration: liveBinding.runtimeGeneration + 1,
        }
      : liveBindingFromSummary(updated);

    this.persistStrict(updated);
    this.replaceCanonicalRuntime(current.appSessionId, providerSessionId);
    if (liveSession) {
      liveSession.binding = nextBinding;
      liveSession.summary = updated;
      this.summariesAwaitingDurability.delete(updated.appSessionId);
      this.publishedLiveSummaries.set(updated.appSessionId, updated);
      this.indexLiveAliases(liveSession);
    } else {
      this.cacheHistoricalSummary(updated);
      this.rebuildHistoricalAliases(this.historicalSummaries.values());
    }

    this.publish(updated, nextBinding);
    if (liveSession && currentNative) {
      this.dependencies.onLiveProviderReplaced?.(currentNative);
    }
    return updated;
  }

  unregister(appSessionId: string): TLive | undefined {
    const liveSession = this.sessions.get(appSessionId);
    if (!liveSession) return undefined;

    this.dependencies.history.flushSync?.();
    this.dependencies.history.forgetSession?.(liveSession.summary.appSessionId);
    this.historicalLoaded = false;
    this.sessions.delete(liveSession.summary.appSessionId);
    this.publishedLiveSummaries.delete(liveSession.summary.appSessionId);
    this.summariesAwaitingDurability.delete(liveSession.summary.appSessionId);
    this.dependencies.onLiveSetChanged?.();
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
      this.publish(pending.summary, this.bindingOf(pending.liveSession));
    }
  }

  liveSessionsSnapshot(): readonly TLive[] {
    return [...this.sessions.values()];
  }

  private resolveCanonicalSummary(id: string): SessionSummary | undefined {
    return this.resolveCanonicalAndBinding(id)?.summary;
  }

  private resolveCanonicalAndBinding(
    id: string,
  ): { summary: SessionSummary; binding?: ProviderBinding } | undefined {
    const liveDirect = this.sessions.get(id);
    if (liveDirect) return { summary: liveDirect.summary, binding: this.bindingOf(liveDirect) };

    this.ensureHistoricalSummaries();
    const appSessionId = this.historicalAliases.get(id) ?? id;
    const live = this.sessions.get(appSessionId);
    if (live) return { summary: live.summary, binding: this.bindingOf(live) };
    const historical = this.historicalSummaries.get(appSessionId);
    if (!historical) return undefined;
    return { summary: historical, binding: liveBindingFromSummary(historical) };
  }

  private mergeCanonicalSummaries(): Map<
    string,
    { summary: SessionSummary; binding?: ProviderBinding }
  > {
    this.ensureHistoricalSummaries();
    const summaries = new Map<string, { summary: SessionSummary; binding?: ProviderBinding }>();
    for (const summary of this.historicalSummaries.values()) {
      summaries.set(summary.appSessionId, {
        summary,
        binding: liveBindingFromSummary(summary),
      });
    }
    for (const liveSession of this.sessions.values()) {
      const appSessionId = liveSession.summary.appSessionId;
      summaries.set(appSessionId, {
        summary: this.publishedLiveSummaries.get(appSessionId) ?? liveSession.summary,
        binding: this.bindingOf(liveSession),
      });
    }
    return summaries;
  }

  private ensureHistoricalSummaries(): void {
    const revision = this.dependencies.history.revision;
    const historicalChanged =
      !this.historicalLoaded || revision === undefined || revision !== this.historicalRevision;
    if (!historicalChanged) return;

    const { patches, hiddenProviderSessionIds } =
      this.dependencies.history.summaryPatchesAndHidden();
    const ordinarySummaries = new Map<string, SessionSummary>();
    this.mergeHistoricalSummaries(
      ordinarySummaries,
      this.dependencies.loadOrdinarySessions(),
      patches,
      hiddenProviderSessionIds,
    );
    const summaries = new Map(ordinarySummaries);
    this.mergeHistoricalSummaries(
      summaries,
      this.dependencies.loadMissionControlSessions(),
      patches,
      hiddenProviderSessionIds,
    );

    this.historicalPatches = patches;
    this.hiddenHistoricalProviderSessionIds = hiddenProviderSessionIds;
    this.ordinaryHistoricalSummaries = ordinarySummaries;
    this.historicalSummaries = summaries;
    this.rebuildHistoricalAliases(summaries.values());
    this.historicalRevision = revision;
    this.historicalLoaded = true;
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
    return copySummary({
      ...summary,
      ...withoutIdentityFields(patch),
      updatedAt: touchActivity ? this.dependencies.now() : summary.updatedAt,
    });
  }

  private project(summary: SessionSummary, binding?: ProviderBinding): SessionSummary {
    return projectWireSessionSummary(summary, this.dependencies.projectSummary, binding);
  }

  private persist(
    summary: SessionSummary,
    options: { touchActivity?: boolean } = {},
  ): boolean | undefined {
    const result = this.dependencies.history.syncSummaries([summary]);
    this.syncCanonicalSummary(summary, options.touchActivity !== false);
    return result;
  }

  private persistStrict(summary: SessionSummary): void {
    if (this.persist(summary, { touchActivity: false }) !== false) return;
    if (!this.dependencies.history.flushSync) {
      throw new Error('History durability is pending and no strict flush is available.');
    }
    this.dependencies.history.flushSync();
  }

  private syncCanonicalSummary(summary: SessionSummary, touchActivity: boolean): void {
    const store = this.dependencies.sessionStore;
    if (!store) return;
    const stored = store.get(summary.appSessionId);
    if (!stored) return;
    const json = decodeSummaryJson(encodeSummaryJson(summary), stored.binding.providerInstanceId);
    store.updateSummary(summary.appSessionId, json, { touchActivity });
  }

  private replaceCanonicalRuntime(appSessionId: string, providerSessionId: string): void {
    const store = this.dependencies.sessionStore;
    if (!store) return;
    const stored = store.get(appSessionId);
    if (!stored) return;
    store.replaceProviderRuntime(appSessionId, stored.binding.runtimeGeneration, providerSessionId);
  }

  private publish(summary: SessionSummary, binding?: ProviderBinding): void {
    this.dependencies.onSummaryUpdated(this.project(summary, binding));
  }

  private indexLiveAliases(liveSession: TLive): void {
    const appSessionId = liveSession.summary.appSessionId;
    this.historicalAliases.set(appSessionId, appSessionId);
    for (const nativeId of nativeIds(this.bindingOf(liveSession), liveSession.summary)) {
      this.historicalAliases.set(nativeId, appSessionId);
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
    for (const liveSession of this.sessions.values()) {
      this.indexLiveAliases(liveSession);
    }
  }

  private bindingOf(live: TLive): ProviderBinding {
    return live.binding ?? liveBindingFromSummary(live.summary);
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

function isInside(parent: string, candidate: string): boolean {
  if (!candidate || !isAbsolute(candidate)) return false;
  const path = relative(parent, resolve(candidate));
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}
