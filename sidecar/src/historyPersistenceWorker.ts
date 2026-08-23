import { parentPort, workerData } from 'node:worker_threads';

import { HistoryPersistenceDatabase } from './historyPersistenceDatabase.js';
import type { HistoryWorkerEnvelope, HistoryWorkerResponse } from './historyPersistenceProtocol.js';
import { serializeHistoryWorkerError } from './historyPersistenceProtocol.js';

interface HistoryWorkerData {
  dbPath: string;
}

const data = historyWorkerData(workerData);
if (!parentPort || !data) {
  throw new Error('History persistence worker requires a parent port and database path.');
}

function historyWorkerData(value: unknown): HistoryWorkerData | null {
  if (typeof value !== 'object' || value === null || !('dbPath' in value)) return null;
  return typeof value.dbPath === 'string' && value.dbPath.length > 0
    ? { dbPath: value.dbPath }
    : null;
}

const database = new HistoryPersistenceDatabase(data.dbPath);
let latestSearchGeneration = 0;
let operationTail: Promise<void> = Promise.resolve();
let closed = false;

parentPort.on('message', (envelope: HistoryWorkerEnvelope) => {
  if (envelope.request.type === 'search' || envelope.request.type === 'invalidate-search') {
    latestSearchGeneration = Math.max(latestSearchGeneration, envelope.request.generation);
  }
  operationTail = operationTail.then(
    () => handle(envelope),
    () => handle(envelope),
  );
});

async function handle(envelope: HistoryWorkerEnvelope): Promise<void> {
  const { request, replyPort } = envelope;
  try {
    if (closed && request.type !== 'close')
      throw new Error('History persistence worker is closed.');
    switch (request.type) {
      case 'persist':
        reply(replyPort, { ok: true, value: database.persist(request.batch) });
        return;
      case 'search': {
        const generation = request.generation;
        const results = await database.search(
          request.query,
          request.candidates,
          () => generation !== latestSearchGeneration || closed,
        );
        reply(replyPort, { ok: true, value: results });
        return;
      }
      case 'invalidate-search':
        database.invalidateSearch();
        reply(replyPort, { ok: true, value: { invalidated: true } });
        return;
      case 'close':
        if (!closed) {
          closed = true;
          database.close();
        }
        reply(replyPort, { ok: true, value: { closed: true } });
        return;
    }
  } catch (error) {
    reply(replyPort, { ok: false, error: serializeHistoryWorkerError(error) });
  }
}

function reply(port: HistoryWorkerEnvelope['replyPort'], response: HistoryWorkerResponse): void {
  try {
    port.postMessage(response);
  } finally {
    port.close();
  }
}
