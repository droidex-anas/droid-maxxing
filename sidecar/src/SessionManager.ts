import { randomUUID } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import type {
  Autonomy,
  BridgeRuntimeSnapshot,
  ClientCommand,
  ConfigurableSessionRole,
  FactoryDefaultSettings,
  InstallChannel,
  HistorySearchReply,
  PersistenceRecovery,
  SessionSummary,
  ModelInfo,
  ReasoningEffort,
  ServerEvent,
  SessionInteractionMode,
  TranscriptEvent,
} from './protocol.js';
import {
  defaultsModeForSummary,
  errMsg,
  isUserCancellation,
  modelDefaultForMode,
  normalizeAutonomy,
  reasoningValue,
  type SessionInitResult,
} from './sessionHelpers.js';
import {
  assertDroidMissionConfigurationAllowed,
  droidReasoningEffortFromSelection,
  parseSessionConfiguration,
  withProviderSelection,
  type SessionConfiguration,
} from './providers/providerIdentity.js';
import { boundedInt } from './values.js';
import { type McpServerConfig } from './providers/droid/DroidModeMapping.js';
import {
  DroidProviderAdapter,
  DroidRuntime,
  queueDroidOpenFromHint,
  takeDroidOpenedMcp,
  type FactoryRuntime,
} from './providers/droid/DroidProviderAdapter.js';
import {
  attachCompactionArmDroid,
  emitHostDroidCatalogUpdate,
  managerPrimaryTargets,
  requireLiveBrowserCapability,
  requireLiveDroidCapability,
  requireMcpManagementCapability,
  snapshotProviderCapabilities,
  withHostDroidSession,
  type SessionDroidHost,
} from './providers/droid/droidSessionAccess.js';
import { detectEnvironment } from './Environment.js';
import { buildInstallCommand, buildUpdateCommand, runStreaming } from './CliInstaller.js';
import {
  type HistoryIndex,
  type PersistedChildSession,
  loadMissionControlSessions,
  readFactoryDefaults,
} from './history.js';
import { HistoryPersistence } from './HistoryPersistence.js';
import { serverEventForHistoryStatus } from './historyStatusEvents.js';
import { LiveRuntimeJournal, liveRuntimeJournalPath } from './liveRuntimeJournal.js';
import { SessionAdoption } from './sessionAdoption.js';
import { buildRuntimeSnapshot } from './runtimeSnapshot.js';
import { droidexUserDataDir } from './droidexPaths.js';
import type { SessionFileChange } from './sessionFileCache.js';
import { SessionBrowser, type SessionBrowsers } from './SessionBrowser.js';
import { SessionHistoryQueries } from './SessionHistoryQueries.js';
import {
  startSessionFileWatcher,
  type SessionFileWatcher,
  type SessionFileWatcherOptions,
} from './sessionFileWatcher.js';
import { SessionFileServing } from './SessionFileServing.js';
import { mergeModelCatalog } from './modelCatalog.js';
import { readDroidCliModelCatalog, readDroidCliModelCatalogCache } from './DroidCliCatalog.js';
import { BrowserSessionManager } from './browser/BrowserSessionManager.js';
import { createBrowserMcpServer } from './browser/browserMcpServer.js';
import { isDesignPrompt } from './browser/designPromptPacks.js';
import { SessionRegistry } from './SessionRegistry.js';
import { projectWireSessionSummary } from './sessionRegistryProjection.js';
import { SessionEventFlow, type NormalizedSideEffects } from './SessionEventFlow.js';
import { DroidEventFlow } from './providers/droid/DroidEventFlow.js';
import { SessionInteractions } from './SessionInteractions.js';
import { DroidInteractions } from './providers/droid/DroidInteractions.js';
import { isReportedStreamingTranscriptError, SessionTimeline } from './SessionTimeline.js';
import { SessionContext } from './SessionContext.js';
import {
  SessionCompaction,
  type AutoCompactionSettlement,
  type AutomaticCompactionTarget,
  type CompactionResourceKey,
  type CompactionRetuneTarget,
} from './SessionCompaction.js';
import {
  SessionLifecycle,
  type LiveSession,
  type StartedLocalMcpResources,
} from './SessionLifecycle.js';
import { hasSessionCloseStarted } from './sessionLifecycleOpen.js';
import { ChildSessions } from './ChildSessions.js';
import type { ChildSettings } from './ChildSessionState.js';
import { CHILD_RUNTIME_IDLE_RETIREMENT_MS } from './childRuntimeRetirement.js';
import {
  SESSION_RUNTIME_IDLE_RETIREMENT_MS,
  SessionRuntimeRetirement,
} from './sessionRuntimeRetirement.js';
import { MissionControlPolicy } from './MissionControlPolicy.js';
import { normalizeCompactionTokenLimit } from './compaction.js';
import type { HotPathResourceCounts } from './telemetry/hotPathMetrics.js';
import { DroidMcpConfiguration, type McpConfiguration } from './DroidMcpConfiguration.js';
import { McpSettings } from './McpSettings.js';
import { loadFactoryMcpServers } from './FactoryMcpConfig.js';
import { formatResponsePrompt } from './appPrompt.js';
import { SIDECAR_SHUTDOWN_BUDGET_MS, ShutdownDeadline } from './providers/shutdownDeadline.js';
import {
  createDefaultProviderRegistry,
  type ProviderRegistry,
} from './providers/ProviderRegistry.js';
import type { DroidexDatabase } from './persistence/DroidexDatabase.js';
import { bindCanonicalStoresForManager } from './sessionCanonicalPersistence.js';
import type { SessionCreatePersistence } from './sessionCreateIdentity.js';

type Emit = (event: ServerEvent) => void;

type SessionHistoryBase = Pick<
  HistoryIndex,
  | 'summaryPatchesAndHidden'
  | 'listHistoricalSessions'
  | 'sessionFileCacheSize'
  | 'sessionLaunchSettings'
  | 'childSessions'
  | 'childSession'
  | 'close'
> & {
  syncSummaries(summaries: SessionSummary[]): boolean | undefined;
  upsertChildSession(child: PersistedChildSession): boolean | undefined;
  recordEvent(event: TranscriptEvent): void;
  persistenceRecovery?(): PersistenceRecovery;
};

type SessionHistory = SessionHistoryBase & {
  searchSessions(query: string, isStale?: () => boolean): Promise<HistorySearchReply>;
  setIndexingIdle(isIdle: boolean): Promise<void>;
  reconcileSessionFiles(): Promise<number>;
  reconcileSessionFilePaths(changes: SessionFileChange[]): Promise<number>;
};

export interface StartableLocalMcpResource {
  start(): Promise<McpServerConfig>;
  close(): Promise<void>;
}

export interface SessionManagerDependencies extends SessionCreatePersistence {
  runtime: FactoryRuntime;
  history: SessionHistory;
  browsers: SessionBrowsers;
  createLocalMcpResource: (appSessionId: () => string) => StartableLocalMcpResource;
  mcpConfiguration: McpConfiguration;
  loadConfiguredMcpServers: (cwd: string) => McpServerConfig[];
  getFactoryDefaults?: () => Promise<FactoryDefaultSettings>;
  nextChildSessionId?: () => string;
  // Injectable so tests can capture the republish callback instead of
  // watching the real sessions directory. Defaults to a no-op when other
  // dependencies are faked.
  startSessionFileWatcher?: (options: SessionFileWatcherOptions) => SessionFileWatcher | null;
  // Injectable so integration tests can disable (0) the timer-based streaming
  // delta coalescing and assert appended events synchronously; the merge
  // behavior itself is covered by SessionTimeline unit tests.
  streamingCoalesceMs?: number;
  maxLiveRuntimes?: number;
  maxQueuedRuntimes?: number;
  childRuntimeIdleMs?: number;
  sessionRuntimeIdleMs?: number;
  providerRegistry?: ProviderRegistry;
  database?: Pick<DroidexDatabase, 'close'>;
  nextAppSessionId?: SessionCreatePersistence['nextAppSessionId'];
  nextTurnId?: SessionCreatePersistence['nextTurnId'];
  onCreateBoundary?: SessionCreatePersistence['onCreateBoundary'];
}

export interface SessionManagerOptions {
  assetUrlFor?: (path: string) => string;
  dependencies?: SessionManagerDependencies;
  initialModels?: ModelInfo[];
}

export interface AgentSettingPatch {
  modelId?: string | null;
  reasoningEffort?: ReasoningEffort;
}

