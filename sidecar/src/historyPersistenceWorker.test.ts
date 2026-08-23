import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { HistoryWorkerClient } from './HistoryWorkerClient.js';
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

function summary(): SessionSummary {
  return {
    appSessionId: 'app',
    providerSessionId: 'provider',
    sessionPurpose: 'chat',
    interactionMode: 'auto',
    role: 'primary',
    title: 'Worker-backed persistence',
    goal: 'Persist off the orchestration thread',
    cwd: '/repo',
    autonomy: 'low',
    phase: 'paused',
    features: [],
    tokensIn: 10,
    tokensOut: 20,
    contextTokens: 30,
    createdAt: 1,
    updatedAt: 2,
  };
}

test('worker persists a complete batch and supports synchronous durability waits', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'droidex-history-worker-'));
  const dbPath = join(dir, 'history.sqlite');
  try {
    createSchema(dbPath);
    const client = new HistoryWorkerClient({ workerData: { dbPath } });
    const batch: HistoryPersistenceBatch = {
      events: [{ id: 'event', sourceSessionId: 'app', appSessionId: 'app', kind: 'text', ts: 1 }],
      summaries: [summary()],
      children: [],
      estimatedBytes: 1_024,
    };

    const result = client.startPersist(batch).waitSync();
    assert.equal(result.eventsWritten, 1);
    assert.equal(result.summariesWritten, 1);
    client.closeSync();

    const db = new DatabaseSync(dbPath, { readOnly: true });
    assert.equal(
      (
        db.prepare('SELECT tokens_out FROM app_sessions WHERE app_session_id = ?').get('app') as {
          tokens_out: number;
        }
      ).tokens_out,
      20,
    );
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS count FROM events').get() as { count: number }).count,
      1,
    );
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
