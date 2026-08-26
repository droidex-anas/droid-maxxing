import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { HistoryIndex } from './history.js';
import { HistoryPersistenceDatabase } from './historyPersistenceDatabase.js';
import type { HistoryPersistenceBatch, HistoryWriterLease } from './historyPersistenceProtocol.js';
import type { SessionSummary } from './protocol.js';

function createSchema(path: string): void {
  const db = new DatabaseSync(path);
  HistoryIndex.initializeOrValidateHistorySchema(db);
  db.close();
}

function summary(tokensOut: number): SessionSummary {
  return {
    appSessionId: 'app',
    providerSessionId: 'provider',
    sessionPurpose: 'chat',
    interactionMode: 'auto',
    role: 'primary',
    title: 'App',
    goal: 'Goal',
    cwd: '/repo',
    autonomy: 'low',
    phase: 'running',
    features: [],
    tokensIn: 1,
    tokensOut,
    contextTokens: 3,
    createdAt: 1,
    updatedAt: 2,
  };
}

function batch(value = summary(9)): HistoryPersistenceBatch {
  return {
    events: [{ id: 'event', sourceSessionId: 'app', appSessionId: 'app', kind: 'text', ts: 1 }],
    summaries: [value],
    children: [
      {
        parentAppSessionId: 'app',
        childSessionId: 'child',
        role: 'worker',
        status: 'paused',
        modelId: 'model',
        transcriptAvailable: true,
        updatedAt: 3,
      },
    ],
    estimatedBytes: 1_024,
  };
}

const writerLease: HistoryWriterLease = {
  owner: 'test-writer',
  generation: 1,
  processId: process.pid,
};

test('applies events, latest summaries, and child state in one transaction', () => {
  const dir = mkdtempSync(join(tmpdir(), 'droidex-history-db-'));
  const path = join(dir, 'history.sqlite');
  try {
    createSchema(path);
    const persistence = new HistoryPersistenceDatabase(path);
    const result = persistence.persist(batch(), writerLease);
    assert.equal(result.eventsWritten, 1);
    assert.equal(result.summariesWritten, 1);
    assert.equal(result.childrenWritten, 1);
    assert.equal(persistence.persist(batch(summary(10)), writerLease).eventsWritten, 0);
    const activityUpdate = summary(11);
    activityUpdate.updatedAt = 3;
    persistence.persist(batch(activityUpdate), writerLease);
    assert.doesNotThrow(() => persistence.durabilityBarrier(writerLease));
    persistence.close();

    const db = new DatabaseSync(path, { readOnly: true });
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS count FROM events').get() as { count: number }).count,
      1,
    );
    assert.equal(
      (
        db.prepare('SELECT tokens_out FROM app_sessions WHERE app_session_id = ?').get('app') as {
          tokens_out: number;
        }
      ).tokens_out,
      11,
    );
    assert.equal(
      (
        db.prepare('SELECT status FROM child_sessions WHERE child_session_id = ?').get('child') as {
          status: string;
        }
      ).status,
      'paused',
    );
    assert.equal(
      db
        .prepare("SELECT value_json FROM settings WHERE scope = 'history.search_identity_revision'")
        .get()?.['value_json'],
      '2',
      'passive token updates do not invalidate the search identity cache',
    );
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rolls back the complete batch when one row is invalid', () => {
  const dir = mkdtempSync(join(tmpdir(), 'droidex-history-db-'));
  const path = join(dir, 'history.sqlite');
  try {
    createSchema(path);
    const persistence = new HistoryPersistenceDatabase(path);
    const invalid = summary(2);
    Reflect.set(invalid, 'title', null);
    assert.throws(() => persistence.persist(batch(invalid), writerLease));
    persistence.close();

    const db = new DatabaseSync(path, { readOnly: true });
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS count FROM events').get() as { count: number }).count,
      0,
    );
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS count FROM child_sessions').get() as { count: number }).count,
      0,
    );
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rejects a replaced writer before it can commit stale state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'droidex-history-db-lease-'));
  const path = join(dir, 'history.sqlite');
  const firstGeneration: HistoryWriterLease = {
    owner: 'worker',
    generation: 1,
    processId: process.pid,
  };
  const secondGeneration: HistoryWriterLease = {
    owner: 'worker',
    generation: 2,
    processId: process.pid,
  };
  try {
    createSchema(path);
    const staleWriter = new HistoryPersistenceDatabase(path);
    const currentWriter = new HistoryPersistenceDatabase(path);
    staleWriter.persist(batch(), firstGeneration);

    const current = summary(20);
    current.updatedAt = 20;
    currentWriter.persist(batch(current), secondGeneration);

    const stale = summary(99);
    stale.updatedAt = 99;
    assert.throws(
      () => staleWriter.persist(batch(stale), firstGeneration),
      /generation 1 was replaced by generation 2/,
    );
    assert.throws(
      () => staleWriter.durabilityBarrier(firstGeneration),
      /generation 1 was replaced by generation 2/,
    );
    currentWriter.durabilityBarrier(secondGeneration);
    staleWriter.close();
    currentWriter.close();

    const db = new DatabaseSync(path, { readOnly: true });
    assert.equal(
      (
        db.prepare('SELECT tokens_out FROM app_sessions WHERE app_session_id = ?').get('app') as {
          tokens_out: number;
        }
      ).tokens_out,
      20,
    );
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rejects a foreign live writer and accepts takeover after owner exits', () => {
  const dir = mkdtempSync(join(tmpdir(), 'droidex-history-db-foreign-lease-'));
  const path = join(dir, 'history.sqlite');
  const firstLease: HistoryWriterLease = {
    owner: 'first-worker',
    generation: 1,
    processId: process.pid,
  };
  const secondLease: HistoryWriterLease = {
    owner: 'second-worker',
    generation: 1,
    processId: process.pid,
  };
  try {
    createSchema(path);
    const firstWriter = new HistoryPersistenceDatabase(path);
    const secondWriter = new HistoryPersistenceDatabase(path);
    firstWriter.persist(batch(summary(12)), firstLease);

    assert.throws(
      () => secondWriter.persist(batch(summary(13)), secondLease),
      /owned by another live worker/,
    );
    firstWriter.close();
    assert.equal(secondWriter.persist(batch(summary(14)), secondLease).summariesWritten, 1);
    secondWriter.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('takes over a foreign writer lease left by an exited process', () => {
  const dir = mkdtempSync(join(tmpdir(), 'droidex-history-db-exited-lease-'));
  const path = join(dir, 'history.sqlite');
  const deadProcessLease: HistoryWriterLease = {
    owner: 'exited-worker',
    generation: 1,
    processId: 2_147_483_647,
  };
  const replacementLease: HistoryWriterLease = {
    owner: 'replacement-worker',
    generation: 1,
    processId: process.pid,
  };
  try {
    createSchema(path);
    const db = new DatabaseSync(path);
    db.prepare(
      `INSERT INTO settings (scope, value_json, updated_at)
       VALUES ('history.persistence_writer_lease', ?, ?)`,
    ).run(JSON.stringify(deadProcessLease), Date.now());
    db.close();

    const replacement = new HistoryPersistenceDatabase(path);
    assert.equal(replacement.persist(batch(summary(15)), replacementLease).summariesWritten, 1);
    replacement.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
