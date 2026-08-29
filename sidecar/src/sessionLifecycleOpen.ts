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
  droidReasoningEffortFromSelection,
  droidSessionConfiguration,
} from './providers/providerIdentity.js';
import {
  assertConfigurationMatchesAdapter,
  type ProviderSession,
  type ProviderSessionCreateInput,
} from './providers/providerTypes.js';
import { ShutdownDeadline } from './providers/shutdownDeadline.js';
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
  try {
    const configuration = requireCreateConfiguration(command);
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
    const expectedGeneration = 1;
    const openInput = providerOpenInput(host, {
      appSessionId: `pending:${command.clientRef}`,
      configuration,
      expectedGeneration,
      cwd: runtimeCwd,
    });
    d.prepareProviderOpen?.({
      command,
      configuration,
      defaults,
      compactionModel,
      compactionTokenLimit,
      sessionPurpose: command.sessionPurpose,
      ...(mission !== undefined ? { mission } : {}),
    });
    const provider = await adapter.create(openInput);
    pendingProvider = provider;
    requireOpenAdmission(d);
    const appSessionId = provider.providerSessionId;
    if (host.discardedOpens.has(appSessionId)) {
      await provider.close(zeroDeadline());
      return;
    }
    const native = requireNativeHandle(provider);
    const autoCompactionArmed = await d.compaction.arm(
      {
        session: native,
        provider,
        isCurrent: () => !d.isShutdownStarted() && pendingProvider === provider,
      },
      compactionTokenLimit,
    );
    requireOpenAdmission(d);
    if (host.discardedOpens.has(appSessionId)) {
      await provider.close(zeroDeadline());
      return;
    }
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
    persistInitialBinding(d, command, summary, provider, expectedGeneration);
    const liveSession = createLiveSession(d, summary, native, provider);
    liveSession.appliedNativeConfiguration = configuration;
    pendingLiveSession = liveSession;
    d.compaction.subscribePrimary(liveSession);
    d.registry.register(liveSession);
    d.childSessions.attachParent(appSessionId);
    provider.activate();
    d.emit({
      type: 'session.created',
      clientRef: command.clientRef,
      session: publishedSummary(d, appSessionId),
    });
    liveSession.acceptProviderEvents = true;
    host.driveInBackground(appSessionId, command.goal);
  } catch (error) {
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

export async function resumeAppSession(
  host: SessionOpenHost,
  requestedAppSessionId: string,
): Promise<boolean> {
  const d = host.dependencies;
  d.ensureConnected();
  const historical = d.registry.getCanonicalSummary(requestedAppSessionId);
  const appSessionId = historical?.appSessionId ?? requestedAppSessionId;
  const providerSessionId = historical?.providerSessionId ?? requestedAppSessionId;
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
    const stored = d.sessionStore?.get(appSessionId);
    const expectedGeneration = stored?.binding.runtimeGeneration ?? 1;
    const resumeState = stored?.binding.resumeState ?? {
      schemaVersion: 1 as const,
      sessionId: providerSessionId,
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
    d.emit({
      type: 'session.created',
      clientRef: `resume:${appSessionId}`,
      session: published,
    });
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

function persistInitialBinding(
  d: SessionLifecycleDependencies,
  command: SessionCreateCommand,
  summary: import('./protocol.js').SessionSummary,
  provider: ProviderSession,
  expectedGeneration: number,
): void {
  const store = d.sessionStore;
  if (!store) return;
  store.createProvisional({
    appSessionId: summary.appSessionId,
    clientRef: command.clientRef,
    summary,
  });
  store.bindInitialProviderRuntime(
    summary.appSessionId,
    expectedGeneration - 1,
    provider.providerSessionId,
    provider.initialResumeState,
  );
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