const MAX_OPEN_CHILD_SESSIONS = boundedInt(
  process.env.DROID_CONTROL_MAX_OPEN_CHILD_SESSIONS,
  4,
  1,
  24,
);
const MAX_LIVE_CHILD_RUNTIMES = boundedInt(
  process.env.DROID_CONTROL_MAX_LIVE_CHILD_RUNTIMES,
  MAX_OPEN_CHILD_SESSIONS,
  1,
  MAX_OPEN_CHILD_SESSIONS,
);
const MAX_QUEUED_CHILD_RUNTIMES = boundedInt(
  process.env.DROID_CONTROL_MAX_QUEUED_CHILD_RUNTIMES,
  16,
  0,
  64,
);
// Production runtime limits. The overrides exist so tests can drive admission,
// queueing, and retirement without waiting on a clock.
function runtimeLimits(dependencies: SessionManagerDependencies | undefined) {
  return {
    maxLiveRuntimes: dependencies?.maxLiveRuntimes ?? MAX_LIVE_CHILD_RUNTIMES,
    maxQueuedRuntimes: dependencies?.maxQueuedRuntimes ?? MAX_QUEUED_CHILD_RUNTIMES,
    childRuntimeIdleMs: dependencies?.childRuntimeIdleMs ?? CHILD_RUNTIME_IDLE_RETIREMENT_MS,
    sessionRuntimeIdleMs: dependencies?.sessionRuntimeIdleMs ?? SESSION_RUNTIME_IDLE_RETIREMENT_MS,
  };
}

const ignoreError = (): undefined => undefined;

const nextChildSessionId = () => `child-${randomUUID()}`;

export class SessionManager {
  private ready = false;
  private cachedModels: ModelInfo[] | null = null;
  private modelRefresh: Promise<ModelInfo[] | null> | null = null;
  // Context windows observed from provider stats for catalog-missing models.
  private readonly learnedModelContextWindows = new Map<string, number>();
  private readonly runtime: FactoryRuntime;
  private readonly history: SessionHistory;
  private readonly registry: SessionRegistry<LiveSession>;
  private readonly timeline: SessionTimeline;
  private readonly interactions: SessionInteractions;
  private readonly droidInteractions: DroidInteractions;
  private readonly eventFlow: SessionEventFlow;
  private readonly droidEventFlow: DroidEventFlow;
  private readonly context: SessionContext;
  private readonly compaction: SessionCompaction;
  private readonly childSessions: ChildSessions;
  private readonly missionControlPolicy: MissionControlPolicy;
  private readonly lifecycle: SessionLifecycle;
  private readonly runtimeRetirement: SessionRuntimeRetirement;
  private readonly adoption: SessionAdoption;
  private readonly sessionFiles: SessionFileServing;
  private readonly sessionBrowser: SessionBrowser;
  private readonly historyQueries: SessionHistoryQueries;
  private readonly pendingAgentSettings = new Map<
    string,
    Partial<Record<ConfigurableSessionRole, AgentSettingPatch>>
  >();
  private shutdownPromise?: Promise<void>;
  private readonly browsers: SessionBrowsers;
  private readonly createLocalMcpResource: SessionManagerDependencies['createLocalMcpResource'];
  private readonly mcpConfiguration: McpConfiguration;
  private readonly loadConfiguredMcpServers: SessionManagerDependencies['loadConfiguredMcpServers'];
  private readonly mcpSettings: McpSettings;
  private readonly factoryDefaultsOverride: SessionManagerDependencies['getFactoryDefaults'];
  private readonly nextChildSessionId: () => string;
  private readonly providerRegistry: ProviderRegistry;
  private readonly droid: SessionDroidHost;
  private readonly database?: Pick<DroidexDatabase, 'close'>;

