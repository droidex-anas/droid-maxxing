import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { HistoryPersistenceDatabase } from './historyPersistenceDatabase.js';
import type { HistoryPersistenceBatch } from './historyPersistenceProtocol.js';
import type { SessionSummary } from './protocol.js';

function createSchema(path: string): void {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE app_sessions (
      app_session_id TEXT PRIMARY KEY,
      provider_session_id TEXT NOT NULL,
      compacted_from_provider_session_ids TEXT NOT NULL DEFAULT '[]',
      session_purpose TEXT NOT NULL,
      interaction_mode TEXT NOT NULL,
      title TEXT NOT NULL,
      cwd TEXT,
      workspace_kind TEXT,
      updated_at INTEGER NOT NULL,
      model_id TEXT,
      reasoning_effort TEXT,
      compaction_model TEXT,
      worker_model_id TEXT,
      worker_reasoning_effort TEXT,
      validator_model_id TEXT,
      validator_reasoning_effort TEXT,
      autonomy TEXT,
      tokens_in INTEGER NOT NULL DEFAULT 0,
      tokens_out INTEGER NOT NULL DEFAULT 0,
      context_tokens INTEGER NOT NULL DEFAULT 0,
      context_remaining_tokens INTEGER,
      context_accuracy TEXT,
      context_updated_at TEXT,
      max_context_tokens INTEGER,
      auto_compactions INTEGER
    );
    CREATE TABLE child_sessions (
      parent_app_session_id TEXT NOT NULL,
      child_session_id TEXT NOT NULL,
      provider_session_id TEXT,
      previous_provider_session_ids TEXT NOT NULL DEFAULT '[]',
      role TEXT NOT NULL CHECK (role IN ('worker', 'validator')),
      label TEXT,
      prompt TEXT,
      status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'paused', 'completed')),
      model_id TEXT NOT NULL,
      reasoning_effort TEXT,
      spawn_link_kind TEXT CHECK (spawn_link_kind IN ('tool-use', 'spawn')),
      spawn_link_id TEXT,
      transcript_available INTEGER NOT NULL CHECK (transcript_available IN (0, 1)),
      started_at INTEGER,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (parent_app_session_id, child_session_id)
    );
    CREATE TABLE events (
      id TEXT PRIMARY KEY,
      source_session_id TEXT NOT NULL,
      app_session_id TEXT,
      kind TEXT NOT NULL,
      ts INTEGER NOT NULL
    );
  `);
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

test('applies events, latest summaries, and child state in one transaction', () => {
  const dir = mkdtempSync(join(tmpdir(), 'droidex-history-db-'));
  const path = join(dir, 'history.sqlite');
  try {
    createSchema(path);
    const persistence = new HistoryPersistenceDatabase(path);
    const result = persistence.persist(batch());
    assert.equal(result.eventsWritten, 1);
    assert.equal(result.summariesWritten, 1);
    assert.equal(result.childrenWritten, 1);
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
      9,
    );
    assert.equal(
      (
        db.prepare('SELECT status FROM child_sessions WHERE child_session_id = ?').get('child') as {
          status: string;
        }
      ).status,
      'paused',
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
    assert.throws(() => persistence.persist(batch(invalid)));
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
