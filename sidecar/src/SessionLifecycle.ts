import {
  type AskUserHandler,
  type McpServerConfig,
  type PermissionHandler,
} from '@factory/droid-sdk';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { FactoryRuntime } from './providers/droid/DroidProviderAdapter.js';
import type { FactorySession } from './providers/droid/DroidProviderSession.js';
import { droidexUserDataDir } from './droidexPaths.js';
import type { ProviderBinding } from './persistence/SessionStore.js';
import type {
  ClientCommand,
  FactoryDefaultSettings,
  ServerEvent,
  SessionSummary,
} from './protocol.js';
import { liveBindingFromSummary, type SessionRegistry } from './SessionRegistry.js';
import type { PrimaryAutomaticCompactionTarget, SessionCompaction } from './SessionCompaction.js';
import type { LiveOperationTarget, SessionContext } from './SessionContext.js';
import type { ChildSessions } from './ChildSessions.js';
import {
  buildCreatedSessionSummary,
  buildCreateRuntimeOptions,
  buildResumedSession,
  createDefaultsModeForCommand,
  createMissionConfigurationForMode,
  errMsg,
  requireCreateConfiguration,
} from './sessionHelpers.js';
import { droidReasoningEffortFromSelection } from './providers/providerIdentity.js';
import type { ShutdownDeadline } from './providers/shutdownDeadline.js';

export type SessionCreateCommand = Extract<ClientCommand, { type: 'session.create' }>;

async function sessionRuntimeCwd(appCwd: string): Promise<string> {
  if (appCwd) return appCwd;
  const chatCwd = join(droidexUserDataDir(), 'chats');
  await mkdir(chatCwd, { recursive: true });
  return chatCwd;
}

interface LocalMcpResource {
  close(): Promise<void>;
}
interface DeferredClose {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
  started: boolean;
}
interface CloseOperation {
  deferred: DeferredClose;
  created: boolean;
}
export interface StartedLocalMcpResources {
  servers: LocalMcpResource[];
  configs: McpServerConfig[];
}
interface LiveTurnState {
  streaming: boolean;
  autoCompacting: boolean;
  pendingSends: string[];
  interruptingForSteer?: boolean;
  interrupting?: boolean; // Marks user Stop so the resulting stream abort settles quietly.
}
type SessionCloseMode = 'discard-pending' | 'preserve-pending';
export interface LiveSession extends LiveTurnState {
  summary: SessionSummary;
  binding: ProviderBinding;
  session: FactorySession;
  closeMode?: SessionCloseMode;
  closePromise?: Promise<void>;
  mcpServers: LocalMcpResource[];
  // Running MCP handles reused when compaction swaps the provider session.
  mcpConfigs: McpServerConfig[];
  todoDisabledForDesign?: boolean;
  compacting?: boolean; // Manual-compaction overlap guard; auto-compaction is separate.
  unsubscribe?: () => void; // Primary provider notification subscription, replaced on swap.
  appliedNativeConfiguration?: SessionSummary['configuration'];
}
type LifecycleError = Omit<Extract<ServerEvent, { type: 'error' }>, 'type'>;

export interface SessionLifecycleDependencies {
  runtime: FactoryRuntime;
  registry: SessionRegistry<LiveSession>;
  ensureConnected: () => void;
  getFactoryDefaults: () => Promise<FactoryDefaultSettings>;
  maxContextTokensForModel: (modelId?: string) => number | undefined;
  startLocalMcpServers: (ref: { id: string }, cwd?: string) => Promise<StartedLocalMcpResources>;
  makePermissionHandler: (ref: { id: string }) => PermissionHandler;
  makeAskUserHandler: (ref: { id: string }) => AskUserHandler;
  compaction: Pick<
    SessionCompaction,
    'resolveLimit' | 'arm' | 'subscribePrimary' | 'afterTurn' | 'cancel' | 'forgetSession'
  >;
  isShutdownStarted: () => boolean;
  childSessions: Pick<ChildSessions, 'attachParent' | 'closeParent'>;
  applyPendingSettingsToSummary: (summary: SessionSummary) => SessionSummary;
  applyPendingSessionSettings: (appSessionId: string) => Promise<boolean>;
  runPrimaryTurn: (liveSession: LiveSession, prompt: string) => Promise<void>;
  context: Pick<SessionContext, 'refresh' | 'stopPolling' | 'stopSession' | 'forgetSession'>;
  forgetInteractions: (appSessionId: string) => void;
  forgetEventFlow: (appSessionId: string) => void;
  forgetMissionControl: (appSessionId: string) => void;
  forgetPendingSettings: (appSessionId: string) => void;
  closeBrowserSession: (appSessionId: string) => Promise<void>;
  emit: (event: ServerEvent) => void;
  emitError: (error: LifecycleError) => void;
  emitStatus: (appSessionId: string, text: string) => void;
  emitSessionList: (closedProviderSessionId: string) => void | Promise<void>;
}
export class SessionLifecycle {
  private readonly deferredCloses = new WeakMap<LiveSession, DeferredClose>();
  private readonly closesById = new Map<string, LiveSession>();
  private readonly resumeOperations = new Map<string, Promise<boolean>>();
  private pendingShutdownCloses?: Array<{ liveSession: LiveSession; close: CloseOperation }>;