  constructor(
    private readonly emit: Emit,
    options: SessionManagerOptions = {},
  ) {
    const limits = runtimeLimits(options.dependencies);
    let startWatcher: (
      options: SessionFileWatcherOptions,
    ) => ReturnType<typeof startSessionFileWatcher>;
    if (options.dependencies) {
      this.runtime = options.dependencies.runtime;
      this.history = options.dependencies.history;
      this.browsers = options.dependencies.browsers;
      this.createLocalMcpResource = options.dependencies.createLocalMcpResource;
      this.mcpConfiguration = options.dependencies.mcpConfiguration;
      this.loadConfiguredMcpServers = options.dependencies.loadConfiguredMcpServers;
      this.factoryDefaultsOverride = options.dependencies.getFactoryDefaults;
      this.nextChildSessionId = options.dependencies.nextChildSessionId ?? nextChildSessionId;
      startWatcher = options.dependencies.startSessionFileWatcher ?? (() => null);
    } else {
      this.runtime = new DroidRuntime();
      this.history = new HistoryPersistence({
        onStatusChanged: (status) => {
          this.emit(serverEventForHistoryStatus(status));
        },
        onDurabilityRecovered: () => {
          if (this.shutdownPromise) return;
          this.registry.retryPendingDurability();
          this.childSessions.retryPendingDurability();
        },
      });
      const browsers = new BrowserSessionManager({
        assetUrlFor: options.assetUrlFor,
        emit: (event) => {
          this.emit(event);
        },
        runtimeFactory: (browserSessionId, viewport, appSessionId) =>
          this.sessionBrowser.createRuntime(browserSessionId, viewport, appSessionId),
      });
      this.browsers = browsers;
      this.createLocalMcpResource = (appSessionId) =>
        createBrowserMcpServer(browsers, appSessionId);
      this.mcpConfiguration = new DroidMcpConfiguration();
      this.loadConfiguredMcpServers = loadFactoryMcpServers;
      this.factoryDefaultsOverride = undefined;
      this.nextChildSessionId = nextChildSessionId;
      startWatcher = startSessionFileWatcher;
    }
    const canonical = bindCanonicalStoresForManager(options.dependencies, this);
    this.database = canonical.database;
    this.providerRegistry =
      options.dependencies?.providerRegistry ??
      createDefaultProviderRegistry({
        droid: () =>
          new DroidProviderAdapter({
            runtime: this.runtime,
            startLocalMcpServers: (ref, cwd) => this.startLocalMcpServers(ref, cwd),
            makePermissionHandler: (ref) => this.droidInteractions.makePermissionHandler(ref),
            makeAskUserHandler: (ref) => this.droidInteractions.makeAskUserHandler(ref),
          }),
      });
    this.cachedModels = options.initialModels ? [...options.initialModels] : null;
    this.mcpSettings = new McpSettings(
      (cwd) => {
        const sessionCwd = cwd ?? tmpdir();
        return this.runtime.createSession({
          cwd: sessionCwd,
          interactionMode: 'auto',
          autonomyLevel: 'low',
          mcpServers: this.loadConfiguredMcpServers(sessionCwd),
        });
      },
      this.mcpConfiguration,
      (event) => {
        this.emit(event);
      },
    );
    this.registry = new SessionRegistry({
      history: this.history,
      loadOrdinarySessions: (options) => this.history.listHistoricalSessions(options),
      loadMissionControlSessions,
      projectSummary: (summary) => this.applyPendingSettingsToSummary({ ...summary }),
      onSummaryUpdated: (summary) => {
        this.emit({ type: 'session.updated', session: summary });
        this.runtimeRetirement.arm();
      },
      onLiveProviderReplaced: (providerSessionId) => {
        this.sessionFiles.finalizeReplacedProvider(providerSessionId);
      },
      onLiveSetChanged: () => {
        this.adoption.persistLiveSet();
        this.runtimeRetirement.arm();
      },
      now: Date.now,
    });
    this.droid = {
      getLive: (id) => this.registry.getLive(id),
      resolveSummary: (id) => this.registry.resolveSummary(id),
      firstLive: () => this.registry.liveSessionsSnapshot().at(0),
      snapshotCapabilities: (id) => snapshotProviderCapabilities(this.providerRegistry, id),
      loadSession: (id) => this.runtime.loadSession(id),
      createCatalogSession: () =>
        this.runtime.createSession({
          cwd: tmpdir(),
          interactionMode: 'auto',
          autonomyLevel: 'low',
        }),
    };
    this.historyQueries = new SessionHistoryQueries({
      searchSessions: (query, isStale) => this.history.searchSessions(query, isStale),
      resolveSummary: (id) => this.registry.resolveSummary(id),
      emit: (event) => {
        this.emit(event);
      },
    });
    this.context = new SessionContext({
      registry: this.registry,
      emit: (event) => {
        this.emit(event);
      },
      maxContextTokensForSummary: (summary) => this.maxContextTokensForSummary(summary),
      noteContextWindow: (modelId, contextWindowTokens) => {
        this.noteModelContextWindow(modelId, contextWindowTokens);
      },
    });
    this.timeline = new SessionTimeline({
      registry: this.registry,
      history: this.history,
      getChildSessions: (appSessionId) => this.childSessions.list(appSessionId),
      emit: (event) => {
        this.emit(event);
      },
      emitError: (error) => {
        this.emitError(error);
      },
      now: Date.now,
      ...(options.dependencies?.streamingCoalesceMs !== undefined
        ? { streamingCoalesceMs: options.dependencies.streamingCoalesceMs }
        : {}),
    });
    this.interactions = new SessionInteractions({
      emit: (event) => {
        this.emit(event);
      },
      emitError: (error) => {
        this.emitError(error);
      },
    });
    this.droidInteractions = new DroidInteractions({
      sink: this.interactions,
      getLiveSession: (id) => {
        const live = this.registry.getLive(id);
        if (!live) return undefined;
        return {
          summary: live.summary,
          provider: live.provider,
          binding: live.binding,
          session: live.session,
          runtimeGeneration: live.binding.runtimeGeneration,
          markConfigurationApplied: () => {
            live.appliedNativeConfiguration = live.summary.configuration;
          },
        };
      },
      updateSummary: (id, patch) => {
        this.registry.updateSummary(id, patch);
      },
      emitError: (error) => {
        this.emitError(error);
      },
    });
    this.compaction = new SessionCompaction({
      registry: this.registry,
      context: this.context,
      timeline: this.timeline,
      runtime: this.runtime,
      makePermissionHandler: (ref) => this.droidInteractions.makePermissionHandler(ref),
      makeAskUserHandler: (ref) => this.droidInteractions.makeAskUserHandler(ref),
      emitError: (error) => {
        this.emitError(error);
      },
      isShutdownStarted: () => this.shutdownPromise !== undefined,
      getFactoryDefaults: () => this.getFactoryDefaults(),
      maxContextTokensForModel: (modelId) => this.maxContextTokensForModel(modelId),
      resolveAutomaticTarget: (key) => this.resolveAutomaticCompactionTarget(key),
      settleAutomatic: (settlement) => {
        this.settleAutomaticCompaction(settlement);
      },
      onPrimaryNotification: (target, notification) => {
        this.droidEventFlow.applyNotification(
          target.appSessionId,
          target.providerSessionId,
          'primary',
          notification,
        );
      },
    });
    this.eventFlow = new SessionEventFlow({
      appendTranscript: (event) => {
        this.timeline.appendStreaming(event);
      },
      flushTranscript: (appSessionId, sourceSessionId) => {
        this.timeline.flushStreamingFor(appSessionId, sourceSessionId);
      },
      applySideEffects: (appSessionId, sideEffects) => {
        this.applyEventSideEffects(appSessionId, sideEffects);
      },
      recordUsage: (appSessionId, sourceProviderSessionId, usage) => {
        this.context.recordUsage(appSessionId, sourceProviderSessionId, usage);
      },
    });
    this.droidEventFlow = new DroidEventFlow(this.eventFlow);
    this.childSessions = new ChildSessions({
      runtime: this.runtime,
      registry: this.registry,
      history: this.history,
      timeline: this.timeline,
      eventFlow: this.droidEventFlow,
      interactions: this.droidInteractions,
      context: this.context,
      compaction: this.compaction,
      resolveDefaultSettings: (summary, initResult, role) =>
        this.resolveChildDefaultSettings(summary, initResult, role),
      isShutdownStarted: () => this.shutdownPromise !== undefined,
      emit: (event) => {
        this.emit(event);
        if (event.type !== 'session.child') return;
        this.adoption.persistLiveSet();
        this.runtimeRetirement.arm();
      },
      nextChildSessionId: this.nextChildSessionId,
      maxOpenSessions: MAX_OPEN_CHILD_SESSIONS,
      maxLiveRuntimes: limits.maxLiveRuntimes,
      maxQueuedRuntimes: limits.maxQueuedRuntimes,
      childRuntimeIdleMs: limits.childRuntimeIdleMs,
      now: Date.now,
    });
    this.sessionFiles = new SessionFileServing({
      history: this.history,
      startWatcher,
      isLiveSession: (providerSessionId) => this.registry.isCurrentLiveProvider(providerSessionId),
      isShutdownStarted: () => this.shutdownPromise !== undefined,
      retryPendingLaunchSettings: (providerSessionIds) => {
        this.childSessions.retryPendingLaunchSettings(providerSessionIds);
      },
      listSummaries: (listOptions) => this.registry.listSummaries(listOptions),
      emitList: ({ sessions, earlierSessionsByCwd }) => {
        this.emit({ type: 'sessions.list', sessions, earlierSessionsByCwd });
      },
    });
    this.missionControlPolicy = new MissionControlPolicy({
      registry: this.registry,
      childSessions: this.childSessions,
      resolveCatalogDefaultSettings: () => this.resolveCatalogDefaultSettings(),
      emit: (event) => {
        this.emit(event);
      },
    });
    this.lifecycle = new SessionLifecycle({
      providers: this.providerRegistry,
      registry: this.registry,
      ensureConnected: () => {
        if (!this.ready) this.connect();
      },
      getFactoryDefaults: () => this.getFactoryDefaults(),
      maxContextTokensForModel: (modelId) => this.maxContextTokensForModel(modelId),
      takeOpenedResources: (provider) =>
        takeDroidOpenedMcp(provider) ?? { servers: [], configs: [] },
      prepareProviderOpen: (hint) => {
        queueDroidOpenFromHint(
          this.providerRegistry.resolve(hint.configuration.providerSelection.providerInstanceId),
          hint.appSessionId,
          hint,
        );
      },
      interactionSink: this.interactions,
      eventFlow: this.eventFlow,
      ...canonical.lifecycle,
      compaction: {
        resolveLimit: (request) => this.compaction.resolveLimit(request),
        arm: (target, limit) =>
          this.compaction.arm(
            attachCompactionArmDroid({
              ...target,
              live: target.appSessionId ? this.registry.getLive(target.appSessionId) : undefined,
              snapshotCapabilities: this.droid.snapshotCapabilities,
            }),
            limit,
          ),
        subscribePrimary: (liveSession) =>
          this.compaction.subscribePrimary(this.primaryTargets(liveSession).automatic),
        afterTurn: (liveSession) =>
          this.compaction.afterTurn(this.primaryTargets(liveSession).automatic),
        cancel: (liveSession) => this.compaction.cancel(this.primaryTargets(liveSession).automatic),
        forgetSession: (appSessionId) => this.compaction.forgetSession(appSessionId),
      },
      isShutdownStarted: () => this.shutdownPromise !== undefined,
      childSessions: this.childSessions,
      applyPendingSettingsToSummary: (summary) => this.applyPendingSettingsToSummary(summary),
      applyPendingSessionSettings: (appSessionId) => this.applyPendingSessionSettings(appSessionId),
      preparePrimaryTurn: (liveSession, prompt) => this.preparePrimaryTurn(liveSession, prompt),
      finishPrimaryTurn: (liveSession, error) => this.finishPrimaryTurn(liveSession, error),
      context: {
        refresh: (liveSession) => this.context.refresh(this.primaryTargets(liveSession).context),
        stopSession: (liveSession) => this.context.stopSession(liveSession),
        forgetSession: (liveSession) => this.context.forgetSession(liveSession),
      },
      forgetInteractions: (appSessionId) => {
        this.interactions.forgetSession(appSessionId);
        this.droidInteractions.forgetSession(appSessionId);
      },
      forgetEventFlow: (appSessionId) => {
        this.eventFlow.forgetSession(appSessionId);
      },
      forgetMissionControl: (appSessionId) => {
        this.missionControlPolicy.forget(appSessionId);
      },
      forgetPendingSettings: (appSessionId) => {
        this.pendingAgentSettings.delete(appSessionId);
      },
      closeBrowserSession: (appSessionId) => this.browsers.close(appSessionId),
      emit: (event) => {
        this.emit(event);
      },
      emitError: (error) => {
        this.emitError(error);
      },
      emitStatus: (appSessionId, text) => {
        this.timeline.appendStatus(appSessionId, text);
      },
      emitSessionList: async (closedProviderSessionId) => {
        await this.sessionFiles.finalizeClosedProvider(closedProviderSessionId);
      },
    });
    this.runtimeRetirement = new SessionRuntimeRetirement({
      liveSessions: () => this.registry.liveSessionsSnapshot(),
      focusedAppSessionId: () => this.context.focusedSession(),
      hasUnsettledChildren: (id) => this.childSessions.hasUnsettledChildren(id),
      hasOpenBrowser: (id) => this.browsers.hasSession(id),
      hasPendingSettings: (id) => this.pendingAgentSettings.has(id),
      retire: (id) => this.lifecycle.close(id, 'preserve-pending'),
      emitStatus: (id, text) => {
        this.timeline.appendStatus(id, text);
      },
      emitError: (appSessionId, message) => {
        this.emitError({ appSessionId, message });
      },
      idleMs: limits.sessionRuntimeIdleMs,
      now: Date.now,
    });
    this.adoption = new SessionAdoption({
      journal: new LiveRuntimeJournal(liveRuntimeJournalPath(droidexUserDataDir())),
      registry: this.registry,
      lifecycle: this.lifecycle,
      liveChildren: () =>
        this.childSessions.liveChildSummaries().map((child) => ({
          parentAppSessionId: child.parentAppSessionId,
          childSessionId: child.childSessionId,
          status: child.status,
        })),
      persistSummaries: (summaries) => {
        this.history.syncSummaries(summaries);
        for (const session of summaries) {
          this.emit({
            type: 'session.updated',
            session: projectWireSessionSummary(session, (item) =>
              this.applyPendingSettingsToSummary({ ...item }),
            ),
          });
        }
      },
      emitStatus: (appSessionId, text) => {
        this.timeline.appendStatus(appSessionId, text);
      },
      sessionRuntimeIdleMs: limits.sessionRuntimeIdleMs,
      now: Date.now,
    });
    this.sessionBrowser = new SessionBrowser({
      browsers: this.browsers,
      emit: (event) => {
        this.emit(event);
      },
      sendPrompt: (appSessionId, prompt) => this.lifecycle.send(appSessionId, prompt),
    });
  }

  startSessionFileServing(): void {
    this.sessionFiles.start();
  }

