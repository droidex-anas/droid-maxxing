import {
  type AskUserHandler,
  type McpServerConfig,
  type PermissionHandler,
} from '@factory/droid-sdk';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { FactoryRuntime, FactorySession } from './DroidRuntime.js';
import { droidexUserDataDir } from './droidexPaths.js';
import type {
  ClientCommand,
  FactoryDefaultSettings,
  ServerEvent,
  SessionSummary,
} from './protocol.js';
import type { SessionRegistry } from './SessionRegistry.js';
import type { PrimaryAutomaticCompactionTarget, SessionCompaction } from './SessionCompaction.js';
import type { LiveOperationTarget, SessionContext } from './SessionContext.js';
import type { ChildSessions } from './ChildSessions.js';
import type { AgentProcessMonitor } from './processes/AgentProcessMonitor.js';
import {
  buildCreatedSessionSummary,
  buildCreateRuntimeOptions,
  buildResumedSession,
  createDefaultsModeForCommand,
  createInteractionModeForCommand,
  createMissionAgentDefaultsForMode,
  createModelDefaultsForMode,
  errMsg,
  requireAutonomyForCommand,
} from './sessionHelpers.js';

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
  retryFailedOpen?: boolean;
  retryTimer?: ReturnType<typeof setTimeout>;
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
  session: FactorySession;
  closeMode?: SessionCloseMode;
  closePromise?: Promise<void>;
  mcpServers: LocalMcpResource[];
  // Running MCP handles reused when compaction swaps the provider session.
  mcpConfigs: McpServerConfig[];
  todoDisabledForDesign?: boolean;
  compacting?: boolean; // Manual-compaction overlap guard; auto-compaction is separate.
  unsubscribe?: () => void; // Primary provider notification subscription, replaced on swap.
}
type LifecycleError = Omit<Extract<ServerEvent, { type: 'error' }>, 'type'>;

export interface SessionLifecycleDependencies {
  runtime: FactoryRuntime;
  registry: SessionRegistry<LiveSession>;
  ensureConnected: () => void;
  getFactoryDefaults: () => Promise<FactoryDefaultSettings>;
  maxContextTokensForModel: (modelId?: string) => number | undefined;
  startLocalMcpServers: (
    ref: { id: string; clientRef?: string },
    cwd?: string,
  ) => Promise<StartedLocalMcpResources>;
  makePermissionHandler: (ref: { id: string }) => PermissionHandler;
  makeAskUserHandler: (ref: { id: string }) => AskUserHandler;
  compaction: Pick<
    SessionCompaction,
    'resolveLimit' | 'arm' | 'subscribePrimary' | 'afterTurn' | 'cancel' | 'forgetSession'
  >;
  isShutdownStarted: () => boolean;
  childSessions: Pick<ChildSessions, 'attachParent' | 'closeParent'>;
  agentProcesses: Pick<
    AgentProcessMonitor,
    'track' | 'untrack' | 'killSession' | 'setIgnoredCommands'
  >;
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
  private readonly resumeOperations = new Map<string, Promise<boolean>>();