  constructor(private readonly dependencies: SessionLifecycleDependencies) {}
  async create(command: SessionCreateCommand): Promise<void> {
    const d = this.dependencies;
    d.ensureConnected();
    const appCwd = command.cwd ?? '';
    const ref = { id: '' };
    let pendingMcpServers: LocalMcpResource[] = [];
    let pendingSession: FactorySession | undefined;
    let pendingLiveSession: LiveSession | undefined;

    try {
      const configuration = requireCreateConfiguration(command);
      const defaults = await d.getFactoryDefaults();
      const interactionMode = configuration.interactionMode;
      const defaultsMode = createDefaultsModeForCommand(command, interactionMode);
      const primary = {
        modelId: configuration.providerSelection.modelId,
        reasoningEffort: droidReasoningEffortFromSelection(configuration.providerSelection),
      };
      const mission = createMissionConfigurationForMode(defaultsMode, command, defaults);
      const compactionModel =
        command.compactionModel ?? defaults.compactionModel ?? 'current-model';
      const compactionTokenLimit = await d.compaction.resolveLimit({
        modelId: primary.modelId,
        uiOverride: {
          ...(command.compactionTokenLimit !== undefined
            ? { compactionTokenLimit: command.compactionTokenLimit }
            : {}),
          ...(command.compactionTokenLimitPerModel !== undefined
            ? { compactionTokenLimitPerModel: command.compactionTokenLimitPerModel }
            : {}),
        },
        defaults,
      });
      const runtimeCwd = await sessionRuntimeCwd(appCwd);
      this.requireOpenAdmission();
      const mcp = await d.startLocalMcpServers(ref, appCwd);
      pendingMcpServers = mcp.servers;
      const runtimeOptions = buildCreateRuntimeOptions({
        command,
        runtimeCwd,
        configuration,
        primary,
        ...(mission !== undefined ? { mission } : {}),
        defaults,
        compactionModel,
        compactionTokenLimit,
        mcpServers: mcp.configs,
        permissionHandler: d.makePermissionHandler(ref),
        askUserHandler: d.makeAskUserHandler(ref),
      });
      const session = await d.runtime.createSession(runtimeOptions);
      pendingSession = session;
      this.requireOpenAdmission();
      const autoCompactionArmed = await d.compaction.arm(
        {
          session,
          isCurrent: () => !d.isShutdownStarted() && pendingSession === session,
        },
        compactionTokenLimit,
      );
      this.requireOpenAdmission();

      const appSessionId = session.sessionId;
      const maxContextTokens = d.maxContextTokensForModel(primary.modelId);
      const summary = buildCreatedSessionSummary({
        command,
        appSessionId,
        configuration,
        compactionModel,
        ...(mission !== undefined ? { mission } : {}),
        ...(maxContextTokens !== undefined ? { maxContextTokens } : {}),
        ...(autoCompactionArmed ? { compactionTokenLimit } : {}),
        now: Date.now(),
      });
      ref.id = appSessionId;
      const liveSession = createLiveSession(summary, session, mcp);
      liveSession.appliedNativeConfiguration = configuration;
      pendingLiveSession = liveSession;
      d.compaction.subscribePrimary(this.primaryAutomaticCompactionTarget(liveSession));
      d.registry.register(liveSession);
      d.childSessions.attachParent(appSessionId);
      d.emit({
        type: 'session.created',
        clientRef: command.clientRef,
        session: publishedSummary(d.registry, appSessionId),
      });
      this.driveInBackground(appSessionId, command.goal);
    } catch (error) {
      await this.cleanupFailedOpen(pendingMcpServers, pendingSession, pendingLiveSession);
      if (!isOpenAdmissionClosed(error)) {
        d.emitError({
          code: 'session.create_failed',
          clientRef: command.clientRef,
          message: errMsg(error),
        });
      }
    }
  }

