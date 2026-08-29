import type { ClientCommand, SessionConfiguration, SessionSummary } from './protocol.js';
import type { SessionStore } from './persistence/SessionStore.js';
import type { TranscriptStore } from './persistence/TranscriptStore.js';
import type { CanonicalEvent } from './sessionEvents.js';
import { buildCreatedSessionSummary, errMsg } from './sessionHelpers.js';
import { parseProviderError, type ProviderError } from './providers/providerErrors.js';
import {
  createProviderContractError,
  type ProviderPrompt,
  type ProviderSession,
} from './providers/providerTypes.js';

export const EMPTY_PROMPT_PARTS: Pick<ProviderPrompt, 'skills' | 'files' | 'browserRefs'> = {
  skills: [],
  files: [],
  browserRefs: [],
};

export type SessionCreateCommand = Extract<ClientCommand, { type: 'session.create' }>;

export type SessionCreateBoundary =
  | 'identity-allocated'
  | 'summary-initialized'
  | 'provisional-persisted'
  | 'before-provider-open'
  | 'provider-opened'
  | 'binding-persisted'
  | 'activated';

export interface SessionCreatePersistence {
  sessionStore?: Pick<
    SessionStore,
    | 'createProvisional'
    | 'findByClientRef'
    | 'bindInitialProviderRuntime'
    | 'markStarted'
    | 'markFailed'
    | 'get'
  >;
  transcriptStore?: Pick<TranscriptStore, 'beginTurn' | 'settleTurn' | 'append'>;
  atomic?: <T>(work: () => T) => T;
  nextAppSessionId?: () => string;
  nextTurnId?: () => string;
  nextId?: () => string;
  onCreateBoundary?: (boundary: SessionCreateBoundary) => void;
}

export interface AllocatedCreateIdentity {
  appSessionId: string;
  turnId: string;
}

export function noteCreateBoundary(
  persistence: Pick<SessionCreatePersistence, 'onCreateBoundary'>,
  boundary: SessionCreateBoundary,
): void {
  persistence.onCreateBoundary?.(boundary);
}

export function allocateCreateIdentity(
  persistence: SessionCreatePersistence,
  nextId: () => string,
): AllocatedCreateIdentity {
  return {
    appSessionId: persistence.nextAppSessionId?.() ?? nextId(),
    turnId: persistence.nextTurnId?.() ?? nextId(),
  };
}

export function initializingCreateSummary(
  command: SessionCreateCommand,
  appSessionId: string,
  configuration: SessionConfiguration,
  now = Date.now(),
): SessionSummary {
  return buildCreatedSessionSummary({
    command,
    appSessionId,
    configuration,
    compactionModel: command.compactionModel ?? 'current-model',
    phase: 'initializing',
    now,
  });
}

export function persistProvisionalIdentity(
  persistence: SessionCreatePersistence,
  command: SessionCreateCommand,
  summary: SessionSummary,
  turnId: string,
): void {
  const store = persistence.sessionStore;
  if (!store) return;
  const persist = () => {
    store.createProvisional({
      appSessionId: summary.appSessionId,
      clientRef: command.clientRef,
      summary,
    });
    persistence.transcriptStore?.beginTurn({
      turnId,
      target: { kind: 'session', appSessionId: summary.appSessionId },
      runtimeGeneration: 1,
      startedAt: new Date(summary.createdAt).toISOString(),
    });
  };
  if (persistence.atomic) persistence.atomic(persist);
  else persist();
}

export function persistInitialBinding(
  persistence: SessionCreatePersistence,
  appSessionId: string,
  provider: ProviderSession,
  expectedGeneration: number,
): void {
  const store = persistence.sessionStore;
  if (!store) return;
  // Provisional rows start at generation 0; the first live binding CAS is 0 → 1.
  const persist = () => {
    store.bindInitialProviderRuntime(
      appSessionId,
      expectedGeneration - 1,
      provider.providerSessionId,
      provider.initialResumeState,
    );
    store.markStarted(appSessionId);
  };
  if (persistence.atomic) persistence.atomic(persist);
  else persist();
}

