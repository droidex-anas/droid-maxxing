import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { droidexUserDataDir } from './droidexPaths.js';
import { liveBindingFromSummary } from './SessionRegistry.js';
import {
  buildCreatedSessionSummary,
  buildResumedSession,
  createDefaultsModeForCommand,
  createMissionConfigurationForMode,
  errMsg,
  requireCreateConfiguration,
} from './sessionHelpers.js';
import {
  allocateCreateIdentity,
  initializingCreateSummary,
  markFailedOpen,
  markFailedResume,
  noteCreateBoundary,
  persistInitialBinding,
  persistProvisionalIdentity,
  providerFailedOpen,
  type AllocatedCreateIdentity,
} from './sessionCreateIdentity.js';
import { requireStoredSession, UnknownAppSessionError } from './sessionCanonicalServing.js';
import {
  droidReasoningEffortFromSelection,
  droidSessionConfiguration,
} from './providers/providerIdentity.js';
import {
  assertConfigurationMatchesAdapter,
  type ProviderSession,
  type ProviderSessionCreateInput,
} from './providers/providerTypes.js';
import { ShutdownDeadline } from './providers/shutdownDeadline.js';
import type { StoredSession } from './persistence/SessionStore.js';
import type {
  LiveNativeSession,
  LiveSession,
  SessionCreateCommand,
  SessionLifecycleDependencies,
} from './SessionLifecycle.js';

export interface SessionOpenHost {
  readonly dependencies: SessionLifecycleDependencies;
  discardedOpens: Set<string>;
  handleProviderEvent(
    liveSession: LiveSession,
    event: import('./providers/providerEvents.js').ProviderRuntimeEvent,
  ): void;
  nextId(): string;
  driveInBackground(appSessionId: string, prompt: string): void;
  cleanupFailedOpen(
    provider: ProviderSession | undefined,
    liveSession: LiveSession | undefined,
  ): Promise<void>;
}

export async function createAppSession(
  host: SessionOpenHost,
  command: SessionCreateCommand,
): Promise<void> {
  const d = host.dependencies;
  d.ensureConnected();
  let pendingProvider: ProviderSession | undefined;
  let pendingLiveSession: LiveSession | undefined;
  let allocated: AllocatedCreateIdentity | undefined;
  try {
    const configuration = requireCreateConfiguration(command);
    const existing = d.sessionStore?.findByClientRef(command.clientRef);
    if (existing) {
      emitExistingCreateOutcome(d, command, existing);
      return;
    }
    allocated = allocateCreateIdentity(d, () => host.nextId());
    noteCreateBoundary(d, 'identity-allocated');
    const initializing = initializingCreateSummary(command, allocated.appSessionId, configuration);
    noteCreateBoundary(d, 'summary-initialized');
    persistProvisionalIdentity(d, command, initializing, allocated.turnId);
    noteCreateBoundary(d, 'provisional-persisted');
    const opened = await activatePersistedCreate(host, {
      command,
      allocated,
      configuration,
      expectedGeneration: 1,
      publish: 'created',
      startGoal: true,
      pending: { setProvider: (provider) => { pendingProvider = provider; }, setLive: (live) => { pendingLiveSession = live; } },
    });
    pendingProvider = opened.provider;
    pendingLiveSession = opened.liveSession;
  } catch (error) {
    markFailedOpen(d, command, allocated, error);
    await host.cleanupFailedOpen(pendingProvider, pendingLiveSession);
    if (!isOpenAdmissionClosed(error)) {
      d.emitError({
        code: 'session.create_failed',
        clientRef: command.clientRef,
        message: errMsg(error),
      });
    }
  }
}

