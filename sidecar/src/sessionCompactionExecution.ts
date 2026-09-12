import type { AskUserHandler, PermissionHandler } from '@factory/droid-sdk';

import { runCompaction } from './compaction.js';
import type { FactoryRuntime, FactorySession } from './DroidRuntime.js';
import type { ServerEvent } from './protocol.js';
import type { AgentProcessMonitor } from './processes/AgentProcessMonitor.js';
import type { LiveOperationTarget, SessionContext, UsageOffset } from './SessionContext.js';
import type { LiveSession } from './SessionLifecycle.js';
import type { SessionRegistry } from './SessionRegistry.js';
import { errMsg } from './sessionHelpers.js';
import type { SessionTimeline } from './SessionTimeline.js';

export type CompactionExecutionResult =
  | { kind: 'ready-to-settle' }
  | {
      kind: 'close-and-resume';
      appSessionId: string;
      providerSessionId: string;
      carryover: UsageOffset;
      reloadError: string;
    };

export interface SessionCompactionExecutionDependencies {
  registry: Pick<
    SessionRegistry<LiveSession>,
    'getLive' | 'resolveSummary' | 'replaceProvider' | 'updateSummary'
  >;
  context: Pick<SessionContext, 'refresh' | 'preserveUsage' | 'recordCompaction'>;
  timeline: Pick<SessionTimeline, 'appendCompaction' | 'appendStatus'>;
  runtime: Pick<FactoryRuntime, 'loadSession' | 'processIdOf' | 'isProcessAlive'>;
  agentProcesses: Pick<AgentProcessMonitor, 'track' | 'untrack' | 'adoptDescendantsAsRoots'>;
  makePermissionHandler(ref: { id: string }): PermissionHandler;
  makeAskUserHandler(ref: { id: string }): AskUserHandler;
  emitError(error: Omit<Extract<ServerEvent, { type: 'error' }>, 'type'>): void;
}

interface SessionCompactionExecutionEffects {
  subscribePrimary(liveSession: LiveSession): void;
  rearmPrimary(liveSession: LiveSession): Promise<void>;
  primaryTarget(liveSession: LiveSession): LiveOperationTarget;
}

export class SessionCompactionExecution {
  constructor(
    private readonly dependencies: SessionCompactionExecutionDependencies,
    private readonly effects: SessionCompactionExecutionEffects,
  ) {}

  async compact(
    appSessionId: string,
    customInstructions?: string,
  ): Promise<CompactionExecutionResult> {
    const liveSession = this.dependencies.registry.getLive(appSessionId);
    if (liveSession) return this.compactLiveSession(liveSession, customInstructions);
    await this.compactHistoricalSession(appSessionId, customInstructions);
    return { kind: 'ready-to-settle' };
  }

  private async compactLiveSession(
    liveSession: LiveSession,
    customInstructions: string | undefined,
  ): Promise<CompactionExecutionResult> {
    const appSessionId = liveSession.summary.appSessionId;
    const isCurrent = () => this.effects.primaryTarget(liveSession).isCurrent();
    const preCompactSessionId = liveSession.summary.providerSessionId;
    const carryover: UsageOffset = {
      tokensIn: liveSession.summary.tokensIn,
      tokensOut: liveSession.summary.tokensOut,
    };
    let swapTarget: string | undefined;
    liveSession.compacting = true;
    try {
      const outcome = await runCompaction(
        liveSession.session,
        {
          status: (text, compactType) => {
            if (!isCurrent()) return;
            this.dependencies.timeline.appendStatus(appSessionId, text, compactType);
          },
          error: (message) => {
            if (!isCurrent()) return;
            this.dependencies.emitError({
              providerSessionId: liveSession.summary.providerSessionId,
              appSessionId,
              message: `Could not compact session: ${message}`,
              recoverable: true,
            });
          },
          refresh: () => {
            if (!isCurrent()) return Promise.resolve();
            const current = this.dependencies.registry.getLive(appSessionId);
            if (current?.summary.providerSessionId === preCompactSessionId) {
              // In-place compaction: recordCompaction owns the reset so its
              // generation bump keeps in-flight pre-compaction stats polls
              // from re-publishing the old usage over the reset meter.
              this.dependencies.context.recordCompaction(this.effects.primaryTarget(liveSession));
            } else if (current) {
              // The provider was swapped; the new session object already keeps
              // stale polls inert, and replaceProvider owns the counters.
              this.dependencies.registry.updateSummary(
                appSessionId,
                {
                  contextTokens: 0,
                  contextAccuracy: undefined,
                },
                { touchActivity: false },
              );
            }
            return this.dependencies.context.refresh(this.effects.primaryTarget(liveSession));
          },
          reload: async (newSessionId) => {
            if (!isCurrent()) return;
            swapTarget = newSessionId;
            await this.adoptProvider(liveSession, newSessionId, carryover);
          },
        },
        { customInstructions, compactType: 'manual' },
      );
      if (outcome === 'stale' && swapTarget && isCurrent())
        return await this.recoverStaleProvider(liveSession, swapTarget, carryover);
      return { kind: 'ready-to-settle' };
    } finally {
      liveSession.compacting = false;
    }
  }

