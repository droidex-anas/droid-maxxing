import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { HistoryIndex, SESSION_INDEX_FILENAME, type PersistedChildSession } from '../history.js';
import { HistoryPersistenceDatabase } from '../historyPersistenceDatabase.js';
import {
  eventMetadata,
  type HistoryPersistenceBatch,
  type HistoryWriterLease,
} from '../historyPersistenceProtocol.js';
import type { SessionSummary, TranscriptEvent } from '../protocol.js';

const testWriterLease: HistoryWriterLease = {
  owner: 'history-persistence-test-fixture',
  generation: 1,
  processId: process.pid,
};

export function persistTestSummaries(summaries: SessionSummary[]): void {
  persistTestBatch({ events: [], summaries, children: [], estimatedBytes: 0 });
}

export function persistTestEvent(event: TranscriptEvent): void {
  persistTestBatch({
    events: [eventMetadata(event)],
    summaries: [],
    children: [],
    estimatedBytes: 0,
  });
}

export function persistTestChild(child: PersistedChildSession): void {
  persistTestBatch({ events: [], summaries: [], children: [child], estimatedBytes: 0 });
}

function persistTestBatch(batch: HistoryPersistenceBatch): void {
  const path = join(homedir(), '.factory', 'droidex', SESSION_INDEX_FILENAME);
  assertCanonicalHistorySchema(path);
  const database = new HistoryPersistenceDatabase(path);
  try {
    database.persist(batch, testWriterLease);
  } finally {
    database.close();
  }
}

function assertCanonicalHistorySchema(path: string): void {
  if (!existsSync(path)) {
    throw new Error(`Canonical history schema is missing at ${path}.`);
  }
  const db = new DatabaseSync(path);
  try {
    HistoryIndex.initializeOrValidateHistorySchema(db);
  } finally {
    db.close();
  }
}
