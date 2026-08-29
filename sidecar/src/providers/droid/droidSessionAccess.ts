import type { SessionSummary } from '../../protocol.js';
import type { LiveSession } from '../../SessionLifecycle.js';
import type { LiveOperationTarget, ProviderOperationTarget } from '../../SessionContext.js';
import { defaultsModeForSummary } from '../../sessionHelpers.js';
import type {
  PrimaryAutomaticCompactionTarget,
  PrimaryCompactionTarget,
} from '../../SessionCompaction.js';
import type { FactorySession } from './DroidProviderSession.js';
import { createDroidSessionExtension, type DroidSessionExtension } from './DroidFactorySession.js';
import type { ProviderInstanceId } from '../providerIdentity.js';
import type { ProviderCapabilities, ProviderSession } from '../providerTypes.js';
import {
  capabilityEnabled,
  requireDroidCapability,
  requireDroidExtension,
  resolveDroidCapabilities,
  unsupportedDroidCapabilityError,
  type DroidCapabilityLive,
  type GatedDroidCapability,
} from './droidCapabilityGate.js';

export type CapabilitySnapshot = (id: ProviderInstanceId) => ProviderCapabilities | undefined;

export function snapshotProviderCapabilities(
  registry: {
    snapshot(id: ProviderInstanceId): { capabilities: ProviderCapabilities } | undefined;
  },
  providerInstanceId: ProviderInstanceId,
): ProviderCapabilities | undefined {
  return registry.snapshot(providerInstanceId)?.capabilities;
}

export function primaryLiveContextTarget(
  liveSession: LiveSession,
  droid: DroidSessionExtension,
  isCurrentPrimary: () => boolean,
): LiveOperationTarget {
  const session = liveSession.session;
  return {
    appSessionId: liveSession.summary.appSessionId,
    providerSessionId: session.sessionId,
    sourceSessionId: liveSession.summary.appSessionId,
    session,
    droid,
    isCurrent: () => isCurrentPrimary() && liveSession.session === session,
  };
}

export function primaryLiveCompactionTarget(
  liveSession: LiveSession,
  contextTarget: LiveOperationTarget,
): PrimaryAutomaticCompactionTarget {
  return { ...contextTarget, kind: 'primary', liveSession };
}

export function primaryLiveRetuneTarget(
  liveSession: LiveSession,
  automatic: PrimaryAutomaticCompactionTarget,
): PrimaryCompactionTarget {
  const configuredModelId = liveSession.summary.configuration.providerSelection.modelId;
  const defaultsMode = defaultsModeForSummary(liveSession.summary);
  return {
    ...automatic,
    configuredModelId,
    defaultsMode,
    isCurrent: () =>
      automatic.isCurrent() &&
      liveSession.summary.configuration.providerSelection.modelId === configuredModelId &&
      defaultsModeForSummary(liveSession.summary) === defaultsMode,
  };
}

export function requireLiveDroidCapability(
  live: DroidCapabilityLive,
  capability: GatedDroidCapability,
  operation: string,
  snapshotCapabilities: CapabilitySnapshot,
): DroidSessionExtension {
  return requireDroidCapability(
    live,
    capability,
    operation,
    snapshotCapabilities(live.binding.providerInstanceId),
  );
}

export function requireLiveBrowserCapability(
  live: DroidCapabilityLive | undefined,
  operation: string,
  snapshotCapabilities: CapabilitySnapshot,
): void {
  if (!live) return;
  requireLiveDroidCapability(live, 'browser', operation, snapshotCapabilities);
}

export function requireMcpManagementCapability(
  live: LiveSession | undefined,
  snapshotCapabilities: CapabilitySnapshot,
): void {
  const providerInstanceId = live?.binding.providerInstanceId ?? 'droid';
  const capabilities = resolveDroidCapabilities(
    providerInstanceId,
    live?.provider,
    snapshotCapabilities(providerInstanceId),
  );
  if (!capabilityEnabled(capabilities, 'mcpManagement')) {
    throw unsupportedDroidCapabilityError(providerInstanceId, 'mcp.manage', 'mcpManagement');
  }
  if (live) requireLiveDroidCapability(live, 'mcpManagement', 'mcp.manage', snapshotCapabilities);
}

export type CompactionArmInput = {
  session: ProviderOperationTarget['session'];
  isCurrent(): boolean;
  appSessionId?: string;
  provider?: ProviderSession;
};

