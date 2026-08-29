import {
  createDroidSessionExtension,
  type FactorySession,
} from './providers/droid/DroidFactorySession.js';
import { requireDroidCapability } from './providers/droid/droidCapabilityGate.js';
import type { PersistedChildSession } from './history.js';
import type { ServerEvent } from './protocol.js';
import { errMsg } from './sessionHelpers.js';
import type { ChildAutomaticCompactionTarget } from './SessionCompaction.js';
import type { ChildOperationTarget } from './SessionContext.js';
import {
  childAcceptsWork,
  childHistoryProviderSessionIds,
  childIdentity,
  childSettingsFromInit,
  type ChildIdentity,
  type ChildOpenAttempt,
  type ChildRuntimeState,
  type ChildSessionState,
  type ParentChildSessions,
} from './ChildSessionState.js';
import type { ChildOperation, ChildSessionsDependencies } from './ChildSessionsTypes.js';
import { takeAdmittedSend } from './childTurnCancellation.js';

export const CHILD_OPEN_CANCELLED = Symbol('child-open-cancelled');
const ignoreError = (): undefined => undefined;

export interface ChildRuntimeInstallHost {
  d: ChildSessionsDependencies;
  isCurrentParent(parent: ParentChildSessions): boolean;
  isCurrentChild(parent: ParentChildSessions, child: ChildSessionState): boolean;
  isCurrentRuntime(
    parent: ParentChildSessions,
    child: ChildSessionState,
    runtime: ChildRuntimeState,
  ): boolean;
  reserveCapacity(
    parent: ParentChildSessions,
    child: ChildSessionState,
    operation: Exclude<ChildOperation, 'settings'>,
    requestId: string | null,
  ): Promise<boolean | 'queued'>;
  emitReady(runtime: ChildRuntimeState, child: ChildSessionState, requestId: string): void;
  emitError(
    identity: ChildIdentity,
    operation: ChildOperation,
    requestId: string | null,
    code: string,
    message: string,
  ): void;
  persist(child: ChildSessionState): boolean | undefined;
  publish(child: ChildSessionState): void;
  drive(parent: ParentChildSessions, child: ChildSessionState, text: string): Promise<void>;
  closeRuntime(
    parent: ParentChildSessions,
    child: ChildSessionState,
    publish: boolean,
  ): Promise<void>;
  admitNextQueued(parent: ParentChildSessions): void;
  automaticTarget(
    parent: ParentChildSessions,
    child: ChildSessionState,
  ): ChildAutomaticCompactionTarget;
  contextTarget(
    parent: ParentChildSessions,
    child: ChildSessionState,
    runtime: ChildRuntimeState,
  ): ChildOperationTarget;
  onOpenAttemptFinished(): void;
}

export function beginOpenAttempt(
  parent: ParentChildSessions,
  childSessionId: string,
): ChildOpenAttempt {
  let settle: () => void = ignoreError;
  let cancel: () => void = ignoreError;
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const cancelled = new Promise<void>((resolve) => {
    cancel = resolve;
  });
  const attempt = { settled, settle, cancelled, cancel, isCancelled: false };
  parent.openAttempts.set(childSessionId, attempt);
  return attempt;
}

export function isCurrentOpenAttempt(
  parent: ParentChildSessions,
  child: ChildSessionState,
  attempt: ChildOpenAttempt,
  isCurrentChild: (parent: ParentChildSessions, child: ChildSessionState) => boolean,
): boolean {
  return (
    isCurrentChild(parent, child) &&
    !attempt.isCancelled &&
    childAcceptsWork(child) &&
    !child.runtime &&
    parent.openAttempts.get(child.identity.childSessionId) === attempt
  );
}

export function finishOpenAttempt(
  parent: ParentChildSessions,
  childSessionId: string,
  attempt: ChildOpenAttempt,
  onFinished: () => void,
): void {
  if (parent.openAttempts.get(childSessionId) !== attempt) return;
  parent.openAttempts.delete(childSessionId);
  attempt.settle();
  // A child publishes while its open attempt is still outstanding, so this is
  // the first moment a freshly opened runtime can be seen as retirable.
  onFinished();
}

export async function cancelOpenAttempts(parent: ParentChildSessions): Promise<void> {
  const closes: Promise<void>[] = [];
  for (const attempt of parent.openAttempts.values()) {
    attempt.isCancelled = true;
    attempt.cancel();
    attempt.settle();
    if (attempt.provisionalSession) closes.push(closeProvisional(attempt));
  }
  parent.openAttempts.clear();
  await Promise.all(closes);
}

