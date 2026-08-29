import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { PersistedChildSession } from '../ChildSessionState.js';
import type * as Protocol from '../protocol.js';
import type { RecordedCall } from './fakeFactoryRuntime.js';
import { providerSessionJsonl } from './providerSessionFixtures.js';

type PersistedSummaryPatch = Pick<
  Protocol.SessionSummary,
  | 'appSessionId'
  | 'providerSessionId'
  | 'compactedFromProviderSessionIds'
  | 'sessionPurpose'
  | 'title'
  | 'cwd'
  | 'workspaceKind'
  | 'configuration'
  | 'droidMissionConfiguration'
  | 'compactionModel'
  | 'tokensIn'
  | 'tokensOut'
  | 'contextTokens'
  | 'contextRemainingTokens'
  | 'contextAccuracy'
  | 'contextUpdatedAt'
  | 'maxContextTokens'
  | 'autoCompactions'
  | 'updatedAt'
>;

export class FakeHistoryIndex {
  nextCloseError?: Error;
  nextSyncError?: Error;
  recordEventErrorForText?: { text: string; error: Error };
  private readonly summariesByAppId = new Map<string, PersistedSummaryPatch>();
  private readonly childrenByParent = new Map<string, Map<string, PersistedChildSession>>();
  private readonly launchSettingsByProvider = new Map<
    string,
    Pick<Protocol.FactoryDefaultSettings, 'modelId' | 'reasoningEffort'>
  >();

  constructor(private readonly calls: RecordedCall[]) {}

  syncSummaries(summaries: Protocol.SessionSummary[]): boolean | undefined {
    const error = this.nextSyncError;
    delete this.nextSyncError;
    if (error) throw error;
    this.seedSummaries(summaries);
    this.calls.push({ target: 'history', method: 'syncSummaries', args: [summaries] });
    return undefined;
  }

  seedSummaries(summaries: Protocol.SessionSummary[]): void {
    for (const summary of summaries) {
      const patch = materializePersistedSummaryPatch(summary);
      this.summariesByAppId.set(patch.appSessionId, patch);
    }
  }

  seedChildSessions(children: PersistedChildSession[]): void {
    for (const child of children) this.upsertChildSession(child);
  }

  seedSessionLaunchSettings(
    providerSessionId: string,
    settings: Pick<Protocol.FactoryDefaultSettings, 'modelId' | 'reasoningEffort'>,
  ): void {
    this.launchSettingsByProvider.set(providerSessionId, structuredClone(settings));
  }

  sessionLaunchSettings(
    providerSessionId: string,
  ): Pick<Protocol.FactoryDefaultSettings, 'modelId' | 'reasoningEffort'> | undefined {
    const settings = this.launchSettingsByProvider.get(providerSessionId);
    return settings ? structuredClone(settings) : undefined;
  }

  summaryPatchesAndHidden(): {
    patches: Map<string, Partial<Protocol.SessionSummary>>;
    hiddenProviderSessionIds: Set<string>;
  } {
    const patches = new Map<string, Partial<Protocol.SessionSummary>>();
    const hiddenProviderSessionIds = new Set<string>();
    for (const patch of this.summariesByAppId.values()) {
      patches.set(patch.appSessionId, patch);
      patches.set(patch.providerSessionId ?? patch.appSessionId, patch);
      for (const providerSessionId of patch.compactedFromProviderSessionIds ?? []) {
        if (providerSessionId && providerSessionId !== patch.appSessionId)
          hiddenProviderSessionIds.add(providerSessionId);
      }
    }
    return { patches, hiddenProviderSessionIds };
  }

  // The fake does not scan transcripts; tests that exercise the
  // sessions.search command seed the results they expect back.
  nextSearchResults: Protocol.SessionSearchResult[] = [];
  nextIndexingIncomplete = false;
  lastSearchQuery: string | null = null;