export function managerContextTarget(
  live: LiveSession,
  snapshotCapabilities: CapabilitySnapshot,
  isCurrentPrimary: () => boolean,
): LiveOperationTarget {
  return primaryLiveContextTarget(
    live,
    requireLiveDroidCapability(live, 'context', 'refreshContext', snapshotCapabilities),
    isCurrentPrimary,
  );
}

export function managerAutomaticTarget(
  live: LiveSession,
  snapshotCapabilities: CapabilitySnapshot,
  isCurrentPrimary: () => boolean,
): PrimaryAutomaticCompactionTarget {
  return primaryLiveCompactionTarget(
    live,
    managerContextTarget(live, snapshotCapabilities, isCurrentPrimary),
  );
}

export function managerRetuneTarget(
  live: LiveSession,
  snapshotCapabilities: CapabilitySnapshot,
  isCurrentPrimary: () => boolean,
): PrimaryCompactionTarget {
  return primaryLiveRetuneTarget(
    live,
    managerAutomaticTarget(live, snapshotCapabilities, isCurrentPrimary),
  );
}

export function managerPrimaryTargets(
  live: LiveSession,
  snapshotCapabilities: CapabilitySnapshot,
  isCurrentPrimary: () => boolean,
): {
  context: LiveOperationTarget;
  automatic: PrimaryAutomaticCompactionTarget;
  retune: PrimaryCompactionTarget;
} {
  const context = managerContextTarget(live, snapshotCapabilities, isCurrentPrimary);
  const automatic = primaryLiveCompactionTarget(live, context);
  return { context, automatic, retune: primaryLiveRetuneTarget(live, automatic) };
}

function catalogResultItems(result: unknown, key: string): unknown[] {
  const record = result && typeof result === 'object' ? (result as Record<string, unknown>) : {};
  const value = record[key];
  if (Array.isArray(value)) return value;
  return [result];
}

export function emitHostDroidCatalogUpdate(
  host: SessionDroidHost,
  emit: (event: {
    type: 'catalog.updated';
    catalog: 'tools' | 'skills';
    items: unknown[];
    appSessionId?: string | null;
  }) => void,
  operation: 'listTools' | 'listSkills',
  appSessionId?: string,
  requestedProviderInstanceId?: ProviderInstanceId,
): Promise<void> {
  const catalog = operation === 'listTools' ? 'tools' : 'skills';
  return emitHostDroidCatalog(
    host,
    operation,
    (result) =>
      emit({
        type: 'catalog.updated',
        catalog,
        items: catalogResultItems(result, catalog),
        ...(operation === 'listSkills' ? { appSessionId: appSessionId ?? null } : {}),
      }),
    appSessionId,
    requestedProviderInstanceId,
  );
}

export function attachCompactionArmDroid(input: {
  session: ProviderOperationTarget['session'];
  isCurrent(): boolean;
  appSessionId?: string;
  provider?: ProviderSession;
  live?: LiveSession;
  snapshotCapabilities: CapabilitySnapshot;
}): ProviderOperationTarget & { appSessionId?: string; provider?: ProviderSession } {
  const provider = input.provider ?? input.live?.provider;
  const providerInstanceId =
    input.live?.binding.providerInstanceId ??
    input.live?.summary.configuration.providerSelection.providerInstanceId ??
    'droid';
  if (!provider) {
    throw unsupportedDroidCapabilityError(providerInstanceId, 'armAutoCompaction', 'compaction');
  }
  return {
    ...input,
    droid: requireDroidCapability(
      { binding: { providerInstanceId }, provider },
      'compaction',
      'armAutoCompaction',
      input.snapshotCapabilities(providerInstanceId),
    ),
  };
}

export async function emitDroidCatalogItems(input: {
  live: LiveSession | undefined;
  requestedProviderInstanceId?: ProviderInstanceId;
  operation: 'listTools' | 'listSkills';
  snapshotCapabilities: CapabilitySnapshot;
  createSession: () => Promise<FactorySession>;
  publish: (result: unknown) => void;
}): Promise<void> {
  if (input.requestedProviderInstanceId && input.requestedProviderInstanceId !== 'droid') {
    throw unsupportedDroidCapabilityError(
      input.requestedProviderInstanceId,
      input.operation,
      'skills',
    );
  }
  const { droid, close } = await catalogDroidSession({
    live: input.live,
    capability: 'skills',
    operation: input.operation,
    snapshotCapabilities: input.snapshotCapabilities,
    createSession: input.createSession,
  });
  try {
    input.publish(
      input.operation === 'listTools' ? await droid.listTools() : await droid.listSkills(),
    );
  } finally {
    await close();
  }
}