export async function activatePersistedCreate(
  host: SessionOpenHost,
  input: {
    command: SessionCreateCommand;
    allocated: AllocatedCreateIdentity;
    configuration: import('./protocol.js').SessionConfiguration;
    expectedGeneration: number;
    publish: 'created' | 'updated';
    startGoal: boolean;
    pending: {
      setProvider: (provider: ProviderSession) => void;
      setLive: (live: LiveSession) => void;
    };
  },
): Promise<{ provider: ProviderSession; liveSession: LiveSession }> {
  const d = host.dependencies;
  const { command, allocated, configuration } = input;
  const defaults = await d.getFactoryDefaults();
  const defaultsMode = createDefaultsModeForCommand(command, configuration.interactionMode);
  const primary = {
    modelId: configuration.providerSelection.modelId,
    reasoningEffort: droidReasoningEffortFromSelection(configuration.providerSelection),
  };
  const mission = createMissionConfigurationForMode(defaultsMode, command, defaults);
  const compactionModel = command.compactionModel ?? defaults.compactionModel ?? 'current-model';
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
  const runtimeCwd = await sessionRuntimeCwd(command.cwd ?? '');
  requireOpenAdmission(d);
  const adapter = d.providers.resolve(configuration.providerSelection.providerInstanceId);
  assertConfigurationMatchesAdapter(adapter.definition, configuration);
  requireOpenAdmission(d);
  const expectedGeneration = input.expectedGeneration;
  const appSessionId = allocated.appSessionId;
  const openInput = providerOpenInput(host, {
    appSessionId,
    configuration,
    expectedGeneration,
    cwd: runtimeCwd,
  });
  d.prepareProviderOpen?.({
    command,
    appSessionId,
    configuration,
    defaults,
    compactionModel,
    compactionTokenLimit,
    sessionPurpose: command.sessionPurpose,
    ...(mission !== undefined ? { mission } : {}),
  });
  noteCreateBoundary(d, 'before-provider-open');
  const provider = await adapter.create(openInput);
  input.pending.setProvider(provider);
  noteCreateBoundary(d, 'provider-opened');
  requireOpenAdmission(d);
  const overflow = providerFailedOpen(provider);
  if (overflow) throw overflow;
  if (host.discardedOpens.has(appSessionId)) {
    await provider.close(zeroDeadline());
    throw new OpenAdmissionClosedError();
  }
  const native = requireNativeHandle(provider);
  const autoCompactionArmed = await d.compaction.arm(
    {
      session: native,
      provider,
      isCurrent: () => !d.isShutdownStarted(),
    },
    compactionTokenLimit,
  );
  requireOpenAdmission(d);
  if (host.discardedOpens.has(appSessionId)) {
    await provider.close(zeroDeadline());
    throw new OpenAdmissionClosedError();
  }
  const overflowAfterArm = providerFailedOpen(provider);
  if (overflowAfterArm) throw overflowAfterArm;
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
  persistInitialBinding(d, appSessionId, provider, expectedGeneration);
  noteCreateBoundary(d, 'binding-persisted');
  const liveSession = createLiveSession(d, summary, native, provider);
  liveSession.reservedTurnId = allocated.turnId;
  liveSession.appliedNativeConfiguration = configuration;
  input.pending.setLive(liveSession);
  d.compaction.subscribePrimary(liveSession);
  d.registry.register(liveSession);
  d.childSessions.attachParent(appSessionId);
  liveSession.acceptProviderEvents = true;
  provider.activate();
  if (input.publish === 'created') {
    d.emit({
      type: 'session.created',
      clientRef: command.clientRef,
      session: publishedSummary(d, appSessionId),
    });
  } else {
    d.emit({ type: 'session.updated', session: publishedSummary(d, appSessionId) });
  }
  noteCreateBoundary(d, 'activated');
  if (input.startGoal) host.driveInBackground(appSessionId, command.goal);
  return { provider, liveSession };
}

