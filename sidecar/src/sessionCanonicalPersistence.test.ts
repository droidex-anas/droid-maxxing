import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DroidexDatabase } from './persistence/DroidexDatabase.js';
import { bindCanonicalStores } from './sessionCanonicalPersistence.js';

test('injected fakes do not open a canonical database', () => {
  const bound = bindCanonicalStores(
    { nextAppSessionId: () => 'app-test' },
    { createIfMissing: false },
  );
  assert.equal(bound.database, undefined);
  assert.equal(bound.lifecycle.sessionStore, undefined);
  assert.equal(bound.lifecycle.nextAppSessionId?.(), 'app-test');
});

test('production construction opens SessionStore and TranscriptStore', () => {
  const previous = process.env.DROIDEX_USER_DATA_DIR;
  const dir = mkdtempSync(join(tmpdir(), 'droidex-canonical-'));
  process.env.DROIDEX_USER_DATA_DIR = dir;
  try {
    const bound = bindCanonicalStores(undefined, { createIfMissing: true });
    assert.ok(bound.database instanceof DroidexDatabase);
    assert.ok(bound.lifecycle.sessionStore);
    assert.ok(bound.lifecycle.transcriptStore);
    bound.database.close();
  } finally {
    if (previous === undefined) delete process.env.DROIDEX_USER_DATA_DIR;
    else process.env.DROIDEX_USER_DATA_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an injected DroidexDatabase is reused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'droidex-canonical-injected-'));
  const db = new DroidexDatabase(join(dir, 'state', 'droidex.sqlite'));
  try {
    const bound = bindCanonicalStores({ database: db }, { createIfMissing: false });
    assert.equal(bound.database, db);
    assert.ok(bound.lifecycle.sessionStore);
    assert.equal(bound.lifecycle.sessionStore?.findByClientRef('missing'), undefined);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