  connect(apiKey?: string): void {
    this.runtime.connect(apiKey);
    this.ready = true;
    void this.adoption.adopt();
    this.emit({ type: 'connection', status: 'connected' });
    this.emit({ type: 'runtime.updated', status: this.runtime.status() });
    const recovery = this.history.persistenceRecovery?.();
    if (recovery?.hadUnflushedWork) {
      this.emit({
        type: 'error',
        code: 'history.unflushed_work',
        message:
          recovery.message ??
          'The previous agent runtime exited with unflushed history. Restored sessions use the last durable snapshot.',
        recoverable: true,
      });
    }
  }

  async runtimeSnapshot(): Promise<BridgeRuntimeSnapshot> {
    await this.adoption.adopt();
    const persistence = this.history.persistenceRecovery?.() ?? {
      durable: true,
      hadUnflushedWork: false,
    };
    return buildRuntimeSnapshot({
      runtime: this.runtime.status(),
      sessions: this.registry.liveSessionsSnapshot().map((live) => ({ ...live.summary })),
      children: this.childSessions.liveChildSummaries(),
      persistence,
      interrupted: [...this.adoption.records()],
    });
  }

  // Runs on its own idle timer; exposed so callers can force the sweep.
  retireIdleSessionRuntimes(): Promise<void> {
    return this.runtimeRetirement.sweep();
  }

  resourceCounts(): HotPathResourceCounts {
    const children = this.childSessions.counts();
    const pollers = this.context.pollerCounts();
    return {
      livePrimarySessions: this.registry.liveCount,
      childAgentsTotal: children.total,
      childAgentsActive: children.active,
      childAgentsLive: children.live,
      childAgentsQueued: children.queued,
      contextPollers: pollers.total,
      contextPollersActive: pollers.active,
      autoCompactionWatchdogs: this.compaction.watchdogCount(),
      sessionFileWatchers: this.sessionFiles.watcherCount(),
    };
  }

  // eslint-disable-next-line complexity -- Public command dispatch is intentionally unchanged in PR 3.
  async handle(cmd: ClientCommand): Promise<void> {
    if (this.shutdownPromise) throw new Error('Session manager is shutting down.');
    switch (cmd.type) {
      case 'connect':
        this.connect(cmd.apiKey);
        return;
      case 'runtime.status':
      case 'auth.status':
        this.emit({ type: 'runtime.updated', status: this.runtime.status() });
        return;
      case 'env.detect':
        await this.emitEnvironment();
        return;
      case 'cli.install':
        await this.runCliInstall(cmd.channel);
        return;
      case 'cli.update':
        await this.runCliUpdate(cmd.channel);
        return;
      case 'catalog.models': {
        const models = await this.getModels();
        this.emit({ type: 'catalog.updated', catalog: 'models', items: models });
        void this.refreshModelCatalog(true);
        return;
      }
      case 'catalog.tools':
        await emitHostDroidCatalogUpdate(
          this.droid,
          (event) => this.emit(event),
          'listTools',
          cmd.appSessionId,
          cmd.providerInstanceId,
        );
        return;
      case 'catalog.skills':
        await emitHostDroidCatalogUpdate(
          this.droid,
          (event) => this.emit(event),
          'listSkills',
          cmd.appSessionId,
          cmd.providerInstanceId,
        );
        return;
      case 'mcp.list':
      case 'mcp.add':
      case 'mcp.remove':
      case 'mcp.toggle':
      case 'mcp.authenticate':
        if (!this.ready) this.connect();
        requireMcpManagementCapability(
          this.registry.liveSessionsSnapshot().at(0),
          this.droid.snapshotCapabilities,
        );
        await this.mcpSettings.handle(cmd);
        return;
      case 'settings.defaults':
        this.emitFactoryDefaults();
        return;
      case 'session.create':
        await this.lifecycle.create({
          ...cmd,
          goal: formatResponsePrompt(cmd.goal, cmd.responseFormat),
        });
        return;
      case 'session.send':
        await this.lifecycle.send(
          cmd.appSessionId,
          formatResponsePrompt(cmd.text, cmd.responseFormat),
        );
        return;
      case 'session.sendNow':
        await this.lifecycle.sendNow(
          cmd.appSessionId,
          formatResponsePrompt(cmd.text, cmd.responseFormat),
        );
        return;
      case 'approval.respond':
        this.interactions.respondToApproval(cmd.appSessionId, cmd.requestId, cmd.outcome);
        await this.droidInteractions.drain();
        return;
      case 'question.respond':
        this.interactions.respondToQuestion(
          cmd.appSessionId,
          cmd.requestId,
          cmd.cancelled,
          cmd.answers,
        );
        await this.droidInteractions.drain();
        return;
      case 'plan_review.respond':
        this.interactions.respondToPlanReview(cmd.appSessionId, cmd.requestId, {
          decision: cmd.decision,
          ...(cmd.feedback !== undefined ? { feedback: cmd.feedback } : {}),
        });
        return;
      case 'session.interrupt':
        await this.lifecycle.interrupt(cmd.appSessionId);
        return;
      case 'child.open':
        await this.childSessions.open(cmd);
        return;
      case 'child.send':
        await this.childSessions.send(cmd, formatResponsePrompt(cmd.text, cmd.responseFormat));
        return;
      case 'child.sendNow':
        await this.childSessions.sendNow(cmd, formatResponsePrompt(cmd.text, cmd.responseFormat));
        return;
      case 'child.interrupt':
        await this.childSessions.interrupt(cmd);
        return;
      case 'child.loadHistory':
        await this.sessionFiles.whenBootReconciled();
        await this.childSessions.loadHistory(cmd);
        return;
      case 'child.updateSettings':
        await this.childSessions.updateSettings(cmd);
        return;
      case 'session.updateSettings':
        this.replaceSessionConfiguration(cmd.appSessionId, cmd.configuration);
        return;
      case 'session.compact': {
        await this.compactSession(cmd.appSessionId, cmd.customInstructions);
        return;
      }
      case 'session.fork':
        await withHostDroidSession(this.droid, cmd.appSessionId, 'fork', 'forkSession', (droid) =>
          droid.forkSession(),
        );
        return;
      case 'session.rename':
        await this.renameSession(cmd.appSessionId, cmd.title);
        return;
      case 'session.exportMarkdown':
        this.historyQueries.exportMarkdown(cmd);
        return;
      case 'sessions.reanchorCwd':
        try {
          const sessions = this.registry.reanchorHistoricalCwd(cmd.fromCwd, cmd.toCwd);
          this.emit({
            type: 'sessions.cwdReanchored',
            requestId: cmd.requestId,
            ok: true,
            count: sessions.length,
          });
        } catch (error) {
          this.emit({
            type: 'sessions.cwdReanchored',
            requestId: cmd.requestId,
            ok: false,
            count: 0,
            message: errMsg(error),
          });
        }
        return;
      case 'session.rewindInfo':
        await withHostDroidSession(
          this.droid,
          cmd.appSessionId,
          'rewind',
          'getRewindInfo',
          (droid) => droid.getRewindInfo({} as never),
        );
        return;
      case 'session.rewind':
        await withHostDroidSession(
          this.droid,
          cmd.appSessionId,
          'rewind',
          'executeRewind',
          (droid) => droid.executeRewind({ rewindId: cmd.rewindId } as never),
        );
        return;
      case 'session.resume':
        await this.lifecycle.resume(cmd.appSessionId);
        return;
      case 'session.close':
        await this.lifecycle.close(cmd.appSessionId);
        return;
      case 'sessions.list':
        await this.sessionFiles.list(cmd);
        return;
      case 'session.loadHistory':
        await this.sessionFiles.whenBootReconciled();
        this.timeline.load(cmd.appSessionId, cmd.cursor, cmd.limit);
        return;
      case 'sessions.search':
        await this.historyQueries.search(cmd);
        return;
      case 'history.indexingIdle':
        await this.history.setIndexingIdle(cmd.isIdle);
        return;
      case 'app.backgroundWork': {
        const previouslyFocused = this.context.focusedSession();
        this.context.setBackgroundWork(cmd.tier, cmd.focusedAppSessionId);
        this.runtimeRetirement.noteFocus(previouslyFocused);
        return;
      }
      case 'settings.agent.update':
        await this.updateAgentSettings(cmd);
        return;
      case 'settings.compaction.update':
        await this.compaction.updateLimits(cmd, this.compactionRetuneTargets());
        return;
      case 'browser.open':
        requireLiveBrowserCapability(
          cmd.appSessionId ? this.registry.getLive(cmd.appSessionId) : undefined,
          'browser.open',
          this.droid.snapshotCapabilities,
        );
        await this.sessionBrowser.open(cmd);
        return;
      case 'browser.close':
        await this.sessionBrowser.close(cmd);
        // Closing the last resource a session was holding can make it retirable.
        this.runtimeRetirement.arm();
        return;
      case 'browser.reload':
        await this.sessionBrowser.reload(cmd);
        return;
      case 'browser.refresh':
        await this.sessionBrowser.refresh(cmd);
        return;
      case 'browser.resizeViewport':
        await this.sessionBrowser.resizeViewport(cmd);
        return;
      case 'browser.click':
        await this.sessionBrowser.click(cmd);
        return;
      case 'browser.type':
        await this.sessionBrowser.type(cmd);
        return;
      case 'browser.keypress':
        await this.sessionBrowser.keypress(cmd);
        return;
      case 'browser.scroll':
        await this.sessionBrowser.scroll(cmd);
        return;
      case 'browser.screenshot':
        await this.sessionBrowser.screenshot(cmd);
        return;
      case 'browser.inspectPoint':
        await this.sessionBrowser.inspectPoint(cmd);
        return;
      case 'browser.design.addReference':
        await this.sessionBrowser.addReference(cmd);
        return;
      case 'browser.design.sendPrompt':
        await this.sessionBrowser.sendDesignPrompt(cmd);
        return;
      case 'browser.native.result':
        this.sessionBrowser.resolveNativeBrowserRequest(cmd.result);
        return;
      default: {
        // Wire commands are JSON-parsed without runtime validation, so a
        // renderer running newer code than this sidecar (e.g. a dev app that
        // kept running across a sidecar rebuild) can send a command this
        // build does not know. Fail visibly instead of falling through
        // silently while the caller waits out its timeout.
        const unknown = cmd as { type?: unknown; requestId?: unknown };
        const commandType = typeof unknown.type === 'string' ? unknown.type : 'unknown';
        // Echo the command's requestId so a waiter rejects only for its own
        // unsupported command, not a foreign one failing concurrently.
        const requestId = typeof unknown.requestId === 'string' ? unknown.requestId : undefined;
        this.emit({
          type: 'error',
          code: 'bridge.unsupported_command',
          ...(requestId !== undefined ? { requestId } : {}),
          message: `This DROIDEX build does not support the "${commandType}" command. Restart the app to pick up the current sidecar.`,
        });
        return;
      }
    }
  }