  async resume(requestedAppSessionId: string): Promise<boolean> {
    const d = this.dependencies;
    const historical = d.registry.getCanonicalSummary(requestedAppSessionId);
    const appSessionId = historical?.appSessionId ?? requestedAppSessionId;
    const pending = this.resumeOperations.get(appSessionId);
    if (pending) return pending;

    const operation = this.resumeOnce(requestedAppSessionId).finally(() => {
      if (this.resumeOperations.get(appSessionId) === operation)
        this.resumeOperations.delete(appSessionId);
    });
    this.resumeOperations.set(appSessionId, operation);
    return operation;
  }

  private async resumeOnce(requestedAppSessionId: string): Promise<boolean> {
    const d = this.dependencies;
    d.ensureConnected();
    const historical = d.registry.getCanonicalSummary(requestedAppSessionId);
    const appSessionId = historical?.appSessionId ?? requestedAppSessionId;
    const providerSessionId = historical?.providerSessionId ?? requestedAppSessionId;
    const existing = d.registry.getLive(appSessionId);
    if (existing) {
      d.emit({
        type: 'session.created',
        clientRef: `resume:${appSessionId}`,
        session: publishedSummary(d.registry, appSessionId),
      });
      void d.context.refresh(this.primaryContextTarget(existing));
      return true;
    }

    const ref = { id: appSessionId };
    let pendingMcpServers: LocalMcpResource[] = [];
    let pendingSession: FactorySession | undefined;
    let pendingLiveSession: LiveSession | undefined;
    try {
      const mcp = await d.startLocalMcpServers(ref, historical?.cwd);
      pendingMcpServers = mcp.servers;
      const session = await d.runtime.loadSession(providerSessionId, {
        permissionHandler: d.makePermissionHandler(ref),
        askUserHandler: d.makeAskUserHandler(ref),
        cwd: historical?.cwd,
        mcpServers: mcp.configs,
      });
      pendingSession = session;
      const defaults = await d.getFactoryDefaults();
      const resumed = buildResumedSession({
        init: session.initResult,
        historical,
        appSessionId,
        providerSessionId,
        defaults,
        maxContextTokensForModel: d.maxContextTokensForModel,
        now: Date.now(),
      });
      const summary = resumed.summary;
      const projectedModel = d.applyPendingSettingsToSummary({ ...summary }).configuration
        .providerSelection.modelId;
      const limit = await d.compaction.resolveLimit({
        modelId: projectedModel,
        exposed: resumed.exposedCompaction,
      });
      this.requireOpenAdmission();
      if (
        await d.compaction.arm(
          {
            appSessionId,
            session,
            isCurrent: () => !d.isShutdownStarted() && pendingSession === session,
          },
          limit,
        )
      ) {
        summary.compactionTokenLimit = limit;
      }
      this.requireOpenAdmission();
      const liveSession = createLiveSession(summary, session, mcp);
      liveSession.appliedNativeConfiguration = summary.configuration;
      pendingLiveSession = liveSession;
      d.compaction.subscribePrimary(this.primaryAutomaticCompactionTarget(liveSession));
      d.registry.register(liveSession);
      d.childSessions.attachParent(appSessionId);
      const published = publishedSummary(d.registry, appSessionId);
      d.emit({
        type: 'session.created',
        clientRef: `resume:${appSessionId}`,
        session: published,
      });
      d.emit({ type: 'session.updated', session: published });
      if (published.sessionPurpose === 'mission-control' && published.features.length > 0) {
        d.emit({
          type: 'mission.features',
          appSessionId,
          ...(published.missionId !== undefined ? { missionId: published.missionId } : {}),
          features: published.features,
        });
      }
      void d.context.refresh(this.primaryContextTarget(liveSession));
      return true;
    } catch (error) {
      await this.cleanupFailedOpen(pendingMcpServers, pendingSession, pendingLiveSession);
      if (!isOpenAdmissionClosed(error)) d.emitError({ appSessionId, message: errMsg(error) });
      return false;
    }
  }