  // Mirrors the production contract: records the query for assertions and
  // returns nothing once the scan has been superseded.
  searchSessions(query?: string, isStale?: () => boolean): Promise<Protocol.HistorySearchReply> {
    this.lastSearchQuery = query ?? null;
    return Promise.resolve({
      results: isStale?.() ? [] : this.nextSearchResults,
      indexingIncomplete: this.nextIndexingIncomplete,
    });
  }

  readonly indexingIdleStates: boolean[] = [];

  setIndexingIdle(isIdle: boolean): Promise<void> {
    this.indexingIdleStates.push(isIdle);
    return Promise.resolve();
  }

  upsertChildSession(child: PersistedChildSession): boolean | undefined {
    const children =
      this.childrenByParent.get(child.parentAppSessionId) ??
      new Map<string, PersistedChildSession>();
    children.set(child.childSessionId, structuredClone(child));
    this.childrenByParent.set(child.parentAppSessionId, children);
    this.calls.push({
      target: 'history',
      method: 'upsertChildSession',
      args: [child],
    });
    return undefined;
  }

  childSessions(parentAppSessionId: string): PersistedChildSession[] {
    return [...(this.childrenByParent.get(parentAppSessionId)?.values() ?? [])].map((child) =>
      structuredClone(child),
    );
  }

  childSession(
    parentAppSessionId: string,
    childSessionId: string,
  ): PersistedChildSession | undefined {
    const child = this.childrenByParent.get(parentAppSessionId)?.get(childSessionId);
    return child ? structuredClone(child) : undefined;
  }

  recordEvent(event: unknown): void {
    const failure = this.recordEventErrorForText;
    if (
      failure &&
      typeof event === 'object' &&
      event !== null &&
      'text' in event &&
      event.text === failure.text
    ) {
      delete this.recordEventErrorForText;
      throw failure.error;
    }
    this.calls.push({ target: 'history', method: 'recordEvent', args: [event] });
  }

  close(): void {
    this.calls.push({ target: 'cleanup', method: 'history.close', args: [] });
    const error = this.nextCloseError;
    delete this.nextCloseError;
    if (error) throw error;
  }
}

export function writeProviderConversation(
  home: string,
  sessionId: string,
  sessionTitle: string,
): void {
  const file = path.join(home, '.factory', 'sessions', `${sessionId}.jsonl`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    providerSessionJsonl({ type: 'session_start', sessionId, sessionTitle, cwd: '' }),
  );
}

function materializePersistedSummaryPatch(summary: Protocol.SessionSummary): PersistedSummaryPatch {
  return {
    appSessionId: summary.appSessionId,
    providerSessionId: summary.providerSessionId ?? summary.appSessionId,
    compactedFromProviderSessionIds: [...(summary.compactedFromProviderSessionIds ?? [])],
    sessionPurpose: summary.sessionPurpose,
    title: summary.title,
    cwd: summary.cwd,
    ...whenDefined(summary.workspaceKind, (workspaceKind) => ({ workspaceKind })),
    configuration: summary.configuration,
    ...whenDefined(summary.droidMissionConfiguration, (droidMissionConfiguration) => ({
      droidMissionConfiguration,
    })),
    ...whenDefined(summary.compactionModel, (compactionModel) => ({ compactionModel })),
    tokensIn: summary.tokensIn,
    tokensOut: summary.tokensOut,
    contextTokens: summary.contextTokens,
    ...whenDefined(summary.contextRemainingTokens, (contextRemainingTokens) => ({
      contextRemainingTokens,
    })),
    ...whenDefined(summary.contextAccuracy, (contextAccuracy) => ({ contextAccuracy })),
    ...whenDefined(summary.contextUpdatedAt, (contextUpdatedAt) => ({ contextUpdatedAt })),
    ...whenDefined(summary.maxContextTokens, (maxContextTokens) => ({ maxContextTokens })),
    ...whenDefined(summary.autoCompactions, (autoCompactions) => ({ autoCompactions })),
    updatedAt: summary.updatedAt,
  };
}

function whenDefined<T>(value: T | undefined, property: (value: T) => object): object {
  return value === undefined ? {} : property(value);
}
