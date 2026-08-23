import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import type { PersistedChildSession } from './history.js';
import { HistoryPersistence } from './HistoryPersistence.js';
import type { SessionSummary } from './protocol.js';
import { providerSessionJsonl } from './testing/providerSessionFixtures.js';

function summary(patch: Partial<SessionSummary> = {}): SessionSummary {
  return {
    appSessionId: 'app',
    providerSessionId: 'provider',
    sessionPurpose: 'chat',
    interactionMode: 'auto',
    role: 'primary',
    title: 'Durable session',
    goal: 'Persist settled state',
    cwd: '/repo',
    autonomy: 'low',
    phase: 'running',
    streaming: true,
    features: [],
    tokensIn: 0,
    tokensOut: 1,
    contextTokens: 1,
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}

function child(status: PersistedChildSession['status']): PersistedChildSession {
  return {
    parentAppSessionId: 'app',
    childSessionId: 'child',
    role: 'worker',
    status,
    modelId: 'model',
    transcriptAvailable: true,
    updatedAt: 1,
  };
}

test('a failed settlement remains a synchronous durability boundary when retried', () => {
  const home = mkdtempSync(join(tmpdir(), 'droidex-history-persistence-'));
  const previousHome = process.env['HOME'];
  process.env['HOME'] = home;
  const persistence = new HistoryPersistence();
  try {
    persistence.syncSummaries([summary()]);

    const invalidSettlement = summary({ phase: 'paused', streaming: false, tokensOut: 2 });
    Object.defineProperty(invalidSettlement, 'title', { value: undefined });
    assert.throws(() => persistence.syncSummaries([invalidSettlement]), /cannot be bound/);

    persistence.syncSummaries([summary({ phase: 'paused', streaming: false, tokensOut: 2 })]);

    const db = new DatabaseSync(join(home, '.factory', 'droidex', 'session-index.sqlite'), {
      readOnly: true,
    });
    try {
      const row = db
        .prepare('SELECT tokens_out FROM app_sessions WHERE app_session_id = ?')
        .get('app') as { tokens_out: number };
      assert.equal(row.tokens_out, 2);
    } finally {
      db.close();
    }
  } finally {
    persistence.close();
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test('a failed child settlement remains a synchronous durability boundary when retried', () => {
  const home = mkdtempSync(join(tmpdir(), 'droidex-child-persistence-'));
  const previousHome = process.env['HOME'];
  process.env['HOME'] = home;
  const persistence = new HistoryPersistence();
  try {
    persistence.upsertChildSession(child('running'));
    persistence.flushSync();

    const invalidSettlement = child('paused');
    Object.defineProperty(invalidSettlement, 'modelId', { value: undefined });
    assert.throws(() => persistence.upsertChildSession(invalidSettlement), /cannot be bound/);

    persistence.upsertChildSession(child('paused'));

    const db = new DatabaseSync(join(home, '.factory', 'droidex', 'session-index.sqlite'), {
      readOnly: true,
    });
    try {
      const row = db
        .prepare(
          'SELECT status FROM child_sessions WHERE parent_app_session_id = ? AND child_session_id = ?',
        )
        .get('app', 'child') as { status: string };
      assert.equal(row.status, 'paused');
    } finally {
      db.close();
    }
  } finally {
    persistence.close();
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test('search excludes session files that the canonical history cache did not admit', async () => {
  const home = mkdtempSync(join(tmpdir(), 'droidex-history-search-'));
  const previousHome = process.env['HOME'];
  process.env['HOME'] = home;
  const persistence = new HistoryPersistence();
  try {
    const sessionsDirectory = join(home, '.factory', 'sessions', '2026', '08');
    mkdirSync(sessionsDirectory, { recursive: true });
    writeFileSync(
      join(sessionsDirectory, 'abandoned.jsonl'),
      providerSessionJsonl(
        {
          type: 'session_start',
          cwd: '/repo',
          sessionTitle: 'Abandoned session',
          settings: { interactionMode: 'auto' },
        },
        ['user'],
      ),
    );

    persistence.reconcileSessionFiles();

    assert.deepEqual(await persistence.searchSessions('hello'), []);
  } finally {
    persistence.close();
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});