  private async getModels(): Promise<ModelInfo[]> {
    if (this.cachedModels) return this.cachedModels;
    const droidPath = this.runtime.status().droidPath;
    const cached = readDroidCliModelCatalogCache(droidPath);
    if (cached.length > 0) {
      this.cachedModels = mergeModelCatalog(cached);
      return this.cachedModels;
    }
    return (await this.refreshModelCatalog(false)) ?? [];
  }

  private refreshModelCatalog(emit: boolean): Promise<ModelInfo[] | null> {
    if (this.modelRefresh) return this.modelRefresh;
    this.modelRefresh = (async () => {
      try {
        const models = mergeModelCatalog(
          await readDroidCliModelCatalog(this.runtime.status().droidPath),
        );
        this.cachedModels = models;
        if (emit) this.emit({ type: 'catalog.updated', catalog: 'models', items: models });
        return models;
      } catch (err) {
        this.emitError({ message: `catalog.models failed: ${errMsg(err)}` });
        return null;
      } finally {
        this.modelRefresh = null;
      }
    })();
    return this.modelRefresh;
  }

  private async emitEnvironment(): Promise<void> {
    const report = await detectEnvironment(this.runtime.status().apiKeyConfigured);
    this.emit({ type: 'env.report', report });
  }

  private async runCliInstall(channel: InstallChannel): Promise<void> {
    const cmd = buildInstallCommand(channel);
    const exitCode = await runStreaming(cmd, ({ stream, line }) => {
      this.emit({ type: 'cli.install.progress', phase: 'install', stream, line });
    });
    this.emit({ type: 'cli.install.done', phase: 'install', ok: exitCode === 0, exitCode });
    this.emit({ type: 'runtime.updated', status: this.runtime.status() });
    await this.emitEnvironment();
  }

  private async runCliUpdate(channel?: InstallChannel): Promise<void> {
    const status = this.runtime.status();
    const env = await detectEnvironment(status.apiKeyConfigured);
    // status.droidPath can be a bare `droid` name that relies on PATH, which
    // GUI-launched apps don't populate (packaged builds), so spawning it
    // fails outright. env.cli.path is the absolute executable detection just
    // verified — use it as the update command's target.
    const cmd = buildUpdateCommand(channel, env.cli.path, env.cli.present);
    const exitCode = await runStreaming(cmd, ({ stream, line }) => {
      this.emit({ type: 'cli.install.progress', phase: 'update', stream, line });
    });
    this.emit({ type: 'cli.install.done', phase: 'update', ok: exitCode === 0, exitCode });
    this.emit({ type: 'runtime.updated', status: this.runtime.status() });
    await this.emitEnvironment();
  }

  private async getFactoryDefaults(): Promise<FactoryDefaultSettings> {
    if (this.factoryDefaultsOverride) return this.factoryDefaultsOverride();
    const defaults = readFactoryDefaults();
    const models = await this.getModels();
    return validateFactoryDefaults(defaults, models);
  }

  private emitFactoryDefaults(): void {
    const defaults = readFactoryDefaults();
    const droidPath = this.runtime.status().droidPath;
    const models = this.cachedModels ?? mergeModelCatalog(readDroidCliModelCatalogCache(droidPath));
    if (!this.cachedModels && models.length > 0) this.cachedModels = models;
    this.emit({ type: 'settings.defaults', defaults: startupFactoryDefaults(defaults, models) });
  }

  private async startLocalMcpServers(
    ref: { id: string },
    cwd?: string,
  ): Promise<StartedLocalMcpResources> {
    const servers = [this.createLocalMcpResource(() => ref.id)];
    const configuredCwd = cwd?.trim();
    const configured = this.loadConfiguredMcpServers(
      configuredCwd === undefined || configuredCwd.length === 0 ? homedir() : configuredCwd,
    );
    const configs: StartedLocalMcpResources['configs'] = [...configured];
    try {
      for (const server of servers) {
        const config = await server.start();
        if (configured.some((candidate) => candidate.name === config.name)) {
          throw new Error(
            `Droid MCP server name "${config.name}" is reserved by DROIDEX. Rename it in your Droid MCP configuration.`,
          );
        }
        configs.push(config);
      }
      return { servers, configs };
    } catch (err) {
      await Promise.all(servers.map((server) => server.close().catch(ignoreError)));
      throw err;
    }
  }

  private maxContextTokensForSummary(summary: SessionSummary): number | undefined {
    return this.maxContextTokensForModel(summary.configuration.providerSelection.modelId);
  }

  private maxContextTokensForModel(modelId?: string): number | undefined {
    if (!modelId) return undefined;
    return (
      this.cachedModels?.find((model) => model.id === modelId)?.maxContextTokens ??
      this.learnedModelContextWindows.get(modelId)
    );
  }

  // Custom and BYOK models are often missing from the catalog, so their
  // compaction limits initially arm without a window ceiling. The provider's
  // own context stats reveal the window; remember it and retune thresholds.
  private noteModelContextWindow(modelId: string, contextWindowTokens: number): void {
    if (!Number.isFinite(contextWindowTokens) || contextWindowTokens <= 0) return;
    const window = Math.floor(contextWindowTokens);
    if (this.cachedModels?.some((model) => model.id === modelId && model.maxContextTokens)) return;
    if (this.learnedModelContextWindows.get(modelId) === window) return;
    this.learnedModelContextWindows.set(modelId, window);
    void this.compaction.retuneAll(this.compactionRetuneTargets());
  }

  // eslint-disable-next-line complexity -- Agent-setting policy is preserved as-is in this extraction.
  private async updateAgentSettings(
    cmd: Extract<ClientCommand, { type: 'settings.agent.update' }>,
  ): Promise<void> {
    try {
      const session = cmd.appSessionId ? this.registry.getLive(cmd.appSessionId) : undefined;
      const summary =
        session?.summary ??
        (cmd.appSessionId ? this.registry.resolveSummary(cmd.appSessionId) : undefined);
      if (
        cmd.appSessionId &&
        cmd.agent !== 'primary' &&
        summary &&
        summary.sessionPurpose !== 'mission-control'
      ) {
        this.emitError({
          code: 'agent.settings_unsupported',
          appSessionId: summary.appSessionId,
          message: 'Worker and validator model settings only apply to Mission Control sessions.',
        });
        return;
      }
      if (cmd.appSessionId && !session) this.rememberPendingAgentSettings(cmd);
      const appSessionId = session?.summary.appSessionId ?? cmd.appSessionId;
      if (session) {
        const settings = await this.runtimeAgentSettings(session, cmd.agent, {
          modelId: cmd.modelId,
          reasoningEffort: cmd.reasoningEffort,
        });
        await this.applyAgentSessionSettings(session, cmd.agent, settings);
        if (
          this.shutdownPromise ||
          this.registry.getLive(session.summary.appSessionId) !== session ||
          hasSessionCloseStarted(session)
        )
          return;
        if (cmd.appSessionId) this.rememberPendingAgentSettings(cmd);
      }
      if (cmd.appSessionId) {
        const base = session?.summary ?? this.registry.resolveSummary(cmd.appSessionId);
        if (!base) return;
        const patch = this.summaryPatchForAgent(base, cmd.agent, cmd);
        if (session && appSessionId) {
          this.registry.updateSummary(appSessionId, patch);
          if (cmd.agent === 'primary')
            session.appliedNativeConfiguration = session.summary.configuration;
        } else {
          this.emit({
            type: 'session.updated',
            session: { ...base, ...patch, updatedAt: Date.now() },
          });
        }
        if (session && appSessionId && cmd.agent === 'primary') {
          // The auto-compaction threshold is derived from the primary model,
          // so recompute it when the model changes; otherwise auto-compaction
          // keeps using the limit captured at create/resume time.
          const stillCurrent = () =>
            !this.shutdownPromise &&
            this.registry.getLive(appSessionId) === session &&
            !hasSessionCloseStarted(session);
          if (cmd.modelId !== undefined)
            await this.compaction.rearmPrimary(this.primaryTargets(session).retune);
          if (stillCurrent()) await this.context.refresh(this.primaryTargets(session).context);
        }
      }
    } catch (err) {
      this.emitError({
        appSessionId: cmd.appSessionId,
        message: `Could not update agent settings: ${errMsg(err)}`,
      });
    }
  }

