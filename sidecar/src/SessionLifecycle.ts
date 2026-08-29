import { randomUUID } from 'node:crypto';
import type { ProviderBinding, SessionStore } from './persistence/SessionStore.js';
import { persistBindingUpdated } from './providerBinding.js';
import type { TranscriptStore } from './persistence/TranscriptStore.js';
import type {
  ClientCommand,
  FactoryDefaultSettings,
  ServerEvent,
  SessionConfiguration,
  SessionSummary,
} from './protocol.js';
import type { SessionRegistry } from './SessionRegistry.js';
import type { SessionCompaction } from './SessionCompaction.js';
import type { ChildSessions } from './ChildSessions.js';
import { errMsg, type SessionInitResult } from './sessionHelpers.js';
import type { DroidMissionConfiguration } from './providers/providerIdentity.js';
import {
  type ProviderInteractionSink,
  type ProviderPrompt,
  type ProviderSession,
} from './providers/providerTypes.js';
import type { ProviderRuntimeEvent } from './providers/providerEvents.js';
import type { ProviderEventAdmissionLive } from './providers/providerEvents.js';
import type { ProviderRegistry } from './providers/ProviderRegistry.js';
import { ShutdownDeadline } from './providers/shutdownDeadline.js';
import type { SessionEventFlow } from './SessionEventFlow.js';
import {
  createAppSession,
  resumeAppSession,
  type SessionOpenHost,
} from './sessionLifecycleOpen.js';

export type SessionCreateCommand = Extract<ClientCommand, { type: 'session.create' }>;

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
  servers: Array<{ close(): Promise<void> }>;
  configs: unknown[];
}

export interface LiveNativeSession {
  readonly sessionId: string;
  readonly initResult?: SessionInitResult;
  interrupt(): Promise<void>;
  close(): Promise<unknown>;
  onNotification(handler: (notification: Record<string, unknown>) => void): () => void;
  updateSettings(settings: Record<string, unknown>): Promise<unknown>;
}

interface LiveTurnState {
  streaming: boolean;
  autoCompacting: boolean;
  pendingSends: string[];
  interruptingForSteer?: boolean;
  interrupting?: boolean;
  activeTurn?: { turnId: string; runtimeGeneration: number };
}
type SessionCloseMode = 'discard-pending' | 'preserve-pending';
export interface LiveSession extends LiveTurnState {
  summary: SessionSummary;
  binding: ProviderBinding;
  session: LiveNativeSession;
  provider: ProviderSession;
  closeMode?: SessionCloseMode;
  closePromise?: Promise<void>;
  mcpServers: Array<{ close(): Promise<void> }>;
  mcpConfigs: unknown[];
  todoDisabledForDesign?: boolean;
  compacting?: boolean;
  unsubscribe?: () => void;
  appliedNativeConfiguration?: SessionSummary['configuration'];
  acceptProviderEvents?: boolean;
}
type LifecycleError = Omit<Extract<ServerEvent, { type: 'error' }>, 'type'>;

export interface ProviderOpenHint {
  command?: SessionCreateCommand;
  configuration: SessionConfiguration;
  defaults: FactoryDefaultSettings;
  compactionModel: string;
  compactionTokenLimit: number;
  sessionPurpose?: SessionSummary['sessionPurpose'];
  mission?: DroidMissionConfiguration;
}

