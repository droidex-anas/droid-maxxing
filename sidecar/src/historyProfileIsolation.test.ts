import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { HistoryPersistence } from './HistoryPersistence.js';
import { SESSION_INDEX_FILENAME } from './history.js';

test('concurrent profiles persist history independently without competing for a writer lease', () => {
  const root = mkdtempSync(join(tmpdir(), 'droidex-profiles-'));
  const previous = process.env.DROIDEX_HISTORY_DIR;
  const stores: HistoryPersistence[] = [];
  try {
    for (const profile of ['main', 'dev']) {
      process.env.DROIDEX_HISTORY_DIR = join(root, profile);
      const store = new HistoryPersistence();
      stores.push(store);
      store.recordEvent({
        id: profile,
        appSessionId: profile,
        sourceSessionId: profile,
        kind: 'text',
        role: 'primary',
        ts: 1,
      });
      store.flushSync();
    }
    for (const profile of ['main', 'dev']) {
      const db = new DatabaseSync(join(root, profile, SESSION_INDEX_FILENAME), { readOnly: true });
      try {
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM events').get()?.count, 1);
        assert.equal(db.prepare('SELECT id FROM events').get()?.id, profile);
      } finally {
        db.close();
      }
    }
  } finally {
    for (const store of stores) store.close();
    if (previous === undefined) delete process.env.DROIDEX_HISTORY_DIR;
    else process.env.DROIDEX_HISTORY_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
