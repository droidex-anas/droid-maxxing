import { parentPort, workerData } from 'node:worker_threads';

import { HistoryIndexDatabase } from './historyIndexDatabase.js';
import { HistoryPersistenceDatabase } from './historyPersistenceDatabase.js';
import type {
  HistoryPersistenceResult,
  HistoryWorkerEnvelope,
  HistoryWorkerResponse,
} from './historyPersistenceProtocol.js';
import { serializeHistoryWorkerError } from './historyPersistenceProtocol.js';
import {
  HistorySearchUnavailableError,
  isHistorySearchUnavailableError,
} from './historySearchSchema.js';

interface HistoryWorkerData {
  dbPath: string;
  lane: 'persistence' | 'search';
}

const data = historyWorkerData(workerData);
if (!parentPort || !data) {
  throw new Error('History persistence worker requires a parent port and database path.');
}
const dbPath = data.dbPath;
const workerLane = data.lane;

function historyWorkerData(value: unknown): HistoryWorkerData | null {
  if (typeof value !== 'object' || value === null || !('dbPath' in value)) return null;
  if (typeof value.dbPath !== 'string' || value.dbPath.length === 0) return null;
  const lane = 'lane' in value ? value.lane : undefined;
  if (lane !== 'persistence' && lane !== 'search') return null;
  return { dbPath: value.dbPath, lane };
}

let persistenceDatabase: HistoryPersistenceDatabase | null = null;
let persistenceInitializationMs: number | undefined;
let indexDatabase: HistoryIndexDatabase | null = null;
let indexUnavailable: HistorySearchUnavailableError | null = null;
let latestSearchEpoch = 0;
let operationTail: Promise<void> = Promise.resolve();
let closed = false;

// The canonical writer starts warming as soon as its dedicated worker boots.
// This keeps index construction and statement preparation off both the
// orchestration thread and the first user-triggered durability boundary.
if (workerLane === 'persistence') initializePersistenceDatabase();

parentPort.on('message', (envelope: HistoryWorkerEnvelope) => {
  const searchEpoch = envelope.request.type === 'search' ? ++latestSearchEpoch : latestSearchEpoch;
  operationTail = operationTail
    .then(
      () => handle(envelope, searchEpoch),
      () => handle(envelope, searchEpoch),
    )
    .catch((error: unknown) => {
      console.error('History persistence worker operation failed:', error);
    });
});

async function handle(envelope: HistoryWorkerEnvelope, searchEpoch: number): Promise<void> {
  const { request, replyPort } = envelope;
  try {
    if (closed && request.type !== 'close')
      throw new Error('History persistence worker is closed.');
    assertRequestMatchesLane(request, workerLane);
    switch (request.type) {
      case 'persist':
        reply(replyPort, {
          ok: true,
          value: withInitializationMetric(
            getPersistenceDatabase().persist(request.batch, requiredWriterLease(envelope)),
          ),
        });
        return;
      case 'durability-barrier':
        getPersistenceDatabase().durabilityBarrier(requiredWriterLease(envelope));
        reply(replyPort, { ok: true, value: { durable: true } });
        return;
      case 'reconcile-files':
        reply(replyPort, {
          ok: true,
          value: getIndexDatabase().reconcileSessionFiles(),
        });
        return;
      case 'reconcile-file-paths':
        reply(replyPort, {
          ok: true,
          value: getIndexDatabase().reconcileSessionFilePaths(request.changes),
        });
        return;
      case 'session-file-snapshot':
        reply(replyPort, { ok: true, value: getIndexDatabase().sessionFileSnapshot() });
        return;
      case 'indexing-idle':
        getIndexDatabase().setIdle(request.isIdle);
        reply(replyPort, { ok: true, value: { accepted: true } });
        return;
      case 'search': {
        const index = getIndexDatabase();
        const results = index.search(
          request.query,
          () => searchEpoch !== latestSearchEpoch || closed,
        );
        reply(replyPort, {
          ok: true,
          value: { results, indexingIncomplete: index.isIndexingIncomplete() },
        });
        return;
      }
      case 'close':
        if (!closed) {
          closed = true;
          await indexDatabase?.close();
          persistenceDatabase?.close();
        }
        reply(replyPort, { ok: true, value: { closed: true } });
        return;
    }
  } catch (error) {
    reply(replyPort, { ok: false, error: serializeHistoryWorkerError(error) });
  }
}

function requiredWriterLease(envelope: HistoryWorkerEnvelope) {
  const lease = envelope.writerLease;
  if (
    !lease ||
    typeof lease.owner !== 'string' ||
    lease.owner.length === 0 ||
    !Number.isSafeInteger(lease.generation) ||
    lease.generation < 1
  ) {
    throw new Error('History persistence request requires a valid writer lease.');
  }
  return lease;
}

function assertRequestMatchesLane(
  request: HistoryWorkerEnvelope['request'],
  lane: HistoryWorkerData['lane'],
): void {
  if (request.type === 'close') return;
  const isPersistenceRequest = request.type === 'persist' || request.type === 'durability-barrier';
  if ((lane === 'persistence') !== isPersistenceRequest) {
    throw new Error(`History ${lane} worker cannot handle ${request.type}.`);
  }
}

function getIndexDatabase(): HistoryIndexDatabase {
  if (indexUnavailable) throw indexUnavailable;
  if (indexDatabase) return indexDatabase;
  try {
    indexDatabase = new HistoryIndexDatabase(dbPath);
    return indexDatabase;
  } catch (error) {
    if (isHistorySearchUnavailableError(error)) {
      indexUnavailable = new HistorySearchUnavailableError();
      throw indexUnavailable;
    }
    throw error;
  }
}

function getPersistenceDatabase(): HistoryPersistenceDatabase {
  initializePersistenceDatabase();
  if (!persistenceDatabase) throw new Error('History persistence database did not initialize.');
  return persistenceDatabase;
}

function initializePersistenceDatabase(): void {
  if (persistenceDatabase) return;
  const startedAt = performance.now();
  persistenceDatabase = new HistoryPersistenceDatabase(dbPath);
  persistenceInitializationMs = performance.now() - startedAt;
}

function withInitializationMetric(result: HistoryPersistenceResult): HistoryPersistenceResult {
  const initializationMs = persistenceInitializationMs;
  persistenceInitializationMs = undefined;
  return initializationMs === undefined ? result : { ...result, initializationMs };
}

function reply(port: HistoryWorkerEnvelope['replyPort'], response: HistoryWorkerResponse): void {
  try {
    port.postMessage(response);
  } finally {
    port.close();
  }
}
