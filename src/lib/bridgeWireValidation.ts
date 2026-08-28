import type {
  BridgeResetMessage,
  BridgeRuntimeSnapshot,
  BridgeSnapshotMessage,
  InterruptedSessionRecord,
  PersistenceRecovery,
  ServerEvent,
  ServerEventBatch,
  ServerWireMessage,
  StreamFidelity,
} from '../types/bridge';
import { isSessionConfiguration } from './sessionConfiguration';

export function serverWireMessage(value: unknown): ServerWireMessage | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null;
  if (value.type === 'events.batch') return eventBatch(value);
  if (value.type === 'bridge.reset') return bridgeReset(value);
  if (value.type === 'bridge.snapshot') return bridgeSnapshot(value);
  return directError(value);
}

function directError(
  value: Record<string, unknown>,
): Extract<ServerEvent, { type: 'error' }> | null {
  if (value.type !== 'error' || typeof value.message !== 'string') return null;
  return value as unknown as Extract<ServerEvent, { type: 'error' }>;
}

function eventBatch(value: Record<string, unknown>): ServerEventBatch | null {
  const generation = value.generation;
  const firstSeq = value.firstSeq;
  const lastSeq = value.lastSeq;
  const events = value.events;
  if (typeof generation !== 'string' || generation.length === 0) return null;
  if (!positiveSafeInteger(firstSeq) || !positiveSafeInteger(lastSeq)) return null;
  if (lastSeq < firstSeq || !Array.isArray(events) || events.length === 0) return null;
  if (!hasOrderedBatchEntries(events, firstSeq, lastSeq)) return null;
  return value as unknown as ServerEventBatch;
}

function hasOrderedBatchEntries(events: unknown[], firstSeq: number, lastSeq: number): boolean {
  let previousSeq = firstSeq - 1;
  for (const entry of events) {
    if (!isRecord(entry) || !positiveSafeInteger(entry.seq) || !isServerEvent(entry.event)) {
      return false;
    }
    const seq = entry.seq;
    if (seq <= previousSeq || seq < firstSeq || seq > lastSeq) return false;
    previousSeq = seq;
  }
  return previousSeq === lastSeq;
}

function bridgeReset(value: Record<string, unknown>): BridgeResetMessage | null {
  if (
    typeof value.generation !== 'string' ||
    value.generation.length === 0 ||
    !nonNegativeSafeInteger(value.lastSeq) ||
    value.reason !== 'invalid_resume'
  ) {
    return null;
  }
  return value as unknown as BridgeResetMessage;
}

function bridgeSnapshot(value: Record<string, unknown>): BridgeSnapshotMessage | null {
  const snapshot = runtimeSnapshot(value.snapshot);
  if (
    typeof value.generation !== 'string' ||
    value.generation.length === 0 ||
    !nonNegativeSafeInteger(value.lastSeq) ||
    (value.reason !== 'generation_changed' && value.reason !== 'replay_unavailable') ||
    snapshot === null
  ) {
    return null;
  }
  return value as unknown as BridgeSnapshotMessage;
}

function runtimeSnapshot(value: unknown): BridgeRuntimeSnapshot | null {
  if (!isRecord(value) || !isRuntimeStatus(value.runtime)) return null;
  if (!Array.isArray(value.sessions) || !value.sessions.every(isSessionSummary)) return null;
  if (!Array.isArray(value.children) || !value.children.every(isChildSessionSummary)) return null;
  if (!persistenceRecovery(value.persistence)) return null;
  if (!Array.isArray(value.interrupted) || !value.interrupted.every(interruptedRecord)) return null;
  return value as unknown as BridgeRuntimeSnapshot;
}

function persistenceRecovery(value: unknown): value is PersistenceRecovery {
  return (
    isRecord(value) &&
    typeof value.durable === 'boolean' &&
    typeof value.hadUnflushedWork === 'boolean' &&
    (value.message === undefined || typeof value.message === 'string')
  );
}

function interruptedRecord(value: unknown): value is InterruptedSessionRecord {
  return (
    isRecord(value) &&
    typeof value.appSessionId === 'string' &&
    value.appSessionId.length > 0 &&
    typeof value.reason === 'string' &&
    (value.childSessionId === undefined || typeof value.childSessionId === 'string')
  );
}

