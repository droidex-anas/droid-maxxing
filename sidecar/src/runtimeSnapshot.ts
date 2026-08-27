import type {
  BridgeRuntimeSnapshot,
  ChildSessionSummary,
  InterruptedSessionRecord,
  PersistenceRecovery,
  SessionSummary,
} from './protocol.js';

const EMPTY_RUNTIME = {
  mode: 'cli_auth' as const,
  droidPath: '',
  apiKeyConfigured: false,
};

export function emptyRuntimeSnapshot(
  runtime: BridgeRuntimeSnapshot['runtime'] = EMPTY_RUNTIME,
): BridgeRuntimeSnapshot {
  return {
    runtime,
    sessions: [],
    children: [],
    persistence: { durable: true, hadUnflushedWork: false },
    interrupted: [],
  };
}

export function buildRuntimeSnapshot(input: {
  runtime: BridgeRuntimeSnapshot['runtime'];
  sessions: readonly SessionSummary[];
  children: readonly ChildSessionSummary[];
  persistence: PersistenceRecovery;
  interrupted: readonly InterruptedSessionRecord[];
}): BridgeRuntimeSnapshot {
  return {
    runtime: { ...input.runtime },
    sessions: [...input.sessions],
    children: [...input.children],
    persistence: { ...input.persistence },
    interrupted: [...input.interrupted],
  };
}