export function closeProvisional(attempt: ChildOpenAttempt): Promise<void> {
  if (!attempt.provisionalSession) return Promise.resolve();
  attempt.provisionalClose ??= attempt.provisionalSession.close().catch(ignoreError);
  return attempt.provisionalClose;
}

export async function awaitOpenStep<T>(
  attempt: ChildOpenAttempt,
  operation: Promise<T>,
  cleanupLate?: (value: T) => void | Promise<void>,
): Promise<T | typeof CHILD_OPEN_CANCELLED> {
  const result = await Promise.race<T | typeof CHILD_OPEN_CANCELLED>([
    operation,
    attempt.cancelled.then((): typeof CHILD_OPEN_CANCELLED => CHILD_OPEN_CANCELLED),
  ]);
  if (result === CHILD_OPEN_CANCELLED && cleanupLate) void operation.then(cleanupLate, ignoreError);
  return result;
}

export function openChildHistory(
  record: PersistedChildSession,
  operation: Exclude<ChildOperation, 'settings'>,
  requestId: string | null,
  host: {
    emitError: ChildRuntimeInstallHost['emitError'];
    emit(event: ServerEvent): void;
    loadChildHistory: ChildSessionsDependencies['timeline']['loadChildHistory'];
  },
): void {
  if (!record.transcriptAvailable || !record.providerSessionId) {
    host.emitError(
      childIdentity(record.parentAppSessionId, record.childSessionId),
      operation,
      requestId,
      'child.runtime_unavailable',
      'No transcript is available for this child session.',
    );
    return;
  }
  host.loadChildHistory({
    appSessionId: record.parentAppSessionId,
    childSessionId: record.childSessionId,
    childProviderSessionIds: childHistoryProviderSessionIds(record),
    role: record.role,
  });
  if (requestId)
    host.emit({
      type: 'child.updated',
      parentAppSessionId: record.parentAppSessionId,
      childSessionId: record.childSessionId,
      requestId,
      access: 'history',
    });
}

export async function installChildRuntime(input: {
  parent: ParentChildSessions;
  child: ChildSessionState;
  identity: ChildIdentity;
  requestId: string | null;
  operation: Exclude<ChildOperation, 'settings'>;
  host: ChildRuntimeInstallHost;
}): Promise<void> {
  const { parent, child, identity, requestId, operation, host } = input;
  requireDroidCapability(parent.lease, 'addressableChildren', `child.${operation}`);
  const providerSessionId = child.providerSessionId;
  if (!providerSessionId) return;
  const childSessionId = identity.childSessionId;
  const attempt = beginOpenAttempt(parent, childSessionId);
  const isCurrentAttempt = () =>
    isCurrentOpenAttempt(parent, child, attempt, (candidateParent, candidateChild) =>
      host.isCurrentChild(candidateParent, candidateChild),
    );
  let loaded: FactorySession | undefined;
  try {
    // Paint persisted history immediately. This is deliberately best effort:
    // a live child may not have flushed history yet, but its provider runtime
    // must still open without waiting for that file.
    host.d.timeline.loadChildHistory({
      appSessionId: identity.parentAppSessionId,
      childSessionId,
      childProviderSessionIds: childHistoryProviderSessionIds(child),
      role: child.role,
    });
    const admitted = await awaitOpenStep(
      attempt,
      host.reserveCapacity(parent, child, operation, requestId),
    );
    if (admitted === CHILD_OPEN_CANCELLED || admitted === 'queued' || !admitted) return;
    if (!isCurrentAttempt()) return;
    const ref = { id: identity.parentAppSessionId };
    const load = host.d.runtime.loadSession(providerSessionId, {
      permissionHandler: host.d.interactions.makePermissionHandler(ref),
      askUserHandler: host.d.interactions.makeAskUserHandler(ref),
      cwd: parent.lease.summary.cwd,
      mcpServers: parent.lease
        .mcpConfigs as import('./providers/droid/DroidModeMapping.js').McpServerConfig[],
    });
    const result = await awaitOpenStep(attempt, load, (late) => late.close().catch(ignoreError));
    if (result === CHILD_OPEN_CANCELLED) return;
    loaded = result;
    attempt.provisionalSession = loaded;
    await bindLoadedChildRuntime({
      parent,
      child,
      identity,
      requestId,
      host,
      attempt,
      loaded,
      isCurrentAttempt,
    });
  } catch (error) {
    const runtimeInstalled = loaded !== undefined && child.runtime?.session === loaded;
    const reportFailure = runtimeInstalled || isCurrentAttempt();
    if (runtimeInstalled) await host.closeRuntime(parent, child, false);
    if (reportFailure && host.isCurrentParent(parent))
      host.emitError(identity, operation, requestId, 'child.open_failed', errMsg(error));
  } finally {
    finishOpenAttempt(parent, childSessionId, attempt, () => {
      host.onOpenAttemptFinished();
    });
    parent.reservedOpenSlots.delete(childSessionId);
    if (loaded) await closeProvisional(attempt);
    host.admitNextQueued(parent);
  }
}

