import type { AutomationDeliveryReceipt } from './automations/types.js';
import type { ScheduledTurnDelivery } from './sessionAutomationDelivery.js';
import { type McpServerConfig } from '@factory/droid-sdk';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import type {
  Autonomy,
  BridgeRuntimeSnapshot,
  ClientCommand,
  FactoryDefaultSettings,
  InstallChannel,
  HistorySearchReply,
  PersistenceRecovery,
  ProviderMention,
  SessionSummary,
  ModelInfo,
  ReasoningEffort,
  ResponseFormat,
  ServerEvent,
  SessionInteractionMode,
  TranscriptEvent,
} from './protocol.js';
import {
  defaultsModeForSummary,
  errMsg,
  modelDefaultForMode,
  normalizeAutonomy,
  reasoningValue,
  type SessionInitResult,
} from './sessionHelpers.js';
import { boundedInt } from './values.js';
import { DroidRuntime, type FactoryRuntime, type FactorySession } from './DroidRuntime.js';
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
import type { AgentProcessMonitor } from './processes/AgentProcessMonitor.js';
import {
  createAgentProcessMonitor,
  type AgentProcessHost,
} from './processes/createAgentProcessMonitor.js';
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
import { createAutomationMcpServer } from './automations/automationMcpServer.js';
import { isUnattendedAutomationSession } from './automations/AutomationManager.js';
import {
  normalizeMcpServerName,
  shouldAttachAutomationMcp,
} from './automations/permissionPolicy.js';
import { createBrowserMcpServer } from './browser/browserMcpServer.js';
import { SessionRegistry } from './SessionRegistry.js';
import { SessionEventFlow, type NormalizedSideEffects } from './SessionEventFlow.js';
import { SessionInteractions } from './SessionInteractions.js';
import { SessionTimeline } from './SessionTimeline.js';
import { SessionContext, type LiveOperationTarget } from './SessionContext.js';
import {
  SessionCompaction,
  type AutoCompactionSettlement,
  type AutomaticCompactionTarget,
  type CompactionResourceKey,
  type CompactionRetuneTarget,
  type PrimaryAutomaticCompactionTarget,
  type PrimaryCompactionTarget,
} from './SessionCompaction.js';
import {
  SessionLifecycle,
  type LiveSession,
  type StartedLocalMcpResources,
} from './SessionLifecycle.js';
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
import { assertValidResponseFormat, formatAppPrompt } from './appPrompt.js';
import { droidCatalogItems } from './providers/catalog.js';
import { DroidProvider } from './providers/droid/DroidProvider.js';
import { runPrimaryTurn } from './providers/primaryTurn.js';
import {
  assertProviderUnchanged,
  DEFAULT_PROVIDER,
  type ProviderKind,
} from './providers/providerKind.js';
import { LazyProvider } from './providers/lazyProvider.js';
import { requireDroidSession } from './providers/droid/DroidProviderSession.js';
import {
  ProviderProbes,
  type ProviderProbe,
  type ProviderProbeMap,
} from './providers/providerProbes.js';
import { ProviderTranscriptFile } from './providers/ProviderTranscriptFile.js';
import { SessionModelSettings } from './SessionModelSettings.js';
import { providerStatuses } from './providers/providerStatus.js';
import type { Provider } from './providers/session.js';

type Emit = (event: ServerEvent) => void;

function formatResponsePrompt(text: string, responseFormat?: ResponseFormat): string {
  assertValidResponseFormat(responseFormat);
  if (!responseFormat) return text;
  return formatAppPrompt(text, responseFormat === 'app-create' ? 'create' : 'followup');
}

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

export interface SessionManagerDependencies {
  runtime: FactoryRuntime;
  history: SessionHistory;
  browsers: SessionBrowsers;
  createLocalMcpResource: (appSessionId: () => string) => StartableLocalMcpResource;
  createAutomationMcpResource?: (appSessionId: () => string) => StartableLocalMcpResource;
  mcpConfiguration: McpConfiguration;
  loadConfiguredMcpServers: (cwd: string | undefined) => McpServerConfig[];
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
  agentProcessHost?: AgentProcessHost;
  maxLiveRuntimes?: number;
  maxQueuedRuntimes?: number;
  childRuntimeIdleMs?: number;
  sessionRuntimeIdleMs?: number;
}

