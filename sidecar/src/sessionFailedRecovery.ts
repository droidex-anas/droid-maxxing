import { activatePersistedCreate, resumeAppSession, type SessionOpenHost } from './sessionLifecycleOpen.js';
import { errMsg } from './sessionHelpers.js';
import { markFailedOpen } from './sessionCreateIdentity.js';
import type { SessionCreateCommand } from './sessionCreateIdentity.js';
import type { StoredSession } from './persistence/SessionStore.js';
import type { ProviderSession } from './providers/providerTypes.js';
import type { LiveSession } from './SessionLifecycle.js';

export async function retryFailedAppSession(
  host: SessionOpenHost,
  appSessionId: string,
): Promise<void> {
  const d = host.dependencies;
  d.ensureConnected();
  const store = d.sessionStore;
  if (!store?.beginRetryStart || !store.get) {
    d.emitError({
      code: 'session.retry_start_failed',
      appSessionId,
      message: 'Canonical session store is required to retry a failed start.',
    });
    return;
  }
  if (d.registry.getLive(appSessionId)) {
    d.emitError({
      code: 'session.retry_start_failed',
      appSessionId,
      message: `Session ${appSessionId} is live and cannot retry start.`,
    });
    return;
  }
  const current = store.get(appSessionId);
  if (!current) {
    d.emitError({
      code: 'session.retry_start_failed',
      appSessionId,
      message: `Session ${appSessionId} is not in the canonical store.`,
    });
    return;
  }
  const command = commandFromStored(current, `retry:${appSessionId}`);
  const turnId = d.nextTurnId?.() ?? host.nextId();
  const allocated = { appSessionId, turnId };
  let pendingProvider: ProviderSession | undefined;
  let pendingLiveSession: LiveSession | undefined;
  try {
    const retried = store.beginRetryStart(appSessionId);
    const turnGeneration = retried.binding.providerSessionId
      ? retried.binding.runtimeGeneration
      : retried.binding.runtimeGeneration + 1;
    d.transcriptStore?.beginTurn({
      turnId,
      target: { kind: 'session', appSessionId },
      runtimeGeneration: turnGeneration,
      startedAt: new Date().toISOString(),
    });
    if (retried.binding.providerSessionId) {
      await resumeAppSession(host, appSessionId, { publishCreated: false });
      return;
    }
    await activatePersistedCreate(host, {
      command,
      allocated,
      configuration: retried.summary.configuration,
      expectedGeneration: retried.binding.runtimeGeneration + 1,
      publish: 'updated',
      startGoal: true,
      pending: {
        setProvider: (provider) => {
          pendingProvider = provider;
        },
        setLive: (live) => {
          pendingLiveSession = live;
        },
      },
    });
  } catch (error) {
    markFailedOpen(d, command, allocated, error);
    await host.cleanupFailedOpen(pendingProvider, pendingLiveSession);
    d.emitError({
      code: 'session.retry_start_failed',
      appSessionId,
      message: errMsg(error),
    });
  }
}

export async function removeFailedAppSession(
  host: SessionOpenHost,
  appSessionId: string,
): Promise<void> {
  const d = host.dependencies;
  d.ensureConnected();
  const store = d.sessionStore;
  if (!store?.removeFailed) {
    d.emitError({
      code: 'session.remove_failed_rejected',
      appSessionId,
      message: 'Canonical session store is required to remove a failed session.',
    });
    return;
  }
  if (d.registry.getLive(appSessionId)) {
    d.emitError({
      code: 'session.remove_failed_rejected',
      appSessionId,
      message: `Session ${appSessionId} is live and cannot be removed.`,
    });
    return;
  }
  try {
    store.removeFailed(appSessionId);
  } catch (error) {
    d.emitError({
      code: 'session.remove_failed_rejected',
      appSessionId,
      message: errMsg(error),
    });
    return;
  }
  d.emit({ type: 'session.removed', appSessionId });
}

function commandFromStored(stored: StoredSession, clientRef: string): SessionCreateCommand {
  const summary = stored.summary;
  return {
    type: 'session.create',
    clientRef,
    cwd: summary.cwd,
    title: summary.title,
    goal: summary.goal,
    sessionPurpose: summary.sessionPurpose,
    configuration: summary.configuration,
  };
}