export async function resumeAppSession(
  host: SessionOpenHost,
  requestedAppSessionId: string,
  options: { publishCreated?: boolean } = {},
): Promise<boolean> {
  const d = host.dependencies;
  d.ensureConnected();
  let stored;
  try {
    stored = d.sessionStore
      ? requireStoredSession(d.sessionStore, requestedAppSessionId)
      : undefined;
  } catch (error) {
    if (error instanceof UnknownAppSessionError) {
      d.emitError({
        appSessionId: requestedAppSessionId,
        code: 'session.resume_failed',
        message: error.message,
      });
      return false;
    }
    throw error;
  }
  const historical = stored?.summary ?? d.registry.getCanonicalSummary(requestedAppSessionId);
  const appSessionId = stored?.summary.appSessionId ?? requestedAppSessionId;
  const providerSessionId =
    stored?.binding.providerSessionId ??
    (d.sessionStore ? undefined : (historical?.providerSessionId ?? requestedAppSessionId));
  if (
    d.sessionStore &&
    (providerSessionId === undefined || stored?.binding.resumeState === undefined)
  ) {
    const error = new Error('Stored session has no provider binding to resume.');
    markFailedResume(d, appSessionId, error);
    d.emitError({ appSessionId, code: 'session.resume_failed', message: error.message });
    return false;
  }
  const existing = d.registry.getLive(appSessionId);
  if (existing) {
    d.emit({
      type: 'session.created',
      clientRef: `resume:${appSessionId}`,
      session: publishedSummary(d, appSessionId),
    });
    void d.context.refresh(existing);
    return true;
  }
  if (historical) host.discardedOpens.delete(appSessionId);
  let pendingProvider: ProviderSession | undefined;
  let pendingLiveSession: LiveSession | undefined;
  try {
    const configuration =
      historical?.configuration ??
      droidSessionConfiguration({
        modelId: 'default',
        interactionMode: 'auto',
        autonomy: 'low',
      });
    const adapter = d.providers.resolve(configuration.providerSelection.providerInstanceId);
    assertConfigurationMatchesAdapter(adapter.definition, configuration);
    const expectedGeneration = stored?.binding.runtimeGeneration ?? 1;
    const resumeState = stored?.binding.resumeState ?? {
      schemaVersion: 1 as const,
      sessionId: providerSessionId ?? requestedAppSessionId,
    };
    const provider = await adapter.resume({
      ...providerOpenInput(host, {
        appSessionId,
        configuration,
        expectedGeneration,
        cwd: historical?.cwd ?? '',
      }),
      resumeState,
    });
    pendingProvider = provider;
    const session = requireNativeHandle(provider);
    const defaults = await d.getFactoryDefaults();
    const resumed = buildResumedSession({
      init: session.initResult ?? {},
      historical,
      appSessionId,
      providerSessionId: providerSessionId ?? requestedAppSessionId,
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
    requireOpenAdmission(d);
    if (host.discardedOpens.has(appSessionId)) {
      await provider.close(zeroDeadline());
      return false;
    }
    if (
      await d.compaction.arm(
        {
          appSessionId,
          session,
          provider,
          isCurrent: () => !d.isShutdownStarted() && pendingProvider === provider,
        },
        limit,
      )
    ) {
      summary.compactionTokenLimit = limit;
    }
    requireOpenAdmission(d);
    const liveSession = createLiveSession(d, summary, session, provider);
    liveSession.appliedNativeConfiguration = summary.configuration;
    pendingLiveSession = liveSession;
    d.compaction.subscribePrimary(liveSession);
    d.registry.register(liveSession);
    d.childSessions.attachParent(appSessionId);
    provider.activate();
    const published = publishedSummary(d, appSessionId);
    if (options.publishCreated !== false) {
      d.emit({
        type: 'session.created',
        clientRef: `resume:${appSessionId}`,
        session: published,
      });
    }
    liveSession.acceptProviderEvents = true;
    d.emit({ type: 'session.updated', session: published });
    if (published.sessionPurpose === 'mission-control' && published.features.length > 0) {
      d.emit({
        type: 'mission.features',
        appSessionId,
        ...(published.missionId !== undefined ? { missionId: published.missionId } : {}),
        features: published.features,
      });
    }
    void d.context.refresh(liveSession);
    return true;
  } catch (error) {
    markFailedResume(d, appSessionId, error);
    await host.cleanupFailedOpen(pendingProvider, pendingLiveSession);
    if (!isOpenAdmissionClosed(error)) d.emitError({ appSessionId, message: errMsg(error) });
    return false;
  }
}

export function requireNativeHandle(provider: ProviderSession): LiveNativeSession {
  if (!('nativeSession' in provider)) throw new Error('Provider session has no native handle');
  const native = provider.nativeSession;
  if (!native || typeof native !== 'object' || !('sessionId' in native)) {
    throw new Error('Provider session has no native handle');
  }
  const sessionId = (native as { sessionId: unknown }).sessionId;
  if (typeof sessionId !== 'string') throw new Error('Provider session has no native handle');
  return native as LiveNativeSession;
}

export function hasSessionCloseStarted(liveSession: { closeMode?: string }): boolean {
  return liveSession.closeMode !== undefined;
}

export class OpenAdmissionClosedError extends Error {}

export function isOpenAdmissionClosed(error: unknown): boolean {
  return error instanceof OpenAdmissionClosedError;
}

function requireOpenAdmission(d: SessionLifecycleDependencies): void {
  if (d.isShutdownStarted()) throw new OpenAdmissionClosedError();
}

async function sessionRuntimeCwd(appCwd: string): Promise<string> {
  if (appCwd) return appCwd;
  const chatCwd = join(droidexUserDataDir(), 'chats');
  await mkdir(chatCwd, { recursive: true });
  return chatCwd;
}

function createLiveSession(
  d: SessionLifecycleDependencies,
  summary: import('./protocol.js').SessionSummary,
  session: LiveNativeSession,
  provider: ProviderSession,
): LiveSession {
  const resources = d.takeOpenedResources?.(provider) ?? { servers: [], configs: [] };
  const base = liveBindingFromSummary(summary);
  return {
    summary,
    binding: {
      ...base,
      providerSessionId: provider.providerSessionId,
      resumeState: provider.initialResumeState,
      runtimeGeneration: base.runtimeGeneration === 0 ? 1 : base.runtimeGeneration,
    },
    session,
    provider,
    streaming: false,
    pendingSends: [],
    mcpServers: resources.servers,
    mcpConfigs: resources.configs,
    autoCompacting: false,
  };
}

function providerOpenInput(
  host: SessionOpenHost,
  input: {
    appSessionId: string;
    configuration: ProviderSessionCreateInput['configuration'];
    expectedGeneration: number;
    cwd: string;
  },
): ProviderSessionCreateInput {
  const d = host.dependencies;
  let captured: LiveSession | undefined;
  return {
    target: { kind: 'session', appSessionId: input.appSessionId },
    configuration: input.configuration,
    expectedGeneration: input.expectedGeneration,
    cwd: input.cwd,
    eventSink: (event) => {
      const appSessionId =
        event.target.kind === 'session' ? event.target.appSessionId : input.appSessionId;
      captured = d.registry.getLive(appSessionId) ?? captured;
      if (!captured) return;
      host.handleProviderEvent(captured, event);
    },
    interactionSink: d.interactionSink,
    ids: {
      nextEventId: () => host.nextId(),
      nextProviderSessionId: () => host.nextId(),
    },
    clock: { now: () => Date.now() },
  };
}

function emitExistingCreateOutcome(
  d: SessionLifecycleDependencies,
  command: SessionCreateCommand,
  existing: StoredSession,
): void {
  if (existing.lifecycleStatus === 'failed') {
    d.emitError({
      code: 'session.create_failed',
      clientRef: command.clientRef,
      message: existing.failure?.message ?? 'Session start failed',
    });
    return;
  }
  d.emit({
    type: 'session.created',
    clientRef: command.clientRef,
    session: d.registry.resolveSummary(existing.summary.appSessionId) ?? existing.summary,
  });
}

function publishedSummary(
  d: SessionLifecycleDependencies,
  appSessionId: string,
): import('./protocol.js').SessionSummary {
  const summary = d.registry.resolveSummary(appSessionId);
  if (!summary) throw new Error(`Session ${appSessionId} has no published summary.`);
  return summary;
}

function zeroDeadline(): ShutdownDeadline {
  return ShutdownDeadline.fromDurationMs(0);
}