export function markFailedOpen(
  persistence: SessionCreatePersistence,
  command: SessionCreateCommand,
  allocated: AllocatedCreateIdentity | undefined,
  error: unknown,
): void {
  const store = persistence.sessionStore;
  if (!store || !allocated) return;
  const stored = store.get(allocated.appSessionId);
  if (!stored) return;
  const failed = startupFailure(stored.binding.providerInstanceId, error);
  const fail = () => {
    store.markFailed(stored.summary.appSessionId, failed);
    try {
      persistence.transcriptStore?.settleTurn(allocated.turnId, {
        runtimeGeneration: 1,
        status: 'failed',
        settledAt: new Date().toISOString(),
      });
    } catch {
      // The turn may already be settled or missing if persist never completed.
    }
    persistStartupDiagnostic(persistence, stored.summary.appSessionId, allocated?.turnId, failed);
  };
  try {
    if (persistence.atomic) persistence.atomic(fail);
    else fail();
  } catch {
    // Cleanup continues; the failed row is still visible if markFailed committed.
  }
}

export function consumeReservedTurnId(session: { reservedTurnId?: string }): string | undefined {
  const turnId = session.reservedTurnId;
  session.reservedTurnId = undefined;
  return turnId;
}

export function beginFollowUpTurn(
  transcriptStore: Pick<TranscriptStore, 'beginTurn'> | undefined,
  input: {
    reserved: boolean;
    turnId: string;
    appSessionId: string;
    runtimeGeneration: number;
  },
): void {
  if (input.reserved) return;
  transcriptStore?.beginTurn({
    turnId: input.turnId,
    target: { kind: 'session', appSessionId: input.appSessionId },
    runtimeGeneration: input.runtimeGeneration,
    startedAt: new Date().toISOString(),
  });
}

export function providerFailedOpen(provider: ProviderSession): Error | undefined {
  if (!('failedOpen' in provider) || !(provider as { failedOpen?: boolean }).failedOpen) {
    return undefined;
  }
  const openError = (provider as { openError?: unknown }).openError;
  return openError instanceof Error ? openError : new Error('pre-activation buffer overflow');
}

function startupFailure(providerInstanceId: ProviderError['providerInstanceId'], error: unknown) {
  if (isPersistenceFailure(error)) {
    return createProviderContractError(
      providerInstanceId,
      'canonical_persistence_unavailable',
      errMsg(error),
      'reset_canonical_state',
    ).toProviderError();
  }
  return createProviderContractError(
    providerInstanceId,
    'native_session_start_failed',
    errMsg(error),
    'retry_session',
  ).toProviderError();
}

function isPersistenceFailure(error: unknown): boolean {
  const message = errMsg(error).toLowerCase();
  return (
    message.includes('canonical') ||
    message.includes('persist') ||
    message.includes('generation') ||
    message.includes('already exists') ||
    message.includes('sqlite')
  );
}

function persistStartupDiagnostic(
  persistence: SessionCreatePersistence,
  appSessionId: string,
  turnId: string | undefined,
  error: ProviderError,
): void {
  const transcript = persistence.transcriptStore;
  if (!transcript || !('append' in transcript)) return;
  const stored = persistence.sessionStore?.get(appSessionId);
  if (!stored) return;
  const parsed = parseProviderError(error);
  const event: CanonicalEvent = {
    eventId: persistence.nextId?.() ?? `startup-${appSessionId}`,
    target: { kind: 'session', appSessionId },
    providerDriverKind: stored.binding.providerDriverKind,
    providerInstanceId: stored.binding.providerInstanceId,
    runtimeGeneration: stored.binding.runtimeGeneration,
    createdAt: Date.now(),
    ...(turnId === undefined ? {} : { turnId }),
    payload: { type: 'error', error: parsed },
  };
  try {
    transcript.append(event);
  } catch {
    // A failed diagnostic must not hide the original startup failure.
  }
}