export interface SessionManagerOptions {
  beforeFirstTurn?: ((session: SessionSummary, clientRef: string) => Promise<void>) | undefined;
  assetUrlFor?: (path: string) => string;
  onSessionAvailable?: (appSessionId: string) => void;
  onScheduledCapacityChanged?: () => void;
  dependencies?: SessionManagerDependencies;
  initialModels?: ModelInfo[];
  // Injectable because a real probe starts the provider's CLI, which keeps
  // writing under $HOME long after the answer arrives. A test that pins $HOME
  // to a temp directory must pass its own probes — usually none at all.
  providerProbes?: ProviderProbeMap;
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

// MCP settings commands run in a throwaway session; without a workspace they
// still need a directory to read user-level configuration from. A blank cwd on
// the wire means the same as none, as it does everywhere else this is read.
const mcpSettingsCwd = (cwd?: string): string => (cwd === undefined || cwd === '' ? tmpdir() : cwd);

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
  private readonly eventFlow: SessionEventFlow;
  private readonly context: SessionContext;
  private readonly compaction: SessionCompaction;
  private readonly childSessions: ChildSessions;
  private readonly missionControlPolicy: MissionControlPolicy;
  private readonly lifecycle: SessionLifecycle;
  private readonly runtimeRetirement: SessionRuntimeRetirement;
  private readonly adoption: SessionAdoption;
  private readonly agentProcesses: AgentProcessMonitor;
  private readonly sessionFiles: SessionFileServing;
  private readonly sessionBrowser: SessionBrowser;
  private readonly historyQueries: SessionHistoryQueries;
  private readonly modelSettings: SessionModelSettings;
  private shutdownPromise?: Promise<void>;
  // Per-session autonomy mutation queue: rapid changes settle against the
  // provider in the order they were requested.
  private readonly autonomyMutationTails = new Map<string, Promise<void>>();
  private readonly onSessionAvailable: SessionManagerOptions['onSessionAvailable'];
  private readonly browsers: SessionBrowsers;
  private readonly createLocalMcpResource: SessionManagerDependencies['createLocalMcpResource'];
  private readonly createAutomationMcpResource: NonNullable<
    SessionManagerDependencies['createAutomationMcpResource']
  >;
  private readonly mcpConfiguration: McpConfiguration;
  private readonly loadConfiguredMcpServers: SessionManagerDependencies['loadConfiguredMcpServers'];
  private readonly mcpSettings: McpSettings;
  private readonly factoryDefaultsOverride: SessionManagerDependencies['getFactoryDefaults'];
  private readonly nextChildSessionId: () => string;
  private readonly droidProvider: DroidProvider;
  // Loaded with their first probe or session, after the sidecar is ready.
  private readonly claudeProvider = new LazyProvider('claude', async () => {
    const { ClaudeProvider } = await import('./providers/claude/ClaudeProvider.js');
    return new ClaudeProvider();
  });
  private readonly codexProvider = new LazyProvider('codex', async () => {
    const { CodexProvider } = await import('./providers/codex/CodexProvider.js');
    return new CodexProvider();
  });
  private readonly providerProbes: ProviderProbes;