  async send(requestedAppSessionId: string, text: string): Promise<void> {
    const liveSession = await this.prepareToSend(requestedAppSessionId);
    if (!liveSession) return;
    if (liveSession.streaming || liveSession.compacting || liveSession.autoCompacting) {
      liveSession.pendingSends.push(text);
      this.updateQueuedSends(liveSession);
      return;
    }
    await this.drive(liveSession.summary.appSessionId, text);
  }
  async sendNow(requestedAppSessionId: string, text: string): Promise<void> {
    const liveSession = await this.prepareToSend(requestedAppSessionId);
    if (!liveSession) return;
    if (!liveSession.streaming && !liveSession.compacting && !liveSession.autoCompacting) {
      await this.drive(liveSession.summary.appSessionId, text);
      return;
    }
    liveSession.pendingSends.unshift(text);
    this.updateQueuedSends(liveSession);
    if (liveSession.compacting || liveSession.autoCompacting) return;
    liveSession.interruptingForSteer = true;
    this.dependencies.emitStatus(liveSession.summary.appSessionId, 'Steering now...');
    try {
      await liveSession.session.interrupt();
    } catch (error) {
      liveSession.interruptingForSteer = false;
      this.dependencies.emitError({
        code: 'session.send_now_failed',
        appSessionId: liveSession.summary.appSessionId,
        message: `Could not interrupt session for steering: ${errMsg(error)}`,
      });
    }
  }

  async interrupt(requestedAppSessionId: string): Promise<void> {
    const resolvedAppSessionId =
      this.dependencies.registry.getCanonicalSummary(requestedAppSessionId)?.appSessionId ??
      requestedAppSessionId;
    const liveSession = this.dependencies.registry.getLive(resolvedAppSessionId);
    if (!liveSession) return;
    const appSessionId = liveSession.summary.appSessionId;
    liveSession.pendingSends = [];
    if (liveSession.compacting) {
      // Clearing the queue mid-compaction is bookkeeping, not activity.
      this.dependencies.registry.updateSummary(
        appSessionId,
        { queuedSends: 0 },
        { touchActivity: false },
      );
      return;
    }
    const wasAutoCompacting = liveSession.autoCompacting;
    const compactionTarget = this.primaryAutomaticCompactionTarget(liveSession);
    liveSession.interrupting = true;
    try {
      await liveSession.session.interrupt();
    } catch (error) {
      liveSession.interrupting = false;
      throw error;
    }
    if (!compactionTarget.isCurrent()) {
      liveSession.interrupting = false;
      return;
    }
    if (wasAutoCompacting) {
      this.dependencies.compaction.cancel(compactionTarget);
    }
    if (!liveSession.streaming) liveSession.interrupting = false;
    this.dependencies.registry.updateSummary(appSessionId, {
      phase: 'paused',
      streaming: false,
      queuedSends: 0,
    });
  }

  async settleAfterCompaction(
    appSessionId: string,
    previousLiveSession?: LiveSession,
  ): Promise<void> {
    if (this.dependencies.isShutdownStarted()) return;
    const liveSession = this.dependencies.registry.getLive(appSessionId);
    if (!liveSession) {
      if (previousLiveSession && previousLiveSession.closeMode !== 'discard-pending') {
        const queued = previousLiveSession.pendingSends.splice(0);
        await this.redeliverQueuedSends(appSessionId, queued);
      }
      return;
    }
    if (liveSession.closeMode) return;
    if (liveSession.streaming || liveSession.compacting || liveSession.autoCompacting) return;
    const next = liveSession.pendingSends.shift();
    if (next === undefined && previousLiveSession) return;
    this.updateQueuedSends(liveSession);
    if (next !== undefined) await this.drive(liveSession.summary.appSessionId, next);
  }

  async close(appSessionId: string, mode: SessionCloseMode = 'discard-pending'): Promise<void> {
    const liveSession =
      this.dependencies.registry.getLive(appSessionId) ?? this.closesById.get(appSessionId);
    if (!liveSession) return;
    const operation = this.beginClose(liveSession, mode);
    if (operation.created) await this.finishClose(liveSession);
    await operation.deferred.promise;
  }