  private async adoptProvider(
    liveSession: LiveSession,
    providerSessionId: string,
    carryover: UsageOffset,
  ): Promise<void> {
    const appSessionId = liveSession.summary.appSessionId;
    const ref = { id: appSessionId };
    const oldSession = liveSession.session;
    const target = this.effects.primaryTarget(liveSession);
    const replacement = await this.dependencies.runtime.loadSession(providerSessionId, {
      permissionHandler: this.dependencies.makePermissionHandler(ref),
      askUserHandler: this.dependencies.makeAskUserHandler(ref),
      cwd: liveSession.summary.cwd,
      mcpServers: liveSession.mcpConfigs,
    });
    const replacementPid = this.dependencies.runtime.processIdOf(replacement);
    const rawOldPid = this.dependencies.runtime.processIdOf(oldSession);
    const oldPid = rawOldPid !== replacementPid ? rawOldPid : undefined;
    let installed = false;
    try {
      if (!target.isCurrent()) return;
      if (replacementPid !== undefined)
        this.dependencies.agentProcesses.track(
          appSessionId,
          replacementPid,
          () => this.dependencies.runtime.isProcessAlive(replacement),
          'provisional',
        );
      // Keep the old provider alive and owned until discovery succeeds.
      // Closing it on a failed scan would orphan its unobserved children.
      if (oldPid !== undefined) {
        const adopted = await this.dependencies.agentProcesses.adoptDescendantsAsRoots(
          appSessionId,
          oldPid,
          () => target.isCurrent(),
        );
        if (!target.isCurrent()) return;
        if (!adopted)
          throw new Error('Could not preserve processes before replacing the provider.');
      }
      await oldSession.close();
      if (!target.isCurrent()) return;
      if (oldPid !== undefined) this.dependencies.agentProcesses.untrack(oldPid, appSessionId);
      liveSession.session = replacement;
      installed = true;
      if (replacementPid !== undefined)
        this.dependencies.agentProcesses.track(appSessionId, replacementPid, () =>
          this.dependencies.runtime.isProcessAlive(replacement),
        );
      this.effects.subscribePrimary(liveSession);
      await this.effects.rearmPrimary(liveSession).catch(ignoreError);
      if (!this.effects.primaryTarget(liveSession).isCurrent()) return;
      liveSession.todoDisabledForDesign = undefined;
      this.dependencies.context.preserveUsage(appSessionId, carryover);
      this.replaceProvider(appSessionId, providerSessionId, carryover);
    } finally {
      if (!installed) {
        try {
          await replacement.close();
          if (replacementPid !== undefined)
            this.dependencies.agentProcesses.untrack(replacementPid, appSessionId);
        } catch (error) {
          // Leave the provisional root owned by the session's kill pass.
          this.dependencies.emitError({
            appSessionId,
            providerSessionId,
            message: `Could not close unused compaction provider: ${errMsg(error)}`,
            recoverable: true,
          });
        }
      }
    }
  }

  private async recoverStaleProvider(
    liveSession: LiveSession,
    providerSessionId: string,
    carryover: UsageOffset,
  ): Promise<CompactionExecutionResult> {
    let reloadError: string;
    try {
      await this.adoptProvider(liveSession, providerSessionId, carryover);
      return { kind: 'ready-to-settle' };
    } catch (error) {
      // Persist the daemon-authoritative id; Manager performs close-and-resume.
      reloadError = errMsg(error);
    }
    if (!this.effects.primaryTarget(liveSession).isCurrent()) return { kind: 'ready-to-settle' };
    const appSessionId = liveSession.summary.appSessionId;
    try {
      this.replaceProvider(appSessionId, providerSessionId, carryover);
    } catch (error) {
      this.dependencies.emitError({
        providerSessionId,
        appSessionId,
        message: `Could not persist compacted session identity: ${errMsg(error)}`,
        recoverable: true,
      });
      throw error;
    }
    return {
      kind: 'close-and-resume',
      appSessionId,
      providerSessionId,
      carryover,
      reloadError,
    };
  }

  private async compactHistoricalSession(
    requestedAppSessionId: string,
    customInstructions: string | undefined,
  ): Promise<void> {
    const historical = this.dependencies.registry.resolveSummary(requestedAppSessionId);
    const appSessionId = historical?.appSessionId ?? requestedAppSessionId;
    const oldProviderSessionId = historical?.providerSessionId ?? requestedAppSessionId;
    let session: FactorySession | undefined;
    try {
      session = await this.dependencies.runtime.loadSession(oldProviderSessionId);
      const result: unknown = await session.compactSession(
        customInstructions ? { customInstructions } : {},
      );
      const providerSessionId =
        result !== null &&
        typeof result === 'object' &&
        'newSessionId' in result &&
        typeof result.newSessionId === 'string' &&
        result.newSessionId
          ? result.newSessionId
          : oldProviderSessionId;
      if (providerSessionId !== oldProviderSessionId && historical)
        this.persistHistoricalProvider(appSessionId, providerSessionId);
    } catch (error) {
      this.dependencies.emitError({
        providerSessionId: oldProviderSessionId,
        appSessionId,
        message: `Could not compact session: ${errMsg(error)}`,
        recoverable: true,
      });
    } finally {
      if (session) await session.close().catch(ignoreError);
    }
  }

  private persistHistoricalProvider(appSessionId: string, providerSessionId: string): void {
    try {
      this.dependencies.registry.replaceProvider(appSessionId, providerSessionId);
    } catch (error) {
      this.dependencies.emitError({
        providerSessionId,
        appSessionId,
        message: `Could not persist compacted session identity: ${errMsg(error)}`,
      });
    }
  }

  private replaceProvider(
    appSessionId: string,
    providerSessionId: string,
    carryover: UsageOffset,
  ): void {
    const updated = this.dependencies.registry.replaceProvider(appSessionId, providerSessionId, {
      tokensIn: carryover.tokensIn,
      tokensOut: carryover.tokensOut,
      contextTokens: 0,
    });
    if (!updated) {
      throw new Error(`Session ${appSessionId} disappeared before its provider could be replaced.`);
    }
  }
}

const ignoreError = (): void => undefined;