  private rememberPendingAgentSettings(
    cmd: Extract<ClientCommand, { type: 'settings.agent.update' }>,
  ): void {
    if (!cmd.appSessionId) return;
    const appSessionId =
      this.registry.getLive(cmd.appSessionId)?.summary.appSessionId ??
      this.registry.resolveSummary(cmd.appSessionId)?.appSessionId ??
      cmd.appSessionId;
    const existing = this.pendingAgentSettings.get(appSessionId) ?? {};
    const agent = { ...(existing[cmd.agent] ?? {}) };
    if (cmd.modelId !== undefined) agent.modelId = cmd.modelId;
    if (cmd.reasoningEffort !== undefined) agent.reasoningEffort = cmd.reasoningEffort;
    this.pendingAgentSettings.set(appSessionId, { ...existing, [cmd.agent]: agent });
  }

  private summaryPatchForAgent(
    summary: SessionSummary,
    agent: ConfigurableSessionRole,
    settings: AgentSettingPatch,
  ): Partial<SessionSummary> {
    if (agent === 'primary') {
      const options = { ...summary.configuration.providerSelection.options };
      if (settings.reasoningEffort !== undefined) {
        if (settings.reasoningEffort) options.reasoningEffort = settings.reasoningEffort;
        else delete options.reasoningEffort;
      }
      const modelId =
        settings.modelId === undefined || settings.modelId === null
          ? summary.configuration.providerSelection.modelId
          : settings.modelId;
      const patch: Partial<SessionSummary> = {
        configuration: withProviderSelection(summary.configuration, {
          modelId,
          options,
        }),
      };
      if (settings.modelId !== undefined) {
        patch.maxContextTokens = this.maxContextTokensForModel(settings.modelId ?? undefined);
      }
      return patch;
    }
    const current = summary.droidMissionConfiguration;
    const nextAgent = {
      modelId:
        settings.modelId === undefined || settings.modelId === null
          ? ((agent === 'worker' ? current?.worker.modelId : current?.validator.modelId) ??
            summary.configuration.providerSelection.modelId)
          : settings.modelId,
      ...(settings.reasoningEffort !== undefined
        ? { reasoningEffort: settings.reasoningEffort }
        : agent === 'worker'
          ? current?.worker.reasoningEffort !== undefined
            ? { reasoningEffort: current.worker.reasoningEffort }
            : {}
          : current?.validator.reasoningEffort !== undefined
            ? { reasoningEffort: current.validator.reasoningEffort }
            : {}),
    };
    const other =
      agent === 'worker'
        ? (current?.validator ?? { modelId: summary.configuration.providerSelection.modelId })
        : (current?.worker ?? { modelId: summary.configuration.providerSelection.modelId });
    return {
      droidMissionConfiguration:
        agent === 'worker'
          ? { worker: nextAgent, validator: other }
          : { worker: other, validator: nextAgent },
    };
  }

  private applyPendingSettingsToSummary(summary: SessionSummary): SessionSummary {
    const pending = this.pendingAgentSettings.get(summary.appSessionId);
    if (!pending) return summary;
    return (Object.entries(pending) as [ConfigurableSessionRole, AgentSettingPatch][]).reduce(
      (next, [agent, settings]) => ({
        ...next,
        ...this.summaryPatchForAgent(next, agent, settings),
      }),
      summary,
    );
  }

  private async applyAgentSessionSettings(
    liveSession: LiveSession,
    agent: ConfigurableSessionRole,
    settings: AgentSettingPatch,
  ): Promise<void> {
    const next = createSessionSettingsForAgent(agent, settings);
    if (Object.keys(next).length > 0) {
      await requireLiveDroidCapability(
        liveSession,
        'modelChange',
        'updateSettings',
        this.droid.snapshotCapabilities,
      ).updateSettings(next);
    }
  }

  private compactionRetuneTargets(): CompactionRetuneTarget[] {
    const targets: CompactionRetuneTarget[] = [...this.childSessions.compactionRetuneTargets()];
    for (const liveSession of this.registry.liveSessionsSnapshot()) {
      targets.push(this.primaryTargets(liveSession).retune);
    }
    return targets;
  }

  private async runtimeAgentSettings(
    liveSession: LiveSession,
    agent: ConfigurableSessionRole,
    settings: AgentSettingPatch,
  ): Promise<AgentSettingPatch> {
    if (settings.modelId !== null) return settings;
    const defaults = await this.getFactoryDefaults();
    return {
      ...settings,
      modelId: defaultModelForAgent(agent, defaultsModeForSummary(liveSession.summary), defaults),
    };
  }

  private async applyPendingSessionSettings(appSessionId: string): Promise<boolean> {
    const liveSession = this.registry.getLive(appSessionId);
    const pending = this.pendingAgentSettings.get(appSessionId);
    if (!liveSession || !pending) return true;
    const stillCurrent = () =>
      !this.shutdownPromise &&
      this.registry.getLive(appSessionId) === liveSession &&
      !hasSessionCloseStarted(liveSession);
    try {
      let patch: Partial<SessionSummary> = {};
      for (const [agent, settings] of Object.entries(pending) as [
        ConfigurableSessionRole,
        AgentSettingPatch,
      ][]) {
        const runtimeSettings = await this.runtimeAgentSettings(liveSession, agent, settings);
        if (!stillCurrent()) return false;
        await this.applyAgentSessionSettings(liveSession, agent, runtimeSettings);
        if (!stillCurrent()) return false;
        patch = { ...patch, ...this.summaryPatchForAgent(liveSession.summary, agent, settings) };
      }
      if (!stillCurrent()) return false;
      this.registry.updateSummary(appSessionId, patch);
      liveSession.appliedNativeConfiguration = liveSession.summary.configuration;
      if (pending.primary?.modelId !== undefined) {
        // A pending primary model applied before send changes the
        // auto-compaction threshold; recompute it to match the new model.
        await this.compaction.rearmPrimary(this.primaryTargets(liveSession).retune);
      }
      return stillCurrent();
    } catch (err) {
      if (!stillCurrent()) return false;
      this.emitError({
        appSessionId,
        message: `Could not apply selected model before send: ${errMsg(err)}`,
      });
      return false;
    }
  }

  private async preparePrimaryTurn(liveSession: LiveSession, prompt: string): Promise<boolean> {
    const appSessionId = liveSession.summary.appSessionId;
    const contextTarget = this.primaryTargets(liveSession).context;
    if (!this.isCurrentPrimarySession(liveSession)) return false;
    this.eventFlow.beginTurn(appSessionId, appSessionId);
    this.context.beginTurn(appSessionId);
    this.context.startPolling(contextTarget);
    await this.applyDesignToolPolicy(liveSession, isDesignPrompt(prompt));
    if (!this.isCurrentPrimarySession(liveSession)) {
      this.context.stopPolling(contextTarget);
      return false;
    }
    return true;
  }

  private async finishPrimaryTurn(liveSession: LiveSession, turnError?: unknown): Promise<void> {
    const appSessionId = liveSession.summary.appSessionId;
    const contextTarget = this.primaryTargets(liveSession).context;
    try {
      this.timeline.settleStreaming(appSessionId, appSessionId);
    } catch (err) {
      turnError ??= err;
    } finally {
      this.context.stopPolling(contextTarget);
    }
    if (!this.isCurrentPrimarySession(liveSession)) return;
    if (turnError) {
      if (liveSession.interruptingForSteer) {
        this.timeline.appendStatus(appSessionId, 'Current turn interrupted for steering.');
      } else if (liveSession.interrupting && isUserCancellation(turnError)) {
        this.registry.updateSummary(appSessionId, { phase: 'paused' });
      } else {
        if (!isReportedStreamingTranscriptError(turnError)) {
          this.emitError({ appSessionId, message: errMsg(turnError) });
        }
        this.registry.updateSummary(appSessionId, { phase: 'failed' });
      }
    } else {
      const previous = liveSession.appliedNativeConfiguration;
      const next = liveSession.summary.configuration;
      liveSession.appliedNativeConfiguration = next;
      if (
        previous &&
        (previous.providerSelection.modelId !== next.providerSelection.modelId ||
          previous.interactionMode !== next.interactionMode)
      ) {
        await this.compaction.rearmPrimary(this.primaryTargets(liveSession).retune);
      }
    }
    await this.context.refresh(contextTarget);
  }