  /**
   * Invalidate generations, mark every live session closing, and unregister
   * them before any provider await. `closeAll` finishes the captured batch.
   */
  invalidateLiveSessions(): readonly LiveSession[] {
    if (this.pendingShutdownCloses) {
      return this.pendingShutdownCloses.map((entry) => entry.liveSession);
    }
    const snapshot = this.dependencies.registry.liveSessionsSnapshot();
    this.pendingShutdownCloses = snapshot.map((liveSession) => ({
      liveSession,
      close: this.beginClose(liveSession, 'discard-pending'),
    }));
    this.dependencies.registry.invalidateAndUnregisterLive();
    return snapshot;
  }

  private beginClose(liveSession: LiveSession, mode: SessionCloseMode): CloseOperation {
    if (mode === 'discard-pending') {
      liveSession.closeMode = mode;
      liveSession.pendingSends = [];
    } else {
      liveSession.closeMode ??= mode;
    }
    const existing = this.deferredCloses.get(liveSession);
    if (existing) return { deferred: existing, created: false };

    let resolve = (): void => undefined;
    let reject = (error: unknown): void => {
      void error;
    };
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const deferred = { promise, resolve, reject, started: false };
    this.deferredCloses.set(liveSession, deferred);
    this.closesById.set(liveSession.summary.appSessionId, liveSession);
    liveSession.closePromise = promise;
    return { deferred, created: true };
  }

  private async finishClose(liveSession: LiveSession, deadline?: ShutdownDeadline): Promise<void> {
    const deferred = this.deferredCloses.get(liveSession);
    if (!deferred || deferred.started) return;
    deferred.started = true;
    try {
      await this.closeSessionResources(liveSession, deadline);
      deferred.resolve();
    } catch (error) {
      deferred.reject(error);
    } finally {
      this.deferredCloses.delete(liveSession);
      if (this.closesById.get(liveSession.summary.appSessionId) === liveSession) {
        this.closesById.delete(liveSession.summary.appSessionId);
      }
    }
  }

  private async closeSessionResources(
    liveSession: LiveSession,
    deadline?: ShutdownDeadline,
  ): Promise<void> {
    const d = this.dependencies;
    const closedProviderSessionId = liveSession.session.sessionId;
    let firstError: unknown;
    const run = async (action: () => void | Promise<void>): Promise<void> => {
      try {
        const work = Promise.resolve().then(action);
        await (deadline ? deadline.awaitSettled(work) : work);
      } catch (error) {
        firstError ??= error;
      }
    };

    await run(() => d.childSessions.closeParent(liveSession.summary.appSessionId, deadline));
    await run(() => {
      d.context.stopSession(liveSession);
    });
    await run(() => {
      d.compaction.cancel(this.primaryAutomaticCompactionTarget(liveSession));
    });
    await run(() => {
      d.compaction.forgetSession(liveSession.summary.appSessionId);
    });
    await run(() => {
      liveSession.unsubscribe?.();
    });
    for (const server of liveSession.mcpServers) {
      await run(() => server.close());
    }
    // Shutdown already unregistered via invalidateLiveSessions. Individual
    // close keeps the live mapping until after the native await so in-flight
    // interaction callbacks can still settle against the same session.
    const stillRegistered = d.registry.getLive(liveSession.summary.appSessionId) === liveSession;
    await run(() => closeNativeSession(liveSession.session, deadline));
    await run(() => d.closeBrowserSession(liveSession.summary.appSessionId));
    await run(() => {
      d.context.forgetSession(liveSession);
    });
    let unregistered: LiveSession | undefined;
    if (stillRegistered) {
      try {
        unregistered = d.registry.unregister(liveSession.summary.appSessionId);
      } catch (error) {
        firstError ??= error;
      }
    } else {
      unregistered = liveSession;
    }
    if (unregistered) {
      await run(() => {
        d.forgetMissionControl(liveSession.summary.appSessionId);
      });
      await run(() => {
        d.forgetPendingSettings(liveSession.summary.appSessionId);
      });
      d.emit({ type: 'session.closed', appSessionId: liveSession.summary.appSessionId });
      await run(() => {
        d.forgetInteractions(liveSession.summary.appSessionId);
      });
      await run(() => {
        d.forgetEventFlow(liveSession.summary.appSessionId);
      });
    }
    await run(() => d.emitSessionList(closedProviderSessionId));
    if (firstError !== undefined) throw errorFromUnknown(firstError);
  }