export async function withDroidSession<T>(input: {
  live: LiveSession | undefined;
  summary: SessionSummary | undefined;
  appSessionId: string;
  capability?: GatedDroidCapability;
  operation: string;
  snapshotCapabilities: (id: ProviderInstanceId) => ProviderCapabilities | undefined;
  loadSession: (providerSessionId: string) => Promise<FactorySession>;
  fn: (droid: DroidSessionExtension) => Promise<T>;
}): Promise<T | undefined> {
  const live = input.live;
  if (live) {
    return input.fn(
      input.capability
        ? requireDroidCapability(
            live,
            input.capability,
            input.operation,
            input.snapshotCapabilities(live.binding.providerInstanceId),
          )
        : requireDroidExtension(live.provider, input.operation, live.binding.providerInstanceId),
    );
  }
  const providerInstanceId =
    input.summary?.configuration.providerSelection.providerInstanceId ?? 'droid';
  const capabilities = resolveDroidCapabilities(
    providerInstanceId,
    undefined,
    input.snapshotCapabilities(providerInstanceId),
  );
  if (providerInstanceId !== 'droid') {
    throw unsupportedDroidCapabilityError(
      providerInstanceId,
      input.operation,
      input.capability ?? 'droid',
    );
  }
  if (input.capability && !capabilityEnabled(capabilities, input.capability)) {
    throw unsupportedDroidCapabilityError(providerInstanceId, input.operation, input.capability);
  }
  const session = await input.loadSession(input.summary?.providerSessionId ?? input.appSessionId);
  try {
    return await input.fn(
      createDroidSessionExtension(
        () => session,
        () => {
          throw new Error('historical session cannot replace native handle');
        },
      ),
    );
  } finally {
    await session.close();
  }
}

export interface SessionDroidHost {
  getLive(id: string): LiveSession | undefined;
  resolveSummary(id: string): SessionSummary | undefined;
  firstLive(): LiveSession | undefined;
  snapshotCapabilities: CapabilitySnapshot;
  loadSession(id: string): Promise<FactorySession>;
  createCatalogSession(): Promise<FactorySession>;
}

export function withHostDroidSession<T>(
  host: SessionDroidHost,
  appSessionId: string,
  capability: GatedDroidCapability | undefined,
  operation: string,
  fn: (droid: DroidSessionExtension) => Promise<T>,
): Promise<T | undefined> {
  return withDroidSession({
    live: host.getLive(appSessionId),
    summary: host.resolveSummary(appSessionId),
    appSessionId,
    ...(capability === undefined ? {} : { capability }),
    operation,
    snapshotCapabilities: host.snapshotCapabilities,
    loadSession: host.loadSession,
    fn,
  });
}

export async function emitHostDroidCatalog(
  host: SessionDroidHost,
  operation: 'listTools' | 'listSkills',
  publish: (result: unknown) => void,
  appSessionId?: string,
  requestedProviderInstanceId?: ProviderInstanceId,
): Promise<void> {
  await emitDroidCatalogItems({
    live: appSessionId ? host.getLive(appSessionId) : host.firstLive(),
    requestedProviderInstanceId,
    operation,
    snapshotCapabilities: host.snapshotCapabilities,
    createSession: host.createCatalogSession,
    publish,
  });
}

export async function catalogDroidSession(input: {
  live: LiveSession | undefined;
  capability: GatedDroidCapability;
  operation: string;
  snapshotCapabilities: (id: ProviderInstanceId) => ProviderCapabilities | undefined;
  createSession: () => Promise<FactorySession>;
}): Promise<{ droid: DroidSessionExtension; close: () => Promise<void> }> {
  const live = input.live;
  if (live) {
    return {
      droid: requireDroidCapability(
        live,
        input.capability,
        input.operation,
        input.snapshotCapabilities(live.binding.providerInstanceId),
      ),
      close: () => Promise.resolve(),
    };
  }
  const capabilities = resolveDroidCapabilities(
    'droid',
    undefined,
    input.snapshotCapabilities('droid'),
  );
  if (!capabilityEnabled(capabilities, input.capability)) {
    throw unsupportedDroidCapabilityError('droid', input.operation, input.capability);
  }
  const session = await input.createSession();
  return {
    droid: createDroidSessionExtension(
      () => session,
      () => {
        throw new Error('catalog session cannot replace native handle');
      },
    ),
    close: () => session.close(),
  };
}