  private isCurrentPrimarySession(liveSession: LiveSession): boolean {
    return (
      !this.shutdownPromise &&
      this.registry.getLive(liveSession.summary.appSessionId) === liveSession &&
      !hasSessionCloseStarted(liveSession)
    );
  }

  private primaryTargets(liveSession: LiveSession) {
    return managerPrimaryTargets(liveSession, this.droid.snapshotCapabilities, () =>
      this.isCurrentPrimarySession(liveSession),
    );
  }

  // Design turns are a single focused task (extra prompts queue), so the model
  // does not need TodoWrite — it otherwise loops updating the list after it has
  // already answered. Disable TodoWrite for design turns and restore it for
  // normal turns, calling updateSettings only when the policy changes.
  private async applyDesignToolPolicy(liveSession: LiveSession, design: boolean): Promise<void> {
    // When the in-memory flag is unset (cold start / page reload) we don't
    // know the session's current disabledToolIds, so always call updateSettings
    // to synchronize. Once the flag is set we skip redundant calls.
    if (
      liveSession.todoDisabledForDesign !== undefined &&
      liveSession.todoDisabledForDesign === design
    )
      return;
    if (!this.isCurrentPrimarySession(liveSession)) return;
    try {
      await requireLiveDroidCapability(
        liveSession,
        'skills',
        'applyDesignToolPolicy',
        this.droid.snapshotCapabilities,
      ).updateSettings({
        disabledToolIds: design ? ['TodoWrite'] : [],
      });
      if (!this.isCurrentPrimarySession(liveSession)) return;
      liveSession.todoDisabledForDesign = design;
    } catch (err) {
      if (!this.isCurrentPrimarySession(liveSession)) return;
      this.emitError({
        appSessionId: liveSession.summary.appSessionId,
        message: `Could not update design tool policy: ${errMsg(err)}`,
      });
    }
  }

  private resolveChildDefaultSettings(
    summary: SessionSummary,
    initResult: SessionInitResult,
    role: 'worker' | 'validator',
  ): ChildSettings {
    if (summary.sessionPurpose === 'mission-control')
      return this.missionControlPolicy.resolveDefaultSettings(summary.appSessionId, role);
    const parentSettings = childSessionSettingsFromInit(initResult);
    const mission = summary.droidMissionConfiguration;
    const roleModelId = role === 'validator' ? mission?.validator.modelId : mission?.worker.modelId;
    const roleReasoningEffort =
      role === 'validator' ? mission?.validator.reasoningEffort : mission?.worker.reasoningEffort;
    const catalogDefault = this.resolveCatalogDefaultSettings();
    return {
      modelId:
        summary.configuration.providerSelection.modelId ??
        parentSettings.modelId ??
        roleModelId ??
        catalogDefault.modelId,
      reasoningEffort:
        droidReasoningEffortFromSelection(summary.configuration.providerSelection) ??
        parentSettings.reasoningEffort ??
        roleReasoningEffort ??
        catalogDefault.reasoningEffort,
    };
  }

  private resolveCatalogDefaultSettings(): ChildSettings {
    const model =
      this.cachedModels?.find((candidate) => candidate.isDefault && !candidate.isCustom) ??
      this.cachedModels?.find((candidate) => !candidate.isCustom) ??
      this.cachedModels?.at(0);
    return {
      modelId: model?.id,
      reasoningEffort: model?.defaultReasoningEffort,
    };
  }

  private applyEventSideEffects(appSessionId: string, n: NormalizedSideEffects): void {
    this.missionControlPolicy.apply(appSessionId, n);
    if (n.childSession) {
      const { toolUseId, ...childSession } = n.childSession;
      this.childSessions.admitChildObservation({
        parentAppSessionId: appSessionId,
        role: 'worker',
        ...childSession,
        requiresExactLaunchSettings: true,
        ...(toolUseId ? { spawnLink: { kind: 'tool-use', id: toolUseId } } : {}),
      });
    }
  }

  private resolveAutomaticCompactionTarget(
    key: CompactionResourceKey,
  ): AutomaticCompactionTarget | undefined {
    if (key.kind === 'child') return this.childSessions.resolveAutomaticTarget(key);
    const parent = this.registry.getLive(key.appSessionId);
    if (!parent || hasSessionCloseStarted(parent)) return undefined;
    return this.primaryTargets(parent).automatic;
  }

  private settleAutomaticCompaction(settlement: AutoCompactionSettlement): void {
    if (settlement.kind === 'primary') {
      void this.lifecycle.settleAfterCompaction(settlement.appSessionId);
      return;
    }
    this.childSessions.settleAutomatic(settlement);
  }

  private async compactSession(
    requestedAppSessionId: string,
    customInstructions?: string,
  ): Promise<void> {
    const previousLiveSession = this.registry.getLive(requestedAppSessionId);
    if (previousLiveSession) {
      requireLiveDroidCapability(
        previousLiveSession,
        'compaction',
        'compactSession',
        this.droid.snapshotCapabilities,
      );
    }
    const appSessionId =
      previousLiveSession?.summary.appSessionId ??
      this.registry.resolveSummary(requestedAppSessionId)?.appSessionId ??
      requestedAppSessionId;
    if (
      previousLiveSession?.streaming ||
      previousLiveSession?.compacting ||
      previousLiveSession?.autoCompacting
    ) {
      this.timeline.appendStatus(
        appSessionId,
        'Cannot compact while a turn is active. Try again when the model is idle.',
      );
      return;
    }
    let readyToSettle = false;
    try {
      const result = await this.compaction.compact(appSessionId, customInstructions);
      if (result.kind === 'close-and-resume') {
        const closeFailure = await this.closeForPermanentCompactionRecovery(result.appSessionId);
        this.context.preserveUsage(result.appSessionId, result.carryover);
        readyToSettle = true;
        if (closeFailure) {
          this.emitError({
            appSessionId: result.appSessionId,
            message: `Could not fully close the compacted session: ${errMsg(closeFailure.error)}`,
            recoverable: true,
          });
        }
        this.emitError({
          appSessionId: result.appSessionId,
          message: `Compaction moved this conversation to a new session but reloading it failed: ${result.reloadError}. It will reload on your next message.`,
          recoverable: true,
        });
      }
      readyToSettle = true;
    } finally {
      if (readyToSettle) {
        await this.lifecycle.settleAfterCompaction(appSessionId, previousLiveSession);
      }
    }
  }

  private async closeForPermanentCompactionRecovery(
    appSessionId: string,
  ): Promise<{ error: unknown } | undefined> {
    try {
      await this.lifecycle.close(appSessionId, 'preserve-pending');
    } catch (error) {
      return { error };
    }
  }

  private replaceSessionConfiguration(
    requestedAppSessionId: string,
    configuration: SessionConfiguration,
  ): void {
    let parsed: SessionConfiguration;
    try {
      parsed = parseSessionConfiguration(configuration);
    } catch (err) {
      this.emitError({
        appSessionId: requestedAppSessionId,
        code: 'session.configuration_update_failed',
        message: `Invalid session configuration: ${errMsg(err)}`,
        recoverable: true,
      });
      return;
    }
    const appSessionId =
      this.registry.getCanonicalSummary(requestedAppSessionId)?.appSessionId ??
      requestedAppSessionId;
    const liveSession = this.registry.getLive(appSessionId);
    if (!liveSession) {
      this.emitError({
        appSessionId: requestedAppSessionId,
        code: 'session.configuration_update_failed',
        message: 'Settings can only be changed on a live session.',
        recoverable: true,
      });
      return;
    }
    const current = liveSession.summary.configuration;
    if (
      parsed.providerSelection.providerInstanceId !== current.providerSelection.providerInstanceId
    ) {
      this.emitError({
        appSessionId: liveSession.summary.appSessionId,
        code: 'session.configuration_update_failed',
        message: 'A settings update cannot change the nested provider instance.',
        recoverable: true,
      });
      return;
    }
    try {
      assertDroidMissionConfigurationAllowed(parsed, liveSession.summary.droidMissionConfiguration);
    } catch (err) {
      this.emitError({
        appSessionId: liveSession.summary.appSessionId,
        code: 'session.configuration_update_failed',
        message: errMsg(err),
        recoverable: true,
      });
      return;
    }
    this.registry.updateSummary(liveSession.summary.appSessionId, {
      configuration: parsed,
      maxContextTokens: this.maxContextTokensForModel(parsed.providerSelection.modelId),
    });
  }

  private async renameSession(requestedAppSessionId: string, title: string): Promise<void> {
    // Renderer metadata caps titles at 200 chars (MAX_CHAT_TITLE_LENGTH); the
    // bridge is the trusted boundary, so clamp here too before forwarding to
    // the harness.
    const safeTitle = title.trim().slice(0, 200);
    await withHostDroidSession(
      this.droid,
      requestedAppSessionId,
      undefined,
      'renameSession',
      (droid) => droid.renameSession({ title: safeTitle }),
    );
    const appSessionId =
      this.registry.getLive(requestedAppSessionId)?.summary.appSessionId ??
      this.registry.resolveSummary(requestedAppSessionId)?.appSessionId;
    if (appSessionId) this.registry.updateSummary(appSessionId, { title: safeTitle });
  }