  constructor(
    private readonly emit: Emit,
    options: SessionManagerOptions = {},
  ) {
    this.providerProbes = new ProviderProbes(
      options.providerProbes ??
        new Map<ProviderKind, ProviderProbe>([
          [
            this.claudeProvider.kind,
            (signal, publish) => this.claudeProvider.probe(signal, publish),
          ],
          [this.codexProvider.kind, (signal, publish) => this.codexProvider.probe(signal, publish)],
        ]),
      () => {
        void this.emitProviderStatus();
      },
    );
    this.onSessionAvailable = options.onSessionAvailable;
    const limits = runtimeLimits(options.dependencies);
    let startWatcher: (
      options: SessionFileWatcherOptions,
    ) => ReturnType<typeof startSessionFileWatcher>;
    if (options.dependencies) {
      this.runtime = options.dependencies.runtime;
      this.history = options.dependencies.history;
      this.browsers = options.dependencies.browsers;
      this.createLocalMcpResource = options.dependencies.createLocalMcpResource;
      this.createAutomationMcpResource =
        options.dependencies.createAutomationMcpResource ??
        ((appSessionId) => createAutomationMcpServer(appSessionId));
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
      this.createAutomationMcpResource = (appSessionId) => createAutomationMcpServer(appSessionId);
      this.mcpConfiguration = new DroidMcpConfiguration();
      this.loadConfiguredMcpServers = loadFactoryMcpServers;
      this.factoryDefaultsOverride = undefined;
      this.nextChildSessionId = nextChildSessionId;
      startWatcher = startSessionFileWatcher;
    }
    this.cachedModels = options.initialModels ? [...options.initialModels] : null;
    this.agentProcesses = createAgentProcessMonitor({
      ...options.dependencies?.agentProcessHost,
      onSnapshotChanged: () => {
        this.adoption.persistLiveSet();
      },
      emit: (appSessionId, processes) => {
        try {
          this.emit({ type: 'session.processes', appSessionId, processes });
        } finally {
          this.runtimeRetirement.arm();
        }
      },
    });
    this.mcpSettings = new McpSettings(
      (cwd) =>
        this.runtime.createSession({
          cwd: mcpSettingsCwd(cwd),
          interactionMode: 'auto',
          autonomyLevel: 'low',
          mcpServers: this.loadConfiguredMcpServers(cwd),
        }),
      (cwd) => this.loadConfiguredMcpServers(cwd),
      this.mcpConfiguration,
      (event) => {
        this.emit(event);
      },
    );
    this.registry = new SessionRegistry({
      history: this.history,
      loadOrdinarySessions: (options) => this.history.listHistoricalSessions(options),
      loadMissionControlSessions,
      projectSummary: (summary) => this.modelSettings.project({ ...summary }),
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
    this.historyQueries = new SessionHistoryQueries({
      searchSessions: (query, isStale) => this.history.searchSessions(query, isStale),
      resolveSummary: (id) => this.registry.resolveSummary(id),
      emit: (event) => {
        this.emit(event);
      },
    });
    this.context = new SessionContext({
      registry: this.registry,
      runtime: this.runtime,
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
    this.droidProvider = new DroidProvider(this.runtime);
    this.interactions = new SessionInteractions({
      onSessionAvailable: options.onSessionAvailable,
      getLiveSession: (id) => this.registry.getLive(id),
      updateSummary: (id, patch) => {
        this.registry.updateSummary(id, patch);
      },
      emit: (event) => {
        this.emit(event);
      },
      setProviderSpecMode: (appSessionId, spec) => this.setProviderSpecMode(appSessionId, spec),
      emitError: (error) => {
        this.emitError(error);
      },
    });
    this.compaction = new SessionCompaction({
      registry: this.registry,
      context: this.context,
      timeline: this.timeline,
      runtime: this.runtime,
      agentProcesses: this.agentProcesses,
      interactionsFor: (ref) => this.interactions.interactionsFor(ref),
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
        this.eventFlow.applyNotification(
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
    this.childSessions = new ChildSessions({
      runtime: this.runtime,
      agentProcesses: this.agentProcesses,
      registry: this.registry,
      history: this.history,
      timeline: this.timeline,
      eventFlow: this.eventFlow,
      interactions: this.interactions,
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
    this.modelSettings = new SessionModelSettings({
      registry: this.registry,
      runtime: this.runtime,
      getFactoryDefaults: () => this.getFactoryDefaults(),
      providerDefaultModelId: (provider) => this.providerProbes.status(provider)?.defaultModelId,
      maxContextTokensForModel: (modelId) => this.maxContextTokensForModel(modelId),
      isShutdownStarted: () => this.shutdownPromise !== undefined,
      refreshPrimary: async (live, modelChanged) => {
        const session = live.session;
        const compactionTarget = this.primaryCompactionTarget(live);
        if (modelChanged && compactionTarget) await this.compaction.rearmPrimary(compactionTarget);
        if (!this.isCurrentPrimarySession(live) || live.session !== session) return;
        const target = this.primaryContextTarget(live);
        if (target) await this.context.refresh(target);
      },
      onPrimaryModelChanged: (summary, from, to) => {
        this.appendSettingsStatus(summary, `Model switched: ${from} → ${to}`, { from, to });
      },
      onSettled: (appSessionId) => {
        this.runtimeRetirement.arm();
        // A settled write is one of the states that made this session refuse a
        // turn, so a scheduled delivery waiting on it can be rearmed.
        this.onSessionAvailable?.(appSessionId);
      },
      emitError: (error) => {
        this.emitError(error);
      },
    });
    this.lifecycle = new SessionLifecycle({
      beforeFirstTurn: options.beforeFirstTurn,
      provider: (kind) => this.providerFor(kind),
      providerDefaultModelId: (kind) => this.providerProbes.status(kind)?.defaultModelId,
      registry: this.registry,
      ensureConnected: () => {
        if (!this.ready) this.connect();
      },
      getFactoryDefaults: () => this.getFactoryDefaults(),
      maxContextTokensForModel: (modelId) => this.maxContextTokensForModel(modelId),
      startLocalMcpServers: (ref, cwd) => this.startLocalMcpServers(ref, cwd),
      interactionsFor: (ref) => this.interactions.interactionsFor(ref),
      compaction: this.compaction,
      isShutdownStarted: () => this.shutdownPromise !== undefined,
      childSessions: this.childSessions,
      agentProcesses: this.agentProcesses,
      applyPendingSettingsToSummary: (summary) => this.modelSettings.project(summary),
      applyPendingSessionSettings: (appSessionId) => this.modelSettings.applyPending(appSessionId),
      waitForSettingsMutations: (appSessionId) => this.modelSettings.waitForMutations(appSessionId),
      runPrimaryTurn: (liveSession, prompt, mentions, delivery) =>
        this.runPrimaryTurn(liveSession, prompt, mentions, delivery),
      eventFlow: this.eventFlow,
      hasPendingInteractions: (appSessionId) => this.interactions.hasPending(appSessionId),
      hasActiveSettingsChanges: (appSessionId) =>
        this.modelSettings.hasActiveMutations(appSessionId),
      onSessionAvailable: options.onSessionAvailable,
      onScheduledCapacityChanged: options.onScheduledCapacityChanged,
      context: this.context,
      forgetInteractions: (appSessionId) => {
        this.interactions.forgetSession(appSessionId);
      },
      forgetEventFlow: (appSessionId) => {
        this.eventFlow.forgetSession(appSessionId);
      },
      openProviderTranscript: (summary) => {
        this.openProviderTranscript(summary);
      },
      forgetProviderTranscript: (appSessionId) => {
        this.timeline.releaseTranscript(appSessionId);
      },
      forgetMissionControl: (appSessionId) => {
        this.missionControlPolicy.forget(appSessionId);
      },
      forgetPendingSettings: (appSessionId) => {
        this.modelSettings.forget(appSessionId);
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
      recordPrompt: (appSessionId, text) => {
        this.timeline.recordPrompt(appSessionId, text);
      },
      catalogUpdated: (liveSession, items) => {
        if (this.registry.getLive(liveSession.summary.appSessionId) !== liveSession) return;
        this.emit({
          type: 'catalog.updated',
          catalog: 'skills',
          items,
          providerSessionId: liveSession.session.providerSessionId,
        });
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
      hasPendingSettings: (id) => this.modelSettings.hasPending(id),
      hasAgentProcesses: (id) => this.agentProcesses.hasProcesses(id),
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
      recordedProcesses: () => this.agentProcesses.snapshotPids(),
      reapProcesses: (entries) => this.agentProcesses.killRecorded(entries),
      persistSummaries: (summaries) => {
        this.history.syncSummaries(summaries);
        for (const session of summaries) this.emit({ type: 'session.updated', session });
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
    void this.emitProviderStatus();
    void this.refreshProviderStatus();
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
      processes: this.agentProcesses.snapshot(),
      persistence,
      interrupted: [...this.adoption.records()],
    });
  }

  // Runs on its own idle timer; exposed so callers can force the sweep.
  retireIdleSessionRuntimes(): Promise<void> {
    return this.runtimeRetirement.sweep();
  }

  // Runs on its own tick while a session is tracked; exposed so callers can
  // force the scan.
  scanAgentProcesses(): Promise<void> {
    return this.agentProcesses.scan();
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
        await this.emitProviderStatus();
        void this.refreshModelCatalog(true);
        return;
      }
      case 'provider.refresh':
        await this.emitProviderStatus();
        await this.refreshProviderStatus();
        return;
      case 'catalog.tools':
        await this.emitToolCatalog(cmd.providerSessionId);
        return;
      case 'catalog.skills':
        await this.emitSkillCatalog(cmd.providerSessionId);
        return;
      case 'mcp.list':
      case 'mcp.add':
      case 'mcp.remove':
      case 'mcp.toggle':
      case 'mcp.authenticate':
        if (!this.ready) this.connect();
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
          cmd.mentions,
        );
        return;
      case 'session.sendNow':
        await this.lifecycle.sendNow(
          cmd.appSessionId,
          formatResponsePrompt(cmd.text, cmd.responseFormat),
          cmd.mentions,
        );
        return;
      case 'approval.respond':
        await this.interactions.respondToApproval(cmd.appSessionId, cmd.requestId, cmd.outcome);
        return;
      case 'question.respond':
        this.interactions.respondToQuestion(
          cmd.appSessionId,
          cmd.requestId,
          cmd.cancelled,
          cmd.answers,
        );
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
        assertProviderUnchanged(cmd);
        await this.modelSettings.update(cmd.appSessionId, 'primary', cmd);
        if (cmd.autonomy !== undefined) {
          await this.setAutonomy(cmd.appSessionId, cmd.autonomy);
        }
        if (cmd.interactionMode !== undefined) {
          await this.setInteractionMode(cmd.appSessionId, cmd.interactionMode);
        }
        return;
      case 'session.compact': {
        await this.compactSession(cmd.appSessionId, cmd.customInstructions);
        return;
      }
      case 'session.fork':
        await this.withSession(cmd.appSessionId, (session) => session.forkSession());
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
        await this.withSession(cmd.appSessionId, (session) => session.getRewindInfo({} as never));
        return;
      case 'session.rewind':
        await this.withSession(cmd.appSessionId, (session) =>
          session.executeRewind({ rewindId: cmd.rewindId } as never),
        );
        return;
      case 'session.resume':
        await this.lifecycle.resume(cmd.appSessionId);
        return;
      case 'session.close':
        await this.lifecycle.close(cmd.appSessionId);
        return;
      case 'session.processes.stop':
        await this.agentProcesses.stop(cmd.appSessionId, cmd.pid);
        // Stopping the last process a session was holding can make it retirable.
        this.runtimeRetirement.arm();
        return;
      case 'sessions.list':
        await this.sessionFiles.list(cmd);
        this.emit({ type: 'sessions.processes', processes: this.agentProcesses.snapshot() });
        return;
      case 'history.list':
        this.timeline.list();
        return;
      case 'history.page':
        this.timeline.loadProviderPage(cmd.providerSessionId, cmd.cursor, cmd.limit);
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
        assertProviderUnchanged(cmd);
        await this.modelSettings.updateAgent(cmd);
        return;
      case 'settings.compaction.update':
        await this.compaction.updateLimits(cmd, this.compactionRetuneTargets());
        return;
      case 'browser.open':
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

  deliverScheduledMessage(
    appSessionId: string,
    prompt: string,
    isCurrent: () => boolean,
  ): Promise<AutomationDeliveryReceipt> {
    return this.lifecycle.deliverScheduled(appSessionId, prompt, isCurrent);
  }

  async automationSessionContext(appSessionId: string): Promise<{
    cwd: string | null;
    modelId: string | null;
    reasoningEffort: ReasoningEffort | null;
    autonomy: Autonomy;
  } | null> {
    const summary =
      this.registry.getLive(appSessionId)?.summary ?? this.registry.resolveSummary(appSessionId);
    if (!summary) return null;
    const [defaults, models] = await Promise.all([this.getFactoryDefaults(), this.getModels()]);
    const mode = defaultsModeForSummary(summary);
    const modelId = summary.modelId ?? modelDefaultForMode(mode, defaults) ?? null;
    const defaultReasoning =
      mode === 'spec' ? defaults.specReasoningEffort : defaults.reasoningEffort;
    return {
      cwd: summary.cwd.trim() || null,
      modelId,
      reasoningEffort: resolveAutomationReasoningEffort(summary, modelId, defaultReasoning, models),
      autonomy: summary.autonomy,
    };
  }

  sessionSummary(appSessionId: string): SessionSummary | undefined {
    return this.registry.resolveSummary(appSessionId);
  }

  async validateAutomationSelection(
    modelId: string,
    reasoningEffort: ReasoningEffort,
  ): Promise<void> {
    assertAutomationSelectionSupported(modelId, reasoningEffort, await this.getModels());
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
        if (emit) {
          this.emit({ type: 'catalog.updated', catalog: 'models', items: models });
          await this.emitProviderStatus();
        }
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

  // Droid's readiness follows the resolved CLI path and the catalog this
  // manager already caches; every other provider's comes from its last probe.
  // The default model is the one a new chat would open with, resolved through
  // the very defaults the lifecycle uses, so the two can never disagree.
  private async emitProviderStatus(): Promise<void> {
    // Publication is fired detached from connect, so a defaults failure (a
    // malformed settings file) is reported here and the status still goes out
    // without a Droid default rather than surfacing as an unhandled rejection.
    let defaultModelId: string | undefined;
    try {
      const defaults = await this.getFactoryDefaults();
      // A Factory default configured for Spec names its own model, and that is
      // the mode a new chat opens in, so the same selection answers here.
      defaultModelId = modelDefaultForMode(defaults.interactionMode ?? 'auto', defaults);
    } catch (error) {
      this.emitError({ message: `Could not read the Droid defaults: ${errMsg(error)}` });
    }
    if (this.shutdownPromise) return;
    this.emit({
      type: 'provider.status',
      statuses: providerStatuses(
        this.runtime.status().droidPath,
        this.cachedModels ?? [],
        defaultModelId,
        (provider) => this.providerProbes.status(provider),
      ),
    });
  }

  // Learns what the CLI-backed providers can do right now (one process each, no
  // turn) and republishes. Concurrent refreshes share the one round.
  private async refreshProviderStatus(): Promise<void> {
    await this.providerProbes.refresh();
    if (this.shutdownPromise) return;
    await this.emitProviderStatus();
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
    // The resolved droid path may have changed, and Droid's readiness follows it.
    await this.emitProviderStatus();
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
    // The resolved droid path may have changed, and Droid's readiness follows it.
    await this.emitProviderStatus();
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
    ref: { id: string; clientRef?: string },
    cwd?: string,
  ): Promise<StartedLocalMcpResources> {
    const servers = [this.createLocalMcpResource(() => ref.id)];
    if (shouldAttachAutomationMcp(ref.clientRef, await isUnattendedAutomationSession(ref.id))) {
      servers.push(this.createAutomationMcpResource(() => ref.id));
    }
    // A folderless session has no project scope: user-level config only, the
    // same rule the MCP settings flows follow.
    const workspace = cwd?.trim();
    const configured = this.loadConfiguredMcpServers(
      workspace !== undefined && workspace.length > 0 ? workspace : undefined,
    );
    const configs: StartedLocalMcpResources['configs'] = [...configured];
    try {
      for (const server of servers) {
        const config = await server.start();
        const collision = configured.find(
          (candidate) =>
            normalizeMcpServerName(candidate.name) === normalizeMcpServerName(config.name),
        );
        if (collision) {
          throw new Error(
            `Droid MCP server "${collision.name}" collides with "${config.name}", which is reserved by DROIDEX. Rename it in your Droid MCP configuration and start the session again.`,
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
    return this.maxContextTokensForModel(summary.modelId);
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

  private compactionRetuneTargets(): CompactionRetuneTarget[] {
    const targets: CompactionRetuneTarget[] = [...this.childSessions.compactionRetuneTargets()];
    for (const liveSession of this.registry.liveSessionsSnapshot()) {
      const target = this.primaryCompactionTarget(liveSession);
      if (target) targets.push(target);
    }
    return targets;
  }

  private appendSettingsStatus(
    summary: SessionSummary,
    text: string,
    modelSwitch?: TranscriptEvent['modelSwitch'],
  ): void {
    const id = summary.appSessionId;
    const closed = !this.registry.getLive(id);
    if (closed) this.openProviderTranscript(summary);
    try {
      this.timeline.append({
        id: randomUUID(),
        appSessionId: id,
        sourceSessionId: id,
        role: 'primary',
        ts: Date.now(),
        kind: 'status',
        text,
        ...(modelSwitch ? { modelSwitch } : {}),
      });
    } finally {
      if (closed) this.timeline.releaseTranscript(id);
    }
  }

  // Droid keeps its own session file under ~/.factory/sessions; a session on any
  // other provider is invisible in the sidebar and empty after a restart unless
  // DROIDEX writes one for it.
  private openProviderTranscript(summary: SessionSummary): void {
    if (summary.provider === DEFAULT_PROVIDER) return;
    const appSessionId = summary.appSessionId;
    this.timeline.useTranscript(
      appSessionId,
      new ProviderTranscriptFile(
        appSessionId,
        () => this.registry.getLive(appSessionId)?.summary ?? summary,
      ),
    );
  }

  private async runPrimaryTurn(
    liveSession: LiveSession,
    prompt: string,
    mentions?: ProviderMention[],
    delivery?: ScheduledTurnDelivery,
  ): Promise<void> {
    await runPrimaryTurn(
      {
        eventFlow: this.eventFlow,
        context: this.context,
        timeline: this.timeline,
        contextTarget: (target) => this.primaryContextTarget(target),
        isCurrent: (target) => this.isCurrentPrimarySession(target),
        applyDesignToolPolicy: (target, design) => this.applyDesignToolPolicy(target, design),
        updateSummary: (appSessionId, patch) => {
          this.registry.updateSummary(appSessionId, patch);
        },
        emitError: (error) => {
          this.emitError(error);
        },
      },
      liveSession,
      prompt,
      mentions,
      delivery,
    );
  }

  private isCurrentPrimarySession(liveSession: LiveSession): boolean {
    return (
      !this.shutdownPromise &&
      this.registry.getLive(liveSession.summary.appSessionId) === liveSession &&
      !hasSessionCloseStarted(liveSession)
    );
  }

  // Context stats and compaction are Droid's own; a session on any other
  // provider has no target and every caller skips that work.
  private primaryContextTarget(liveSession: LiveSession): LiveOperationTarget | undefined {
    const droid = liveSession.droid;
    if (!droid) return undefined;
    const session = liveSession.session;
    return {
      appSessionId: liveSession.summary.appSessionId,
      providerSessionId: session.providerSessionId,
      sourceSessionId: liveSession.summary.appSessionId,
      session: droid,
      isCurrent: () => this.isCurrentPrimarySession(liveSession) && liveSession.session === session,
    };
  }

  private primaryAutomaticCompactionTarget(
    liveSession: LiveSession,
  ): PrimaryAutomaticCompactionTarget | undefined {
    const target = this.primaryContextTarget(liveSession);
    return target ? { ...target, kind: 'primary', liveSession } : undefined;
  }

  private primaryCompactionTarget(liveSession: LiveSession): PrimaryCompactionTarget | undefined {
    const target = this.primaryAutomaticCompactionTarget(liveSession);
    if (!target) return undefined;
    const configuredModelId = liveSession.summary.modelId;
    const defaultsMode = defaultsModeForSummary(liveSession.summary);
    return {
      ...target,
      configuredModelId,
      defaultsMode,
      isCurrent: () =>
        target.isCurrent() &&
        liveSession.summary.modelId === configuredModelId &&
        defaultsModeForSummary(liveSession.summary) === defaultsMode,
    };
  }

  // Design turns are a single focused task (extra prompts queue), so the model
  // does not need TodoWrite — it otherwise loops updating the list after it has
  // already answered. Disable TodoWrite for design turns and restore it for
  // normal turns, calling updateSettings only when the policy changes.
  private async applyDesignToolPolicy(liveSession: LiveSession, design: boolean): Promise<boolean> {
    // When the in-memory flag is unset (cold start / page reload) we don't
    // know the session's current disabledToolIds, so always call updateSettings
    // to synchronize. Once the flag is set we skip redundant calls.
    const droid = liveSession.droid;
    // The design tool policy is a Droid setting; other providers run design
    // turns with their own tool set, so there is nothing to apply.
    if (!droid) return true;
    if (
      liveSession.todoDisabledForDesign !== undefined &&
      liveSession.todoDisabledForDesign === design
    )
      return true;
    if (!this.isCurrentPrimarySession(liveSession)) return false;
    try {
      await droid.updateSettings({ disabledToolIds: design ? ['TodoWrite'] : [] });
      if (!this.isCurrentPrimarySession(liveSession)) return false;
      liveSession.todoDisabledForDesign = design;
      return true;
    } catch (err) {
      if (!this.isCurrentPrimarySession(liveSession)) return false;
      this.emitError({
        appSessionId: liveSession.summary.appSessionId,
        message: `Could not update design tool policy: ${errMsg(err)}`,
      });
      return false;
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
    const roleModelId = role === 'validator' ? summary.validatorModelId : summary.workerModelId;
    const roleReasoningEffort =
      role === 'validator' ? summary.validatorReasoningEffort : summary.workerReasoningEffort;
    const catalogDefault = this.resolveCatalogDefaultSettings();
    return {
      modelId: summary.modelId ?? parentSettings.modelId ?? roleModelId ?? catalogDefault.modelId,
      reasoningEffort:
        summary.reasoningEffort ??
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
    return this.primaryAutomaticCompactionTarget(parent);
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
            providerSessionId: previousLiveSession?.session.providerSessionId,
            message: `Could not fully close the compacted session: ${errMsg(closeFailure.error)}`,
            recoverable: true,
          });
        }
        this.emitError({
          appSessionId: result.appSessionId,
          providerSessionId: result.providerSessionId,
          message: `Compaction moved this conversation to a new session but reloading it failed: ${result.reloadError}. It will reload on your next message.`,
          recoverable: true,
        });
      }
      readyToSettle = true;
    } finally {
      if (readyToSettle) {
        await this.lifecycle.settleAfterCompaction(appSessionId, previousLiveSession);
      } else {
        this.onSessionAvailable?.(appSessionId);
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

  private setAutonomy(appSessionId: string, autonomy: Autonomy): Promise<void> {
    const tail = this.autonomyMutationTails.get(appSessionId) ?? Promise.resolve();
    // A rejected predecessor must not drop the changes queued behind it.
    const next = tail.catch(() => undefined).then(() => this.applyAutonomy(appSessionId, autonomy));
    this.autonomyMutationTails.set(appSessionId, next);
    return next.finally(() => {
      if (this.autonomyMutationTails.get(appSessionId) === next) {
        this.autonomyMutationTails.delete(appSessionId);
      }
    });
  }

  private async applyAutonomy(appSessionId: string, autonomy: Autonomy): Promise<void> {
    const liveSession = this.registry.getLive(appSessionId);
    if (!liveSession) {
      this.emitError({
        code: 'session.autonomy_update_failed',
        appSessionId,
        message: 'Autonomy can only be changed on a live session.',
        recoverable: true,
      });
      return;
    }
    const nextAutonomy = normalizeAutonomy(autonomy);
    if (!nextAutonomy) {
      this.emitError({
        code: 'session.autonomy_update_failed',
        appSessionId,
        message: `Unsupported autonomy level: ${autonomy}`,
        recoverable: true,
      });
      return;
    }
    if (liveSession.summary.autonomy === nextAutonomy) return;
    const session = liveSession.session;
    try {
      await session.setAutonomy(nextAutonomy);
    } catch (err) {
      this.emitError({
        code: 'session.autonomy_update_failed',
        appSessionId,
        message: `Could not change autonomy: ${errMsg(err)}`,
        recoverable: true,
      });
      return;
    }
    // The provider accepted the change, but the session may have closed or its
    // provider session may have been swapped (compaction/resume) while the
    // request was in flight. Publish only when the captured session is still
    // the live one so a stale settlement cannot clobber its replacement.
    if (
      this.shutdownPromise ||
      this.registry.getLive(appSessionId) !== liveSession ||
      liveSession.session !== session ||
      hasSessionCloseStarted(liveSession)
    ) {
      // Dropping the confirmation silently would leave the caller's pending
      // state spinning forever; settle it with a recoverable error instead.
      this.emitError({
        code: 'session.autonomy_update_failed',
        appSessionId,
        message: 'Autonomy change was interrupted by a session restart or close.',
        recoverable: true,
      });
      return;
    }
    try {
      this.registry.updateSummary(appSessionId, { autonomy: nextAutonomy });
    } catch (err) {
      this.emitError({
        code: 'session.autonomy_update_failed',
        appSessionId,
        message: `Could not record the autonomy change: ${errMsg(err)}`,
        recoverable: true,
      });
    }
  }

  private async setInteractionMode(
    appSessionId: string,
    mode: SessionInteractionMode,
  ): Promise<void> {
    const liveSession = this.registry.getLive(appSessionId);
    if (!liveSession) {
      this.emitError({
        appSessionId,
        message: 'Interaction mode can only be changed on a live session.',
      });
      return;
    }
    const stableAppSessionId = liveSession.summary.appSessionId;
    const session = liveSession.session;
    // A provider without a planning mode of its own runs in Auto always, and
    // the composer offers it no Spec toggle.
    if (!session.setInteractionMode) return;
    // Compaction or a close can replace the session, or its provider session,
    // while the provider is answering; the mode belongs to the session that
    // asked for it, not to whatever took its place.
    const stillThisSession = () =>
      this.isCurrentPrimarySession(liveSession) && liveSession.session === session;
    try {
      await session.setInteractionMode(mode);
      if (!stillThisSession()) return;
      if (liveSession.droid && mode === 'spec')
        await this.alignSpecModeModel(liveSession.droid, liveSession.summary);
      if (!stillThisSession()) return;
      this.registry.updateSummary(stableAppSessionId, { interactionMode: mode });
      // The mode determines the default model when none is pinned, so the
      // auto-compaction threshold must be recomputed for the new mode.
      const compactionTarget = this.primaryCompactionTarget(liveSession);
      if (compactionTarget) await this.compaction.rearmPrimary(compactionTarget);
    } catch (err) {
      this.emitError({
        appSessionId: stableAppSessionId,
        message: `Could not switch interaction mode: ${errMsg(err)}`,
      });
    }
  }

  // An approved Spec plan runs in Auto, and a plan whose approval could not be
  // recorded goes back to planning. Only the provider switch lives here; the
  // interaction layer owns the summary update that goes with it.
  private async setProviderSpecMode(appSessionId: string, spec: boolean): Promise<void> {
    const session = this.registry.getLive(appSessionId)?.session;
    await session?.setInteractionMode?.(spec ? 'spec' : 'auto');
  }

  // Spec-mode turns run on specModeModelId. Align it with the session's visible
  // model so toggling into spec never switches models silently.
  private async alignSpecModeModel(droid: FactorySession, summary: SessionSummary): Promise<void> {
    const { modelId, reasoningEffort } = summary;
    if (!modelId) return;
    const specSettings: Record<string, unknown> = { specModeModelId: modelId };
    if (reasoningEffort) specSettings.specModeReasoningEffort = reasoningEffort;
    await droid.updateSettings(specSettings);
  }

  private async renameSession(requestedAppSessionId: string, title: string): Promise<void> {
    // Renderer metadata caps titles at 200 chars (MAX_CHAT_TITLE_LENGTH); the
    // bridge is the trusted boundary, so clamp here too before forwarding to
    // the harness.
    const safeTitle = title.trim().slice(0, 200);
    // Droid keeps the title in its own session file and has to be told; every
    // other provider's title is DROIDEX's alone, so only the daemon call is
    // skipped and the chat is still renamed.
    if (this.sessionProvider(requestedAppSessionId) === DEFAULT_PROVIDER)
      await this.withSession(requestedAppSessionId, (session) =>
        session.renameSession({ title: safeTitle }),
      );
    const appSessionId =
      this.registry.getLive(requestedAppSessionId)?.summary.appSessionId ??
      this.registry.resolveSummary(requestedAppSessionId)?.appSessionId;
    if (appSessionId) this.registry.updateSummary(appSessionId, { title: safeTitle });
  }

  // Every provider this build knows is routed here, so a new kind fails the
  // build rather than a session.
  private providerFor(kind: ProviderKind): Provider {
    switch (kind) {
      case 'droid':
        return this.droidProvider;
      case 'claude':
        return this.claudeProvider;
      case 'codex':
        return this.codexProvider;
    }
  }

  private sessionProvider(appSessionId: string): ProviderKind {
    return (
      this.registry.getLive(appSessionId)?.summary.provider ??
      this.registry.resolveSummary(appSessionId)?.provider ??
      DEFAULT_PROVIDER
    );
  }

  // Runs a Droid-only operation against the session's daemon: the live one, or
  // a loaded copy when the session is closed. A session on another provider has
  // no daemon behind it, so the operation is refused with its reason.
  private async withSession<T>(
    appSessionId: string,
    fn: (session: FactorySession) => Promise<T>,
  ): Promise<T | undefined> {
    const liveSession = this.registry.getLive(appSessionId);
    if (liveSession) return fn(requireDroidSession(liveSession.session));
    const provider = this.sessionProvider(appSessionId);
    if (provider !== DEFAULT_PROVIDER)
      throw new Error(`This is not supported for sessions on the ${provider} provider.`);
    const providerSessionId =
      this.registry.resolveSummary(appSessionId)?.providerSessionId ?? appSessionId;
    const session = await this.runtime.loadSession(providerSessionId);
    try {
      return await fn(session);
    } finally {
      await session.close();
    }
  }

  private async catalogSession(
    providerSessionId?: string,
  ): Promise<{ session: FactorySession; close: () => Promise<void> }> {
    const first = this.registry.liveSessionsSnapshot().at(0);
    const live = providerSessionId ? this.registry.getLive(providerSessionId)?.droid : first?.droid;
    if (live) return { session: live, close: () => Promise.resolve() };
    const session = await this.runtime.createSession({
      cwd: tmpdir(),
      interactionMode: 'auto',
      autonomyLevel: 'low',
    });
    return { session, close: () => session.close() };
  }

  // Tool discovery remains Droid-only. Skill-style catalogs belong to the
  // provider session named by the request, while an unbound draft keeps Droid's
  // existing discovery path.
  private isDroidCatalogTarget(providerSessionId?: string): boolean {
    return (
      providerSessionId === undefined ||
      this.sessionProvider(providerSessionId) === DEFAULT_PROVIDER
    );
  }

  private async emitToolCatalog(providerSessionId?: string): Promise<void> {
    if (!this.isDroidCatalogTarget(providerSessionId)) {
      this.emit({ type: 'catalog.updated', catalog: 'tools', items: [] });
      return;
    }
    const { session, close } = await this.catalogSession(providerSessionId);
    try {
      const result = await session.listTools();
      this.emit({ type: 'catalog.updated', catalog: 'tools', items: arrayItems(result, 'tools') });
    } finally {
      await close();
    }
  }

  private async emitSkillCatalog(providerSessionId?: string): Promise<void> {
    const liveSession = providerSessionId ? this.registry.getLive(providerSessionId) : undefined;
    const provider = providerSessionId ? this.sessionProvider(providerSessionId) : DEFAULT_PROVIDER;
    if (provider !== DEFAULT_PROVIDER) {
      const session = liveSession?.session;
      const items = session?.catalogItems
        ? await session.catalogItems()
        : (this.providerProbes.status(provider)?.items ?? []);
      if (
        liveSession &&
        (this.registry.getLive(liveSession.summary.appSessionId) !== liveSession ||
          liveSession.session !== session)
      )
        return;
      this.emit({
        type: 'catalog.updated',
        catalog: 'skills',
        items,
        providerSessionId: providerSessionId ?? null,
      });
      return;
    }
    const { session, close } = await this.catalogSession(providerSessionId);
    try {
      const result = await session.listSkills();
      this.emit({
        type: 'catalog.updated',
        catalog: 'skills',
        items: droidCatalogItems(arrayItems(result, 'skills')),
        providerSessionId: providerSessionId ?? null,
      });
    } finally {
      await close();
    }
  }

  private emitError(error: {
    code?: string;
    clientRef?: string;
    requestId?: string;
    providerSessionId?: string;
    appSessionId?: string;
    message: string;
    recoverable?: boolean;
  }): void {
    this.emit({ type: 'error', ...error });
  }

  shutdown(): Promise<void> {
    this.shutdownPromise ??= Promise.resolve().then(() => this.performShutdown());
    return this.shutdownPromise;
  }

  private async performShutdown(): Promise<void> {
    this.historyQueries.forget();
    this.runtimeRetirement.stop();
    this.providerProbes.cancel();
    let firstError: unknown;
    const run = async (action: () => void | Promise<void>): Promise<void> => {
      try {
        await action();
      } catch (error) {
        firstError ??= error;
      }
    };

    await run(() => this.sessionFiles.close());
    await run(() => this.lifecycle.closeAll());
    await run(() => this.childSessions.shutdown());
    // After closeAll: every session's close is what kills its processes.
    await run(() => {
      this.agentProcesses.dispose();
    });
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
    await run(() => {
      this.timeline.flushStreaming();
    });
    await run(() => {
      this.history.close();
    });
    if (firstError !== undefined)
      throw firstError instanceof Error ? firstError : new Error(errMsg(firstError));
  }
}

function hasSessionCloseStarted(liveSession: LiveSession): boolean {
  return liveSession.closeMode !== undefined;
}

function childSessionSettingsFromInit(init: SessionInitResult): ChildSettings {
  return {
    modelId: init.settings?.modelId,
    reasoningEffort: reasoningValue(init.settings?.reasoningEffort),
  };
}

function arrayItems(result: unknown, key: string): unknown[] {
  const record = result && typeof result === 'object' ? (result as Record<string, unknown>) : {};
  const value = record[key];
  if (Array.isArray(value)) return value;
  return [result];
}

/**
 * Guards an automation's model selection. Custom and BYOK models are absent
 * from the CLI catalog, so an unknown id stays valid and a reasoning level is
 * rejected only when the catalog actually declares the supported levels.
 */
function assertAutomationSelectionSupported(
  modelId: string,
  reasoningEffort: ReasoningEffort,
  models: ModelInfo[],
): void {
  if (!modelId.trim()) throw new Error('Choose a model for this automation.');
  const model = models.find((candidate) => candidate.id === modelId);
  const supported = model?.supportedReasoningEfforts;
  if (model && supported?.length && !supported.includes(reasoningEffort)) {
    throw new Error(
      `${model.displayName} does not support ${reasoningEffort} reasoning. Pick one of: ${supported.join(', ')}.`,
    );
  }
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

function resolveAutomationReasoningEffort(
  summary: SessionSummary,
  modelId: string | null,
  defaultReasoning: ReasoningEffort | undefined,
  models: ModelInfo[],
): ReasoningEffort | null {
  if (summary.reasoningEffort) return summary.reasoningEffort;
  const model = modelId ? models.find((candidate) => candidate.id === modelId) : undefined;
  return (
    validReasoning(modelId ?? undefined, defaultReasoning, models) ??
    model?.defaultReasoningEffort ??
    model?.supportedReasoningEfforts?.at(0) ??
    null
  );
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