export interface SessionLifecycleDependencies {
  providers: ProviderRegistry;
  registry: SessionRegistry<LiveSession>;
  ensureConnected: () => void;
  getFactoryDefaults: () => Promise<FactoryDefaultSettings>;
  maxContextTokensForModel: (modelId?: string) => number | undefined;
  takeOpenedResources?: (provider: ProviderSession) => StartedLocalMcpResources;
  prepareProviderOpen?: (hint: ProviderOpenHint) => void;
  interactionSink: ProviderInteractionSink;
  eventFlow: Pick<SessionEventFlow, 'apply' | 'beginTurn'>;
  sessionStore?: Pick<
    SessionStore,
    | 'createProvisional'
    | 'bindInitialProviderRuntime'
    | 'updateResumeState'
    | 'replaceProviderRuntime'
    | 'get'
  >;
  transcriptStore?: Pick<TranscriptStore, 'beginTurn' | 'settleTurn'>;
  nextId?: () => string;
  compaction: {
    resolveLimit: SessionCompaction['resolveLimit'];
    arm: (
      target: { session: LiveNativeSession; isCurrent(): boolean; appSessionId?: string },
      limit: number,
    ) => Promise<boolean>;
    subscribePrimary: (liveSession: LiveSession) => void;
    afterTurn: (liveSession: LiveSession) => void;
    cancel: (liveSession: LiveSession) => void;
    forgetSession: (appSessionId: string) => void;
  };
  isShutdownStarted: () => boolean;
  childSessions: Pick<ChildSessions, 'attachParent' | 'closeParent'>;
  applyPendingSettingsToSummary: (summary: SessionSummary) => SessionSummary;
  applyPendingSessionSettings: (appSessionId: string) => Promise<boolean>;
  preparePrimaryTurn: (liveSession: LiveSession, prompt: string) => Promise<boolean>;
  finishPrimaryTurn: (liveSession: LiveSession, error?: unknown) => Promise<void>;
  context: {
    refresh: (liveSession: LiveSession) => void | Promise<void>;
    stopSession: (liveSession: LiveSession) => void;
    forgetSession: (liveSession: LiveSession) => void;
  };
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

const EMPTY_PROMPT_PARTS: Pick<ProviderPrompt, 'skills' | 'files' | 'browserRefs'> = {
  skills: [],
  files: [],
  browserRefs: [],
};

export class SessionLifecycle {
  private readonly deferredCloses = new WeakMap<LiveSession, DeferredClose>();
  private readonly closesById = new Map<string, LiveSession>();
  private readonly resumeOperations = new Map<string, Promise<boolean>>();
  private readonly appCommands = new Map<string, Promise<unknown>>();
  private readonly turnWaiters = new Map<
    string,
    { resolve: (error?: unknown) => void; settled: boolean }
  >();
  private readonly discardedOpens = new Set<string>();
  private pendingShutdownCloses?: Array<{ liveSession: LiveSession; close: CloseOperation }>;

  constructor(private readonly dependencies: SessionLifecycleDependencies) {}

  async create(command: SessionCreateCommand): Promise<void> {
    return createAppSession(this.openHost(), command);
  }

  async resume(requestedAppSessionId: string): Promise<boolean> {
    const historical = this.dependencies.registry.getCanonicalSummary(requestedAppSessionId);
    const appSessionId = historical?.appSessionId ?? requestedAppSessionId;
    const pending = this.resumeOperations.get(appSessionId);
    if (pending) return pending;
    const operation = resumeAppSession(this.openHost(), requestedAppSessionId).finally(() => {
      if (this.resumeOperations.get(appSessionId) === operation)
        this.resumeOperations.delete(appSessionId);
    });
    this.resumeOperations.set(appSessionId, operation);
    return operation;
  }

  async send(requestedAppSessionId: string, text: string): Promise<void> {
    let turn: Promise<void> | undefined;
    await this.enqueueApp(requestedAppSessionId, async () => {
      const liveSession = await this.prepareToSend(requestedAppSessionId);
      if (!liveSession) return;
      if (liveSession.streaming || liveSession.compacting || liveSession.autoCompacting) {
        liveSession.pendingSends.push(text);
        this.updateQueuedSends(liveSession);
        return;
      }
      liveSession.streaming = true;
      turn = this.drive(liveSession.summary.appSessionId, text);
    });
    if (turn) await turn;
  }

  async sendNow(requestedAppSessionId: string, text: string): Promise<void> {
    let turn: Promise<void> | undefined;
    await this.enqueueApp(requestedAppSessionId, async () => {
      const liveSession = await this.prepareToSend(requestedAppSessionId);
      if (!liveSession) return;
      if (!liveSession.streaming && !liveSession.compacting && !liveSession.autoCompacting) {
        liveSession.streaming = true;
        turn = this.drive(liveSession.summary.appSessionId, text);
        return;
      }
      liveSession.pendingSends.unshift(text);
      this.updateQueuedSends(liveSession);
      if (liveSession.compacting || liveSession.autoCompacting) return;
      liveSession.interruptingForSteer = true;
      this.dependencies.emitStatus(liveSession.summary.appSessionId, 'Steering now...');
      try {
        await this.interruptCaptured(liveSession);
      } catch (error) {
        liveSession.interruptingForSteer = false;
        this.dependencies.emitError({
          code: 'session.send_now_failed',
          appSessionId: liveSession.summary.appSessionId,
          message: `Could not interrupt session for steering: ${errMsg(error)}`,
        });
      }
    });
    if (turn) await turn;
  }