  private emitError(error: {
    code?: string;
    clientRef?: string;
    requestId?: string;
    appSessionId?: string;
    message: string;
    recoverable?: boolean;
  }): void {
    this.emit({ type: 'error', ...error });
  }

  shutdown(deadline?: ShutdownDeadline): Promise<void> {
    if (!this.shutdownPromise) {
      const shutdownDeadline =
        deadline ?? ShutdownDeadline.fromDurationMs(SIDECAR_SHUTDOWN_BUDGET_MS);
      // Admission stops as soon as this promise exists. Abort discovery in the
      // same turn so a late probe cannot adopt after the first trigger.
      this.shutdownPromise = Promise.resolve().then(() => this.performShutdown(shutdownDeadline));
      this.providerRegistry?.abortDiscovery();
    }
    return this.shutdownPromise;
  }

  private async performShutdown(deadline: ShutdownDeadline): Promise<void> {
    this.historyQueries.forget();
    this.runtimeRetirement.stop();
    let firstError: unknown;
    const run = async (action: () => void | Promise<void>): Promise<void> => {
      try {
        await deadline.awaitSettled(Promise.resolve().then(action));
      } catch (error) {
        firstError ??= error;
      }
    };

    // 1. Command admission already stopped: shutdownPromise is set.
    // 2. Discovery abort already ran synchronously in shutdown(); repeat is
    //    idempotent so a late in-flight probe still cannot adopt.
    await run(() => {
      this.providerRegistry?.abortDiscovery();
    });
    await run(() => this.sessionFiles.close());
    // 3. Invalidate live generations and unregister before provider awaits.
    await run(() => {
      this.lifecycle.invalidateLiveSessions();
    });
    // 4. Settle native interaction callbacks before discarding resources.
    await run(() => {
      this.interactions.cancelAllPending();
    });
    // 5. Close children, then parent provider sessions.
    await run(() => this.childSessions.shutdown(deadline));
    await run(() => this.lifecycle.closeAll(deadline));
    await run(() => {
      this.missionControlPolicy.clear();
    });
    await run(() => {
      this.context.clearAll();
    });
    await run(() => {
      this.compaction.clearAll();
    });
    await run(() => this.browsers.closeAll());
    // 7. Close constructed adapters in reverse construction order.
    await run(() => {
      if (this.providerRegistry) return this.providerRegistry.close(deadline);
      return undefined;
    });
    // 8. Flush timeline and persistence queues.
    await run(() => {
      this.timeline.flushStreaming(deadline);
    });
    await run(() => {
      this.history.close();
    });
    // 9. Close SQLite last.
    await run(() => {
      this.database?.close(deadline);
    });
    if (firstError !== undefined)
      throw firstError instanceof Error ? firstError : new Error(errMsg(firstError));
  }
}

function childSessionSettingsFromInit(init: SessionInitResult): ChildSettings {
  return {
    modelId: init.settings?.modelId,
    reasoningEffort: reasoningValue(init.settings?.reasoningEffort),
  };
}

export function createSessionSettingsForAgent(
  agent: ConfigurableSessionRole,
  settings: AgentSettingPatch,
): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  if (agent === 'primary') {
    // Spec-mode turns run on specModeModelId, so keep it in lockstep with the
    // chat's single visible model; otherwise a spec session keeps generating
    // with the model selected at create time (or the CLI spec default).
    if (settings.modelId) {
      next.modelId = settings.modelId;
      next.specModeModelId = settings.modelId;
    }
    if (settings.reasoningEffort !== undefined) {
      next.reasoningEffort = settings.reasoningEffort;
      next.specModeReasoningEffort = settings.reasoningEffort;
    }
    return next;
  }

  const missionSettings: Record<string, unknown> = {};
  if (agent === 'worker') {
    if (settings.modelId) missionSettings.workerModel = settings.modelId;
    if (settings.reasoningEffort !== undefined)
      missionSettings.workerReasoningEffort = settings.reasoningEffort;
  } else {
    if (settings.modelId) missionSettings.validationWorkerModel = settings.modelId;
    if (settings.reasoningEffort !== undefined)
      missionSettings.validationWorkerReasoningEffort = settings.reasoningEffort;
  }

  if (Object.keys(missionSettings).length > 0) next.missionSettings = missionSettings;
  return next;
}

export function startupFactoryDefaults(
  defaults: FactoryDefaultSettings,
  models: ModelInfo[],
): FactoryDefaultSettings {
  if (models.length > 0) return validateFactoryDefaults(defaults, models);
  const safe: FactoryDefaultSettings = {
    autonomy: defaults.autonomy,
    interactionMode: defaults.interactionMode,
    compactionTokenLimit: normalizeCompactionTokenLimit(defaults.compactionTokenLimit),
    compactionTokenLimitPerModel: validCompactionTokenLimitRecord(
      defaults.compactionTokenLimitPerModel,
    ),
  };
  if (defaults.compactionModel === 'current-model') safe.compactionModel = 'current-model';
  return safe;
}

export function validateFactoryDefaults(
  defaults: FactoryDefaultSettings,
  models: ModelInfo[],
): FactoryDefaultSettings {
  if (models.length === 0) return runtimeFactoryDefaultsWithoutCatalog(defaults);
  const firstModel = models.at(0);
  if (!firstModel) return runtimeFactoryDefaultsWithoutCatalog(defaults);
  const cliDefault =
    models.find((model) => model.isDefault && !model.isCustom) ??
    models.find((model) => !model.isCustom) ??
    firstModel;
  return {
    ...defaults,
    modelId: validModelId(defaults.modelId, models) ?? cliDefault.id,
    reasoningEffort:
      validReasoning(defaults.modelId, defaults.reasoningEffort, models) ??
      cliDefault.defaultReasoningEffort,
    compactionModel: validCompactionModel(defaults.compactionModel, models),
    compactionTokenLimit: normalizeCompactionTokenLimit(defaults.compactionTokenLimit),
    compactionTokenLimitPerModel: validCompactionTokenLimitPerModel(
      defaults.compactionTokenLimitPerModel,
      models,
    ),
    specModelId:
      validModelId(defaults.specModelId, models) ??
      validModelId(defaults.modelId, models) ??
      cliDefault.id,
    specReasoningEffort: validReasoning(defaults.specModelId, defaults.specReasoningEffort, models),
    workerModelId: validModelId(defaults.workerModelId, models) ?? cliDefault.id,
    workerReasoningEffort: validReasoning(
      defaults.workerModelId,
      defaults.workerReasoningEffort,
      models,
    ),
    validatorModelId: validModelId(defaults.validatorModelId, models) ?? cliDefault.id,
    validatorReasoningEffort: validReasoning(
      defaults.validatorModelId,
      defaults.validatorReasoningEffort,
      models,
    ),
  };
}

function runtimeFactoryDefaultsWithoutCatalog(
  defaults: FactoryDefaultSettings,
): FactoryDefaultSettings {
  return {
    ...defaults,
    compactionTokenLimit: normalizeCompactionTokenLimit(defaults.compactionTokenLimit),
    compactionTokenLimitPerModel: validCompactionTokenLimitRecord(
      defaults.compactionTokenLimitPerModel,
    ),
  };
}

function validModelId(modelId: string | undefined, models: ModelInfo[]): string | undefined {
  return modelId && models.some((model) => model.id === modelId) ? modelId : undefined;
}

function validReasoning(
  modelId: string | undefined,
  reasoning: ReasoningEffort | undefined,
  models: ModelInfo[],
): ReasoningEffort | undefined {
  const model = modelId ? models.find((item) => item.id === modelId) : undefined;
  if (!model) return undefined;
  const supported = model.supportedReasoningEfforts;
  if (reasoning && (!supported || supported.includes(reasoning))) return reasoning;
  return model.defaultReasoningEffort ?? supported?.[0];
}

function validCompactionModel(modelId: string | undefined, models: ModelInfo[]): string {
  if (!modelId || modelId === 'current-model') return 'current-model';
  return validModelId(modelId, models) ?? 'current-model';
}

function validCompactionTokenLimitRecord(
  limits: Record<string, number> | undefined,
): Record<string, number> | undefined {
  if (!limits) return undefined;
  const entries = Object.entries(limits)
    .map(([modelId, limit]) => [modelId, normalizeCompactionTokenLimit(limit)] as const)
    .filter((entry): entry is [string, number] => Boolean(entry[0]) && entry[1] !== undefined);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function validCompactionTokenLimitPerModel(
  limits: Record<string, number> | undefined,
  models: ModelInfo[],
): Record<string, number> | undefined {
  if (!limits) return undefined;
  const modelIds = new Set(models.map((model) => model.id));
  const entries = Object.entries(limits)
    .map(([modelId, limit]) => [modelId, normalizeCompactionTokenLimit(limit)] as const)
    .filter((entry): entry is [string, number] => modelIds.has(entry[0]) && entry[1] !== undefined);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function defaultModelForAgent(
  agent: ConfigurableSessionRole,
  mode: SessionInteractionMode,
  defaults: FactoryDefaultSettings,
): string | undefined {
  if (agent === 'worker') return defaults.workerModelId;
  if (agent === 'validator') return defaults.validatorModelId;
  return modelDefaultForMode(mode, defaults);
}
