import type { PersistedChildSession } from './history.js';
import type { HistoryPersistenceCall, HistoryPersistenceClient } from './HistoryWorkerClient.js';
import type {
  HistoryPersistenceBatch,
  HistoryPersistenceResult,
} from './historyPersistenceProtocol.js';
import type { SessionSummary } from './protocol.js';

export const MAX_PERSISTENCE_BATCH_ROWS = 512;
export const MAX_PERSISTENCE_BATCH_BYTES = 512 * 1024;
export const MAX_PERSISTENCE_QUEUE_ROWS = 50_000;
export const MAX_PERSISTENCE_QUEUE_BYTES = 64 * 1024 * 1024;

export class HistoryPersistenceBackpressureError extends Error {
  constructor(entries: number, bytes: number) {
    super(
      `History persistence queue exceeded its bounded capacity (${String(entries)} entries, ${String(bytes)} bytes).`,
    );
    this.name = 'HistoryPersistenceBackpressureError';
  }
}

export interface InFlightPersistenceBatch {
  batch: HistoryPersistenceBatch;
  call: HistoryPersistenceCall<HistoryPersistenceResult>;
  settled: Promise<void>;
  minimumSequence: number;
}

export interface PersistenceDirtyMarkerPort {
  markDirty(): void;
  markClean(): void;
}

export interface HistoryPersistenceQueueOptions {
  dbPath: string;
  client?: HistoryPersistenceClient;
  flushDelayMs?: number;
  retryDelayMs?: number;
  syncTimeoutMs?: number;
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  cancel?: (timer: ReturnType<typeof setTimeout>) => void;
  onCommitted?: (batch: HistoryPersistenceBatch, result: HistoryPersistenceResult) => void;
  onFailure?: (error: Error) => void;
  onRecovered?: () => void;
  dirtyMarker?: PersistenceDirtyMarkerPort;
}

export function persistenceChildKey(parentAppSessionId: string, childSessionId: string): string {
  return JSON.stringify([parentAppSessionId, childSessionId]);
}

export function persistenceChildKeyPrefix(parentAppSessionId: string): string {
  return `${JSON.stringify([parentAppSessionId]).slice(0, -1)},`;
}

export function estimatePersistenceValueBytes(value: unknown, fallbackBytes: number): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8') + 64;
  } catch {
    return fallbackBytes;
  }
}

export function copyPersistenceSummary(summary: SessionSummary): SessionSummary {
  return {
    ...summary,
    ...(summary.compactedFromProviderSessionIds
      ? { compactedFromProviderSessionIds: [...summary.compactedFromProviderSessionIds] }
      : {}),
    features: summary.features.map((feature) => ({
      ...feature,
      preconditions: [...feature.preconditions],
      expectedBehavior: [...feature.expectedBehavior],
      verificationSteps: [...feature.verificationSteps],
      ...(feature.fulfills ? { fulfills: [...feature.fulfills] } : {}),
    })),
  };
}

export function copyPersistenceChild(child: PersistedChildSession): PersistedChildSession {
  return {
    ...child,
    ...(child.previousProviderSessionIds
      ? { previousProviderSessionIds: [...child.previousProviderSessionIds] }
      : {}),
    ...(child.spawnLink ? { spawnLink: { ...child.spawnLink } } : {}),
  };
}