  async interrupt(requestedAppSessionId: string): Promise<void> {
    return this.enqueueApp(requestedAppSessionId, async () => {
      const resolvedAppSessionId =
        this.dependencies.registry.getCanonicalSummary(requestedAppSessionId)?.appSessionId ??
        requestedAppSessionId;
      const liveSession = this.dependencies.registry.getLive(resolvedAppSessionId);
      if (!liveSession) return;
      const appSessionId = liveSession.summary.appSessionId;
      liveSession.pendingSends = [];
      if (liveSession.compacting) {
        this.dependencies.registry.updateSummary(
          appSessionId,
          { queuedSends: 0 },
          { touchActivity: false },
        );
        return;
      }
      const wasAutoCompacting = liveSession.autoCompacting;
      liveSession.interrupting = true;
      try {
        await this.interruptCaptured(liveSession);
      } catch (error) {
        liveSession.interrupting = false;
        throw error;
      }
      if (this.dependencies.registry.getLive(appSessionId) !== liveSession || liveSession.closeMode) {
        liveSession.interrupting = false;
        return;
      }
      if (wasAutoCompacting) this.dependencies.compaction.cancel(liveSession);
      if (!liveSession.streaming) liveSession.interrupting = false;
      this.dependencies.registry.updateSummary(appSessionId, {
        phase: 'paused',
        streaming: false,
        queuedSends: 0,
      });
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
    if (mode === 'discard-pending') this.discardedOpens.add(appSessionId);
    const liveSession =
      this.dependencies.registry.getLive(appSessionId) ?? this.closesById.get(appSessionId);
    if (!liveSession) return;
    const operation = this.beginClose(liveSession, mode);
    if (operation.created) await this.finishClose(liveSession);
    await operation.deferred.promise;
  }

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
    const closedProviderSessionId = liveSession.provider.providerSessionId;
    if (d.registry.getLive(liveSession.summary.appSessionId) === liveSession) {
      this.invalidateGeneration(liveSession);
    }
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
      d.compaction.cancel(liveSession);
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
    const stillRegistered = d.registry.getLive(liveSession.summary.appSessionId) === liveSession;
    await run(() => liveSession.provider.close(deadline ?? zeroDeadline()));
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

  handleProviderEvent(liveSession: LiveSession, event: ProviderRuntimeEvent): void {
    if (event.type === 'binding.updated') {
      const next = persistBindingUpdated(
        this.dependencies.sessionStore,
        event,
        liveSession.binding,
      );
      if (!next) return;
      liveSession.binding = next;
      return;
    }
    if (!liveSession.acceptProviderEvents) return;
    if (event.type === 'turn.settled') this.settleCapturedTurn(liveSession, event);
    this.dependencies.eventFlow.apply(event, this.admissionLive(liveSession));
  }

  private openHost(): SessionOpenHost {
    return {
      dependencies: this.dependencies,
      discardedOpens: this.discardedOpens,
      handleProviderEvent: (liveSession, event) => this.handleProviderEvent(liveSession, event),
      nextId: () => this.nextId(),
      driveInBackground: (appSessionId, prompt) => this.driveInBackground(appSessionId, prompt),
      cleanupFailedOpen: (provider, liveSession) => this.cleanupFailedOpen(provider, liveSession),
    };
  }

  private async prepareToSend(requestedAppSessionId: string): Promise<LiveSession | undefined> {
    const appSessionId =
      this.dependencies.registry.getCanonicalSummary(requestedAppSessionId)?.appSessionId ??
      requestedAppSessionId;
    let liveSession = this.dependencies.registry.getLive(appSessionId);
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
      this.dependencies.emitError({
        appSessionId,
        message: `Session ${appSessionId} is not resumable`,
      });
      return undefined;
    }
    const settingsApplied = await this.dependencies.applyPendingSessionSettings(
      liveSession.summary.appSessionId,
    );
    return settingsApplied && !liveSession.closeMode ? liveSession : undefined;
  }

  private async cleanupFailedOpen(
    provider: ProviderSession | undefined,
    liveSession: LiveSession | undefined,
  ): Promise<void> {
    liveSession?.unsubscribe?.();
    if (liveSession)
      await runBestEffortAsync(() =>
        this.dependencies.childSessions.closeParent(liveSession.summary.appSessionId),
      );
    if (liveSession) this.dependencies.compaction.forgetSession(liveSession.summary.appSessionId);
    const leftover = provider
      ? (this.dependencies.takeOpenedResources?.(provider) ?? { servers: [], configs: [] })
      : { servers: [], configs: [] };
    await Promise.all(
      [...(liveSession?.mcpServers ?? []), ...leftover.servers].map((server) =>
        runBestEffortAsync(() => server.close()),
      ),
    );
    if (provider) await runBestEffortAsync(() => provider.close(zeroDeadline()));
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
    let turnError: unknown;
    liveSession.streaming = true;
    try {
      d.registry.updateSummary(
        stableAppSessionId,
        {
          phase: liveSession.summary.sessionPurpose === 'mission-control' ? 'planning' : 'running',
          streaming: true,
          queuedSends: liveSession.pendingSends.length,
        },
        { touchActivity: false },
      );
      try {
        const prepared = await d.preparePrimaryTurn(liveSession, prompt);
        if (!prepared || d.registry.getLive(stableAppSessionId) !== liveSession) return;
        const turnId = this.nextId();
        const runtimeGeneration = liveSession.binding.runtimeGeneration;
        liveSession.activeTurn = { turnId, runtimeGeneration };
        d.transcriptStore?.beginTurn({
          turnId,
          target: { kind: 'session', appSessionId: stableAppSessionId },
          runtimeGeneration,
          startedAt: new Date().toISOString(),
        });
        const settled = this.armTurnWaiter(stableAppSessionId, turnId);
        await liveSession.provider.startTurn({
          turnId,
          prompt: { text: prompt, ...EMPTY_PROMPT_PARTS },
          configuration: liveSession.summary.configuration,
        });
        turnError = await settled;
      } catch (error) {
        turnError = error;
      }
    } finally {
      liveSession.interruptingForSteer = false;
      liveSession.interrupting = false;
      liveSession.streaming = false;
      liveSession.activeTurn = undefined;
      await d.finishPrimaryTurn(liveSession, turnError);
      if (d.isShutdownStarted() || liveSession.closeMode === 'discard-pending') {
        liveSession.pendingSends = [];
      } else if (!d.registry.getLive(stableAppSessionId)) {
        const queued = liveSession.pendingSends.splice(0);
        if (queued.length > 0) void this.redeliverQueuedSends(stableAppSessionId, queued);
      } else if (liveSession.autoCompacting) {
        d.compaction.afterTurn(liveSession);
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

  private updateQueuedSends(liveSession: LiveSession): void {
    this.publishTurnState(liveSession, false);
  }

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

  private async interruptCaptured(liveSession: LiveSession): Promise<void> {
    const captured = liveSession.activeTurn;
    if (captured) {
      if (captured.runtimeGeneration !== liveSession.binding.runtimeGeneration) {
        throw new Error('interrupt generation does not match the live session');
      }
      await liveSession.provider.interrupt({
        turnId: captured.turnId,
        runtimeGeneration: captured.runtimeGeneration,
      });
      return;
    }
    await liveSession.session.interrupt();
  }

  private settleCapturedTurn(
    liveSession: LiveSession,
    event: Extract<ProviderRuntimeEvent, { type: 'turn.settled' }>,
  ): void {
    const turnId = event.turnId ?? liveSession.activeTurn?.turnId;
    if (turnId === undefined) return;
    this.dependencies.transcriptStore?.settleTurn(turnId, {
      runtimeGeneration: event.runtimeGeneration,
      status: event.settlement.status,
      settledAt: new Date(event.createdAt).toISOString(),
    });
    const waiter = this.turnWaiters.get(turnKey(liveSession.summary.appSessionId, turnId));
    if (waiter && !waiter.settled) {
      waiter.settled = true;
      waiter.resolve(
        event.settlement.status === 'failed'
          ? new Error(event.settlement.error.message)
          : undefined,
      );
    }
  }

  private armTurnWaiter(appSessionId: string, turnId: string): Promise<unknown> {
    const key = turnKey(appSessionId, turnId);
    return new Promise((resolve) => {
      this.turnWaiters.set(key, { resolve, settled: false });
    }).finally(() => {
      this.turnWaiters.delete(key);
    });
  }

  private admissionLive(liveSession: LiveSession): ProviderEventAdmissionLive {
    return {
      target: { kind: 'session', appSessionId: liveSession.summary.appSessionId },
      providerDriverKind: liveSession.binding.providerDriverKind,
      providerInstanceId: liveSession.binding.providerInstanceId,
      runtimeGeneration: liveSession.binding.runtimeGeneration,
      settledTurnIds: new Set<string>(),
    };
  }

  private enqueueApp<T>(requestedAppSessionId: string, work: () => Promise<T>): Promise<T> {
    const appSessionId =
      this.dependencies.registry.getCanonicalSummary(requestedAppSessionId)?.appSessionId ??
      requestedAppSessionId;
    const previous = this.appCommands.get(appSessionId) ?? Promise.resolve();
    const next = previous.then(work, work);
    this.appCommands.set(appSessionId, next);
    return next.finally(() => {
      if (this.appCommands.get(appSessionId) === next) this.appCommands.delete(appSessionId);
    });
  }

  private invalidateGeneration(liveSession: LiveSession): void {
    liveSession.binding = {
      ...liveSession.binding,
      runtimeGeneration: liveSession.binding.runtimeGeneration + 1,
    };
  }

  private nextId(): string {
    return this.dependencies.nextId?.() ?? randomUUID();
  }
}

function zeroDeadline(): ShutdownDeadline {
  return ShutdownDeadline.fromDurationMs(0);
}

function turnKey(appSessionId: string, turnId: string): string {
  return `${appSessionId}:${turnId}`;
}

async function runBestEffortAsync(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch {
    // Cleanup continues through the remaining resources.
  }
}

function errorFromUnknown(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
