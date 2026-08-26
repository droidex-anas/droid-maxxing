import type { PersistedChildSession } from './history.js';
import { persistenceChildKey, persistenceChildKeyPrefix } from './historyPersistenceQueueValues.js';
import type { SessionSummary } from './protocol.js';

interface SummaryState {
  phase: SessionSummary['phase'];
  streaming: boolean;
  providerSessionId?: string;
  compactedProviderSessionIds: string;
}

interface ChildState {
  status: PersistedChildSession['status'];
  providerSessionId?: string;
  previousProviderSessionIds: string;
}

interface DurabilityDecision {
  needsDurability: boolean;
  holdWhileBlocked: boolean;
}

/** Owns which accepted history state requires a durable publication boundary. */
export class HistoryDurabilityPolicy {
  private readonly summaries = new Map<string, SummaryState>();
  private readonly children = new Map<string, ChildState>();
  private readonly pendingSummaries = new Set<string>();
  private readonly pendingChildren = new Set<string>();
  private blocked = false;

  get isBlocked(): boolean {
    return this.blocked;
  }

  acceptSummaries(summaries: readonly SessionSummary[]): DurabilityDecision {
    let needsDurability = false;
    let holdWhileBlocked = false;
    for (const summary of summaries) {
      const wasPending = this.pendingSummaries.has(summary.appSessionId);
      const crossesBoundary = summaryNeedsDurability(
        this.summaries.get(summary.appSessionId),
        summary,
      );
      const needsBoundary = wasPending || crossesBoundary;
      if (needsBoundary) this.pendingSummaries.add(summary.appSessionId);
      needsDurability ||= needsBoundary;
      holdWhileBlocked ||= crossesBoundary || (wasPending && !summary.streaming);
      this.summaries.set(summary.appSessionId, summaryState(summary));
    }
    return { needsDurability, holdWhileBlocked };
  }

  acceptChild(child: PersistedChildSession): DurabilityDecision {
    const key = persistenceChildKey(child.parentAppSessionId, child.childSessionId);
    const wasPending = this.pendingChildren.has(key);
    const crossesBoundary = childNeedsDurability(this.children.get(key), child);
    const needsDurability = wasPending || crossesBoundary;
    if (needsDurability) this.pendingChildren.add(key);
    this.children.set(key, childState(child));
    const terminal = child.status === 'paused' || child.status === 'completed';
    return {
      needsDurability,
      holdWhileBlocked: crossesBoundary || (wasPending && terminal),
    };
  }

  observeChildren(children: readonly PersistedChildSession[]): void {
    for (const child of children) {
      const key = persistenceChildKey(child.parentAppSessionId, child.childSessionId);
      if (!this.children.has(key)) this.children.set(key, childState(child));
    }
  }

  noteFailure(): void {
    this.blocked = true;
  }

  noteDurable(): void {
    this.blocked = false;
    this.pendingSummaries.clear();
    this.pendingChildren.clear();
  }

  hasActiveWork(): boolean {
    for (const summary of this.summaries.values()) {
      if (summary.streaming) return true;
    }
    for (const child of this.children.values()) {
      if (child.status === 'pending' || child.status === 'running') return true;
    }
    return false;
  }

  forgetSession(appSessionId: string): void {
    this.summaries.delete(appSessionId);
    this.pendingSummaries.delete(appSessionId);
    const childPrefix = persistenceChildKeyPrefix(appSessionId);
    for (const key of this.children.keys()) {
      if (key.startsWith(childPrefix)) this.children.delete(key);
    }
    for (const key of this.pendingChildren) {
      if (key.startsWith(childPrefix)) this.pendingChildren.delete(key);
    }
  }
}

function summaryNeedsDurability(
  previous: SummaryState | undefined,
  summary: SessionSummary,
): boolean {
  const next = summaryState(summary);
  if (previous === undefined) return true;
  if (next.streaming) return false;
  const terminal = next.phase === 'paused' || next.phase === 'completed' || next.phase === 'failed';
  const identityChanged =
    previous.providerSessionId !== next.providerSessionId ||
    previous.compactedProviderSessionIds !== next.compactedProviderSessionIds;
  return previous.streaming || identityChanged || (terminal && previous.phase !== next.phase);
}

function summaryState(summary: SessionSummary): SummaryState {
  return {
    phase: summary.phase,
    streaming: summary.streaming === true,
    ...(summary.providerSessionId ? { providerSessionId: summary.providerSessionId } : {}),
    compactedProviderSessionIds: JSON.stringify(summary.compactedFromProviderSessionIds ?? []),
  };
}

function childNeedsDurability(
  previous: ChildState | undefined,
  child: PersistedChildSession,
): boolean {
  const next = childState(child);
  const identityChanged =
    previous !== undefined &&
    (previous.providerSessionId !== next.providerSessionId ||
      previous.previousProviderSessionIds !== next.previousProviderSessionIds);
  if (identityChanged) return true;
  if (next.status !== 'paused' && next.status !== 'completed') return false;
  return previous?.status !== next.status;
}

function childState(child: PersistedChildSession): ChildState {
  return {
    status: child.status,
    ...(child.providerSessionId ? { providerSessionId: child.providerSessionId } : {}),
    previousProviderSessionIds: JSON.stringify(child.previousProviderSessionIds ?? []),
  };
}