  async closeAll(deadline?: ShutdownDeadline): Promise<void> {
    this.invalidateLiveSessions();
    const scheduled = this.pendingShutdownCloses ?? [];
    this.pendingShutdownCloses = undefined;
    let firstError: unknown;
    for (const { liveSession, close } of scheduled) {
      if (close.created) await this.finishClose(liveSession, deadline);
      try {
        const work = close.deferred.promise;
        await (deadline ? deadline.awaitSettled(work) : work);
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError !== undefined) throw errorFromUnknown(firstError);
  }

  private requireOpenAdmission(): void {
    if (this.dependencies.isShutdownStarted()) throw new OpenAdmissionClosedError();
  }

  private primaryContextTarget(liveSession: LiveSession): LiveOperationTarget {
    const d = this.dependencies;
    const appSessionId = liveSession.summary.appSessionId;
    const session = liveSession.session;
    return {
      appSessionId,
      providerSessionId: session.sessionId,
      sourceSessionId: appSessionId,
      session,
      isCurrent: () =>
        !d.isShutdownStarted() &&
        d.registry.getLive(appSessionId) === liveSession &&
        !liveSession.closeMode &&
        liveSession.session === session,
    };
  }

  private primaryAutomaticCompactionTarget(
    liveSession: LiveSession,
  ): PrimaryAutomaticCompactionTarget {
    return {
      ...this.primaryContextTarget(liveSession),
      kind: 'primary',
      liveSession,
    };
  }

  private async prepareToSend(requestedAppSessionId: string): Promise<LiveSession | undefined> {
    const appSessionId =
      this.dependencies.registry.getCanonicalSummary(requestedAppSessionId)?.appSessionId ??
      requestedAppSessionId;
    let liveSession = this.dependencies.registry.getLive(appSessionId);
    // A send that lands while the runtime is being released must wait for that
    // close and reopen, not vanish. Retirement makes this window reachable.
    if (liveSession?.closeMode) {
      await liveSession.closePromise;
      if (this.dependencies.isShutdownStarted()) return undefined;
      liveSession = this.dependencies.registry.getLive(appSessionId);
    }
    if (!liveSession) {
      const resumed = await this.resume(appSessionId);
      if (!resumed) return undefined;
      liveSession = this.dependencies.registry.getLive(appSessionId);
    }
    if (liveSession?.closeMode) return undefined;
    if (!liveSession) {
      const message = `Session ${appSessionId} is not resumable`;
      this.dependencies.emitError({ appSessionId, message });
      return undefined;
    }
    const settingsApplied = await this.dependencies.applyPendingSessionSettings(
      liveSession.summary.appSessionId,
    );
    return settingsApplied && !liveSession.closeMode ? liveSession : undefined;
  }

  private async cleanupFailedOpen(
    mcpServers: LocalMcpResource[],
    session: FactorySession | undefined,
    liveSession: LiveSession | undefined,
  ): Promise<void> {
    liveSession?.unsubscribe?.();
    if (liveSession)
      await runBestEffortAsync(() =>
        this.dependencies.childSessions.closeParent(liveSession.summary.appSessionId),
      );
    if (liveSession) this.dependencies.compaction.forgetSession(liveSession.summary.appSessionId);
    await Promise.all(mcpServers.map((server) => runBestEffortAsync(() => server.close())));
    if (session) await runBestEffortAsync(() => session.close());
    if (
      liveSession &&
      this.dependencies.registry.getLive(liveSession.summary.appSessionId) === liveSession
    ) {
      this.dependencies.context.forgetSession(liveSession);
      if (this.dependencies.registry.unregister(liveSession.summary.appSessionId)) {
        this.dependencies.forgetInteractions(liveSession.summary.appSessionId);
        this.dependencies.forgetEventFlow(liveSession.summary.appSessionId);
        this.dependencies.forgetMissionControl(liveSession.summary.appSessionId);
        this.dependencies.forgetPendingSettings(liveSession.summary.appSessionId);
      }
    }
  }

  private async drive(appSessionId: string, prompt: string): Promise<void> {
    const d = this.dependencies;
    const liveSession = d.registry.getLive(appSessionId);
    if (!liveSession || liveSession.closeMode || d.isShutdownStarted()) return;
    const stableAppSessionId = liveSession.summary.appSessionId;
    try {
      liveSession.streaming = true;
      // Turn start is not user-visible activity: updatedAt (sidebar order and
      // the renderer's unread marker) must not move until the turn settles,
      // otherwise background sessions read as unread while the model works.
      d.registry.updateSummary(
        stableAppSessionId,
        {
          phase: liveSession.summary.sessionPurpose === 'mission-control' ? 'planning' : 'running',
          streaming: true,
          queuedSends: liveSession.pendingSends.length,
        },
        { touchActivity: false },
      );
      await d.runPrimaryTurn(liveSession, prompt);
    } finally {
      liveSession.interruptingForSteer = false;
      liveSession.interrupting = false;
      liveSession.streaming = false;
      if (d.isShutdownStarted() || this.shouldDiscardPendingSends(liveSession)) {
        liveSession.pendingSends = [];
      } else if (!d.registry.getLive(stableAppSessionId)) {
        const queued = liveSession.pendingSends.splice(0);
        if (queued.length > 0) void this.redeliverQueuedSends(stableAppSessionId, queued);
      } else if (liveSession.autoCompacting) {
        d.compaction.afterTurn(this.primaryAutomaticCompactionTarget(liveSession));
        this.publishTurnSettled(liveSession);
      } else {
        const next = liveSession.pendingSends.shift();
        this.publishTurnSettled(liveSession);
        if (next !== undefined) this.driveInBackground(stableAppSessionId, next);
      }
    }
  }

  private driveInBackground(appSessionId: string, prompt: string): void {
    void this.drive(appSessionId, prompt).catch((error: unknown) => {
      if (!this.dependencies.isShutdownStarted())
        this.dependencies.emitError({ appSessionId, message: errMsg(error) });
    });
  }

  // Queue/steer bookkeeping: never moves updatedAt on its own.
  private updateQueuedSends(liveSession: LiveSession): void {
    this.publishTurnState(liveSession, false);
  }

  // The turn ended (completed, failed, or stopped): this is the "model has
  // finally responded" moment, so the summary's updatedAt moves now.
  private publishTurnSettled(liveSession: LiveSession): void {
    this.publishTurnState(liveSession, true);
  }

  private publishTurnState(liveSession: LiveSession, turnSettled: boolean): void {
    this.dependencies.registry.updateSummary(
      liveSession.summary.appSessionId,
      {
        streaming: liveSession.streaming,
        queuedSends: liveSession.pendingSends.length,
      },
      { touchActivity: turnSettled },
    );
  }

  private shouldDiscardPendingSends(liveSession: LiveSession): boolean {
    return liveSession.closeMode === 'discard-pending';
  }

  private async redeliverQueuedSends(appSessionId: string, queued: string[]): Promise<void> {
    for (const text of queued) {
      if (this.dependencies.isShutdownStarted()) return;
      try {
        await this.send(appSessionId, text);
      } catch (error) {
        this.dependencies.emitError({
          appSessionId,
          message: `Could not deliver a queued message after compaction recovery: ${errMsg(error)}`,
        });
      }
    }
  }
}
function closeNativeSession(
  session: { close: (...args: never[]) => Promise<void> },
  deadline?: ShutdownDeadline,
): Promise<void> {
  // ProviderSession.close takes the shared deadline; FactorySession.close
  // ignores the extra argument. Keep the call site one path.
  return (session.close as (deadline?: ShutdownDeadline) => Promise<void>)(deadline);
}

function createLiveSession(
  summary: SessionSummary,
  session: FactorySession,
  mcp: StartedLocalMcpResources,
): LiveSession {
  const base = liveBindingFromSummary(summary);
  return {
    summary,
    binding: {
      ...base,
      providerSessionId: session.sessionId,
      runtimeGeneration: base.runtimeGeneration === 0 ? 1 : base.runtimeGeneration,
    },
    session,
    streaming: false,
    pendingSends: [],
    mcpServers: mcp.servers,
    mcpConfigs: mcp.configs,
    autoCompacting: false,
  };
}

async function runBestEffortAsync(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch {
    // Cleanup continues through the remaining resources.
  }
}

class OpenAdmissionClosedError extends Error {}

function isOpenAdmissionClosed(error: unknown): boolean {
  return error instanceof OpenAdmissionClosedError;
}

function errorFromUnknown(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function publishedSummary(
  registry: SessionRegistry<LiveSession>,
  appSessionId: string,
): SessionSummary {
  const summary = registry.resolveSummary(appSessionId);
  if (!summary) throw new Error(`Session ${appSessionId} has no published summary.`);
  return summary;
}