async function bindLoadedChildRuntime(input: {
  parent: ParentChildSessions;
  child: ChildSessionState;
  identity: ChildIdentity;
  requestId: string | null;
  host: ChildRuntimeInstallHost;
  attempt: ChildOpenAttempt;
  loaded: FactorySession;
  isCurrentAttempt: () => boolean;
}): Promise<void> {
  const { parent, child, identity, requestId, host, attempt, loaded, isCurrentAttempt } = input;
  if (!isCurrentAttempt()) return;
  const actual = childSettingsFromInit(loaded.initResult);
  const defaults = host.d.resolveDefaultSettings(
    parent.lease.summary,
    parent.lease.session.initResult ?? {},
    child.role,
  );
  const settings = {
    modelId: actual.modelId ?? child.modelId,
    reasoningEffort: actual.reasoningEffort ?? child.reasoningEffort ?? defaults.reasoningEffort,
  };
  if (!settings.modelId) throw new Error(`No accepted model is available for ${child.role}.`);
  const droid = createDroidSessionExtension(
    () => loaded,
    () => {
      throw new Error('child runtime cannot replace native session');
    },
  );
  const limit = await awaitOpenStep(
    attempt,
    host.d.compaction.resolveLimit({ modelId: settings.modelId }),
  );
  if (limit === CHILD_OPEN_CANCELLED || !isCurrentAttempt()) return;
  const armed = await awaitOpenStep(
    attempt,
    host.d.compaction.arm(
      {
        appSessionId: identity.parentAppSessionId,
        session: loaded,
        droid,
        isCurrent: () => attempt.provisionalSession === loaded && isCurrentAttempt(),
      },
      limit,
    ),
  );
  if (armed === CHILD_OPEN_CANCELLED || !isCurrentAttempt()) return;
  const runtime: ChildRuntimeState = {
    session: loaded,
    droid,
    generation: ++child.runtimeGeneration,
    lastUsedAt: host.d.now(),
  };
  child.runtime = runtime;
  attempt.provisionalSession = undefined;
  child.queued = false;
  child.queuedRequestId = undefined;
  child.modelId = settings.modelId;
  child.reasoningEffort = settings.reasoningEffort;
  child.autonomy = actual.autonomy;
  // Opening a runtime is how the app *watches* a child. A child the harness
  // is still driving (a background Task) keeps working while we mirror it,
  // so observing it must not report it as idle; only a turn we drive, an
  // interrupt, or a settlement may settle its status.
  if (child.status !== 'running') child.status = 'paused';
  child.transcriptAvailable = true;
  attachOpenedChildNotifications({ parent, child, runtime, loaded, identity, host });
  host.persist(child);
  host.publish(child);
  // Seed child context telemetry immediately so compaction policy can learn
  // a provider-reported model window before the first turn settles.
  void host.d.context.refresh(host.contextTarget(parent, child, runtime));
  if (requestId) host.emitReady(runtime, child, requestId);
  const queuedSend = takeAdmittedSend(child);
  if (queuedSend !== undefined) void host.drive(parent, child, queuedSend);
}

function attachOpenedChildNotifications(input: {
  parent: ParentChildSessions;
  child: ChildSessionState;
  runtime: ChildRuntimeState;
  loaded: FactorySession;
  identity: ChildIdentity;
  host: ChildRuntimeInstallHost;
}): void {
  const { parent, child, runtime, loaded, identity, host } = input;
  let active: ChildAutomaticCompactionTarget | undefined;
  runtime.unsubscribe = loaded.onNotification((note: Record<string, unknown>) => {
    if (!host.isCurrentRuntime(parent, child, runtime)) return;
    const target = active?.isAutoCompacting() ? active : host.automaticTarget(parent, child);
    if (!target.isCurrent()) return;
    if (host.d.compaction.handleChildNotification(target, note)) {
      active = target.isAutoCompacting() ? target : undefined;
      return;
    }
    if (!target.isCurrent()) return;
    host.d.eventFlow.applyNotification(
      identity.parentAppSessionId,
      runtime.session.sessionId,
      child.role,
      note,
      identity.childSessionId,
    );
  });
}