  constructor(private readonly dependencies: SessionLifecycleDependencies) {}
  async create(command: SessionCreateCommand): Promise<void> {
    const d = this.dependencies;
    d.ensureConnected();
    const appCwd = command.cwd ?? '';
    const ref = { id: '', clientRef: command.clientRef };
    let pendingMcpServers: LocalMcpResource[] = [];
    let pendingSession: FactorySession | undefined;
    let pendingLiveSession: LiveSession | undefined;

    try {
      // Validate the required autonomy snapshot before any slow or fallible
      // discovery work so a missing snapshot always gets its own diagnostic.
      const autonomy = requireAutonomyForCommand(command);
      const defaults = await d.getFactoryDefaults();
      const interactionMode = createInteractionModeForCommand(command, defaults);
      const defaultsMode = createDefaultsModeForCommand(command, interactionMode);
      const primary = createModelDefaultsForMode(defaultsMode, command, defaults);
      const agents = createMissionAgentDefaultsForMode(defaultsMode, command, defaults);
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
        interactionMode,
        primary,
        agents,
        defaults,
        autonomy,
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
        interactionMode,
        primary,
        compactionModel,
        agents,
        autonomy,
        ...(maxContextTokens !== undefined ? { maxContextTokens } : {}),
        ...(autoCompactionArmed ? { compactionTokenLimit } : {}),
        now: Date.now(),
      });
      ref.id = appSessionId;
      const liveSession = createLiveSession(summary, session, mcp);
      pendingLiveSession = liveSession;
      d.compaction.subscribePrimary(this.primaryAutomaticCompactionTarget(liveSession));
      d.registry.register(liveSession);
      this.trackProviderProcess(appSessionId, session, mcp.configs);
      d.childSessions.attachParent(appSessionId);
      d.emit({ type: 'session.created', clientRef: command.clientRef, session: summary });
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
      const projectedSummary =
        d.registry.resolveSummary(appSessionId) ??
        d.applyPendingSettingsToSummary({ ...existing.summary });
      d.emit({
        type: 'session.created',
        clientRef: `resume:${appSessionId}`,
        session: projectedSummary,
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
      const projectedModel = d.applyPendingSettingsToSummary({ ...summary }).modelId;
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
      const projectedSummary = d.applyPendingSettingsToSummary({ ...summary });
      const liveSession = createLiveSession(summary, session, mcp);
      pendingLiveSession = liveSession;
      d.compaction.subscribePrimary(this.primaryAutomaticCompactionTarget(liveSession));
      d.registry.register(liveSession);
      this.trackProviderProcess(appSessionId, session, mcp.configs);
      d.childSessions.attachParent(appSessionId);
      d.emit({
        type: 'session.created',
        clientRef: `resume:${appSessionId}`,
        session: projectedSummary,
      });
      d.emit({ type: 'session.updated', session: projectedSummary });
      if (
        projectedSummary.sessionPurpose === 'mission-control' &&
        projectedSummary.features.length > 0
      ) {
        d.emit({
          type: 'mission.features',
          appSessionId,
          ...(projectedSummary.missionId !== undefined
            ? { missionId: projectedSummary.missionId }
            : {}),
          features: projectedSummary.features,
        });
      }
      void d.context.refresh(this.primaryContextTarget(liveSession));
      return true;
    } catch (error) {
      await this.cleanupFailedOpen(pendingMcpServers, pendingSession, pendingLiveSession);
      if (!isOpenAdmissionClosed(error))
        d.emitError({ appSessionId, providerSessionId, message: errMsg(error) });
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
    const liveSession = this.dependencies.registry.getLive(requestedAppSessionId);
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
    const liveSession = this.dependencies.registry.getLive(appSessionId);
    if (!liveSession) return;
    const operation = this.beginClose(liveSession, mode);
    if (operation.created || operation.deferred.retryTimer) await this.finishClose(liveSession);
    await operation.deferred.promise;
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
    liveSession.closePromise = promise;
    return { deferred, created: true };
  }

  private async finishClose(liveSession: LiveSession): Promise<void> {
    const deferred = this.deferredCloses.get(liveSession);
    if (!deferred || deferred.started) return;
    clearTimeout(deferred.retryTimer);
    deferred.started = true;
    try {
      await this.closeSessionResources(liveSession);
      deferred.resolve();
    } catch (error) {
      if (this.dependencies.registry.getLive(liveSession.summary.appSessionId) === liveSession) {
        if (deferred.retryFailedOpen && !this.dependencies.isShutdownStarted()) {
          if (!deferred.retryTimer)
            console.warn(`Failed-open provider cleanup deferred: ${errMsg(error)}`);
          deferred.started = false;
          deferred.retryTimer = setTimeout(() => {
            void this.finishClose(liveSession);
          }, 5000);
          deferred.retryTimer.unref();
          return;
        }
        liveSession.closeMode = undefined;
        liveSession.closePromise = undefined;
      }
      deferred.reject(error);
    } finally {
      if (deferred.started) this.deferredCloses.delete(liveSession);
    }
  }

  private async closeSessionResources(liveSession: LiveSession): Promise<void> {
    const d = this.dependencies;
    const closedProviderSessionId = liveSession.session.sessionId;
    let firstError: unknown;
    const run = async (action: () => void | Promise<void>): Promise<void> => {
      try {
        await action();
      } catch (error) {
        firstError ??= error;
      }
    };

    // First, while every provider process of this session is still alive and
    // still the parent of what it spawned: the dev servers are descendants of
    // `droid`, and once it exits they are reparented to launchd and no longer
    // reachable from its pid. Child runtimes are tracked under this same
    // session id, so this takes their servers too.
    await d.agentProcesses.killSession(liveSession.summary.appSessionId);
    await run(() => d.childSessions.closeParent(liveSession.summary.appSessionId));
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
    await run(() => liveSession.session.close());
    const processId = d.runtime.processIdOf(liveSession.session);
    if (processId !== undefined)
      d.agentProcesses.untrack(processId, liveSession.summary.appSessionId);
    await run(() => d.closeBrowserSession(liveSession.summary.appSessionId));
    await run(() => {
      d.context.forgetSession(liveSession);
    });
    let unregistered: LiveSession | undefined;
    try {
      unregistered = d.registry.unregister(liveSession.summary.appSessionId);
    } catch (error) {
      firstError ??= error;
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

  async closeAll(): Promise<void> {
    if (this.dependencies.isShutdownStarted()) {
      for (const liveSession of this.dependencies.registry.liveSessionsSnapshot())
        clearTimeout(this.deferredCloses.get(liveSession)?.retryTimer);
    }
    // One concurrent kill pass before the serialized closes. Each close kills
    // its own processes too (idempotent, and the only owner when a single
    // session closes), but paying the kill grace one session at a time would
    // overrun the sidecar's force-exit budget and leave the last session's
    // dev server running — and its history unflushed.
    const live = this.dependencies.registry
      .liveSessionsSnapshot()
      .map((liveSession) => liveSession.summary.appSessionId);
    const killed = await Promise.allSettled(
      live.map((id) => this.dependencies.agentProcesses.killSession(id)),
    );
    const failed = new Set(live.filter((_id, index) => killed[index].status === 'rejected'));
    let firstError: unknown = killed.find((result) => result.status === 'rejected')?.reason;
    // Re-read: the kill pass awaited, so the live set may have moved.
    const scheduled = this.dependencies.registry
      .liveSessionsSnapshot()
      .filter((liveSession) => !failed.has(liveSession.summary.appSessionId))
      .map((liveSession) => ({
        liveSession,
        close: this.beginClose(liveSession, 'discard-pending'),
      }));
    for (const { liveSession, close } of scheduled) {
      if (close.created || close.deferred.retryTimer) await this.finishClose(liveSession);
      try {
        await close.deferred.promise;
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError !== undefined) throw errorFromUnknown(firstError);
  }

  // Every live provider process of a session must be a tracked root, so the
  // monitor can find (and later kill) whatever that process spawns.
  private trackProviderProcess(
    appSessionId: string,
    session: FactorySession,
    mcpConfigs: readonly McpServerConfig[],
  ): void {
    const d = this.dependencies;
    // Before the first scan, so a configured MCP server never reaches the chip.
    d.agentProcesses.setIgnoredCommands(appSessionId, stdioMcpCommandLines(mcpConfigs));
    const processId = d.runtime.processIdOf(session);
    if (processId !== undefined) d.agentProcesses.track(appSessionId, processId);
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

  private async prepareToSend(appSessionId: string): Promise<LiveSession | undefined> {
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
    if (
      liveSession &&
      this.dependencies.registry.getLive(liveSession.summary.appSessionId) === liveSession
    ) {
      const { deferred } = this.beginClose(liveSession, 'discard-pending');
      deferred.retryFailedOpen = true;
      void deferred.promise.catch((error: unknown) => {
        console.warn(`Failed-open provider cleanup failed: ${errMsg(error)}`);
      });
      await this.finishClose(liveSession);
      return;
    }
    if (liveSession) {
      liveSession.closeMode = 'discard-pending';
      try {
        await this.dependencies.agentProcesses.killSession(liveSession.summary.appSessionId);
      } catch (error) {
        liveSession.closeMode = undefined;
        console.warn(`Failed-open provider cleanup deferred: ${errMsg(error)}`);
        return;
      }
    }
    liveSession?.unsubscribe?.();
    if (liveSession)
      await runBestEffortAsync(() =>
        this.dependencies.childSessions.closeParent(liveSession.summary.appSessionId),
      );
    if (liveSession) this.dependencies.compaction.forgetSession(liveSession.summary.appSessionId);
    await Promise.all(mcpServers.map((server) => runBestEffortAsync(() => server.close())));
    if (session) {
      const processId = this.dependencies.runtime.processIdOf(session);
      await runBestEffortAsync(() => session.close());
      if (processId !== undefined && liveSession)
        this.dependencies.agentProcesses.untrack(processId, liveSession.summary.appSessionId);
    }
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
      // Persist resumed activity immediately so the chat stays near the top
      // even if the app closes mid-turn. The renderer suppresses unread while
      // streaming; completion advances the timestamp again for review.
      d.registry.updateSummary(stableAppSessionId, {
        phase: liveSession.summary.sessionPurpose === 'mission-control' ? 'planning' : 'running',
        streaming: true,
        queuedSends: liveSession.pendingSends.length,
      });
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
function createLiveSession(
  summary: SessionSummary,
  session: FactorySession,
  mcp: StartedLocalMcpResources,
): LiveSession {
  return {
    summary,
    session,
    streaming: false,
    pendingSends: [],
    mcpServers: mcp.servers,
    mcpConfigs: mcp.configs,
    autoCompacting: false,
  };
}

// The command line `droid` spawns for each stdio MCP server, in the shape a
// process table prints it.
function stdioMcpCommandLines(configs: readonly McpServerConfig[]): string[] {
  return configs.flatMap((config) =>
    'command' in config ? [[config.command, ...config.args].join(' ')] : [],
  );
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