// The exhaustive discriminant stays centralized so every inbound event takes
// the same validation path before renderer code can observe it.
// eslint-disable-next-line complexity
function isServerEvent(value: unknown): value is ServerEvent {
  if (!isRecord(value) || typeof value.type !== 'string') return false;
  // Runtime `type` is a string; narrowing to the union makes a missing variant fail this switch.
  const type = value.type as ServerEvent['type'];
  switch (type) {
    case 'connection':
      return value.status === 'connected' || value.status === 'error';
    case 'runtime.updated':
      return isRuntimeStatus(value.status);
    case 'env.report':
      return isEnvironmentReport(value.report);
    case 'cli.install.progress':
      return (
        (value.phase === 'install' || value.phase === 'update') &&
        (value.stream === 'stdout' || value.stream === 'stderr') &&
        typeof value.line === 'string'
      );
    case 'cli.install.done':
      return (
        (value.phase === 'install' || value.phase === 'update') &&
        typeof value.ok === 'boolean' &&
        typeof value.exitCode === 'number'
      );
    case 'session.created':
      return typeof value.clientRef === 'string' && isSessionSummary(value.session);
    case 'session.updated':
      return isSessionSummary(value.session);
    case 'session.closed':
    case 'browser.closed':
      return typeof value.appSessionId === 'string';
    case 'sessions.cwdReanchored':
      return (
        typeof value.requestId === 'string' &&
        typeof value.ok === 'boolean' &&
        typeof value.count === 'number'
      );
    case 'session.markdownExported':
      return (
        typeof value.requestId === 'string' &&
        typeof value.ok === 'boolean' &&
        (value.ok ? typeof value.markdown === 'string' : typeof value.message === 'string')
      );
    case 'child.updated':
      return isChildUpdatedEvent(value);
    case 'child.error':
      return (
        hasStrings(value, [
          'parentAppSessionId',
          'childSessionId',
          'operation',
          'code',
          'message',
        ]) &&
        (value.requestId === null || typeof value.requestId === 'string')
      );
    case 'event.appended':
      return isTranscriptEvent(value.event);
    case 'approval.requested':
      return isPermissionRequest(value.request);
    case 'question.requested':
      return isSessionQuestion(value.question);
    case 'context.updated':
      return hasStrings(value, ['appSessionId', 'sourceSessionId']) && isContextStats(value.stats);
    case 'catalog.updated':
      return (
        (value.catalog === 'models' || value.catalog === 'tools' || value.catalog === 'skills') &&
        Array.isArray(value.items)
      );
    case 'settings.defaults':
      return isRecord(value.defaults);
    case 'error':
    case 'browser.error':
      return typeof value.message === 'string';
    case 'mission.features':
      return (
        typeof value.appSessionId === 'string' &&
        Array.isArray(value.features) &&
        value.features.every(isBridgeFeature)
      );
    case 'mission.progress':
      return typeof value.appSessionId === 'string' && progressArray(value.entries);
    case 'session.child':
      return (
        value.event === 'upserted' &&
        isChildSessionSummary(value.child) &&
        typeof value.runtimeAvailable === 'boolean' &&
        nonNegativeSafeInteger(value.runtimeGeneration)
      );
    case 'spec.content':
      return hasStrings(value, ['appSessionId', 'path', 'content']);
    case 'sessions.list':
      return (
        Array.isArray(value.sessions) &&
        value.sessions.every(isSessionSummary) &&
        isEarlierSessionCounts(value.earlierSessionsByCwd)
      );
    case 'session.history':
      return (
        typeof value.appSessionId === 'string' &&
        progressArray(value.progress) &&
        Array.isArray(value.transcripts) &&
        value.transcripts.every(isTranscriptEvent)
      );
    case 'session.history.error':
      return hasStrings(value, ['appSessionId', 'message']);
    case 'sessions.searchResults':
      return (
        typeof value.requestId === 'string' &&
        recordArray(value.results) &&
        typeof value.indexingIncomplete === 'boolean'
      );
    case 'history.persistenceRecovered':
      return true;
    case 'browser.updated':
      return isBrowserState(value.state);
    case 'browser.native.request':
      return isBrowserNativeRequest(value.request);
    case 'mcp.authRequested':
      return typeof value.requestId === 'string';
    case 'mcp.catalog':
      return (
        typeof value.requestId === 'string' &&
        recordArray(value.servers) &&
        recordArray(value.tools) &&
        isRecord(value.summary)
      );
    case 'mcp.error':
      return hasStrings(value, ['requestId', 'message']);
    default: {
      const unexpected: never = type;
      void unexpected;
      return false;
    }
  }
}

function isSessionSummary(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasStrings(value, [
      'appSessionId',
      'sessionPurpose',
      'role',
      'title',
      'goal',
      'cwd',
      'phase',
    ]) &&
    isSessionConfiguration(value.configuration) &&
    Array.isArray(value.features) &&
    value.features.every(isBridgeFeature) &&
    hasNumbers(value, ['tokensIn', 'tokensOut', 'contextTokens', 'createdAt', 'updatedAt']) &&
    (value.interruptReason === undefined || typeof value.interruptReason === 'string')
  );
}

function isStreamFidelity(value: unknown): value is StreamFidelity {
  return value === 'token' || value === 'tool' || value === 'state';
}

function isChildSessionSummary(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasStrings(value, ['parentAppSessionId', 'childSessionId', 'role', 'status', 'modelId']) &&
    typeof value.transcriptAvailable === 'boolean' &&
    isStreamFidelity(value.streamFidelity)
  );
}

function isTranscriptEvent(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasStrings(value, ['id', 'appSessionId', 'sourceSessionId', 'role', 'kind']) &&
    typeof value.ts === 'number'
  );
}

function isPermissionRequest(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasStrings(value, ['appSessionId', 'requestId', 'kind', 'title', 'detail']) &&
    isPermissionKind(value.kind) &&
    'raw' in value
  );
}

function isPermissionKind(value: unknown): boolean {
  return (
    value === 'edit' ||
    value === 'exec' ||
    value === 'create' ||
    value === 'apply_patch' ||
    value === 'mcp' ||
    value === 'spec' ||
    value === 'mission_plan' ||
    value === 'other'
  );
}

function isBridgeFeature(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasStrings(value, ['id', 'description', 'status', 'skillName']) &&
    (value.status === 'pending' ||
      value.status === 'in_progress' ||
      value.status === 'completed' ||
      value.status === 'cancelled') &&
    stringArray(value.preconditions) &&
    stringArray(value.expectedBehavior) &&
    stringArray(value.verificationSteps) &&
    (value.fulfills === undefined || stringArray(value.fulfills)) &&
    (value.milestone === undefined || typeof value.milestone === 'string')
  );
}

function isSessionQuestion(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasStrings(value, ['appSessionId', 'requestId']) &&
    Array.isArray(value.questions) &&
    value.questions.every(
      (question) =>
        isRecord(question) &&
        typeof question.index === 'number' &&
        typeof question.question === 'string' &&
        stringArray(question.options),
    )
  );
}

function isContextStats(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasNumbers(value, ['used', 'remaining', 'limit']) &&
    (value.accuracy === 'exact' || value.accuracy === 'estimated') &&
    typeof value.updatedAt === 'string'
  );
}

function isChildUpdatedEvent(value: Record<string, unknown>): boolean {
  if (!hasStrings(value, ['parentAppSessionId', 'childSessionId', 'requestId'])) return false;
  if (value.access === 'history') return true;
  return value.access === 'ready' && nonNegativeSafeInteger(value.runtimeGeneration);
}

function isRuntimeStatus(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.mode === 'cli_auth' &&
    typeof value.droidPath === 'string' &&
    typeof value.apiKeyConfigured === 'boolean'
  );
}

function isEnvironmentReport(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasStrings(value, ['platform', 'arch', 'osVersion']) &&
    isRecord(value.node) &&
    isRecord(value.cli) &&
    isRecord(value.packageManagers) &&
    isRecord(value.auth) &&
    stringArray(value.availableChannels)
  );
}

function isBrowserState(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasStrings(value, ['browserSessionId', 'url', 'viewportMode']) &&
    isRecord(value.viewport) &&
    isRecord(value.scroll) &&
    recordArray(value.refs)
  );
}

function isBrowserNativeRequest(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasStrings(value, ['requestId', 'appSessionId', 'browserSessionId', 'action'])
  );
}

function hasStrings(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => typeof value[key] === 'string');
}

function hasNumbers(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => typeof value[key] === 'number' && Number.isFinite(value[key]));
}

function stringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function recordArray(value: unknown): boolean {
  return Array.isArray(value) && value.every(isRecord);
}

function progressArray(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        isRecord(entry) && typeof entry.type === 'string' && typeof entry.timestamp === 'string',
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isEarlierSessionCounts(value: unknown): boolean {
  return (
    isRecord(value) && !Array.isArray(value) && Object.values(value).every(nonNegativeSafeInteger)
  );
}

function positiveSafeInteger(value: unknown): value is number {
  return nonNegativeSafeInteger(value) && value > 0;
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
