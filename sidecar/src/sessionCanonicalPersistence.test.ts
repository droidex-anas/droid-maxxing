import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { DroidexDatabase } from './persistence/DroidexDatabase.js';
import {
  abandonOwnedSidecarResources,
  bindCanonicalStores,
  bindCanonicalStoresForManager,
} from './sessionCanonicalPersistence.js';

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

test('abandonOwnedSidecarResources closes history and browsers then rethrows', async () => {
  let historyClosed = 0;
  let browsersClosed = 0;
  const bindError = new Error('schema mismatch');
  assert.throws(
    () =>
      abandonOwnedSidecarResources(
        {
          closeHistory: () => {
            historyClosed += 1;
          },
          closeBrowsers: async () => {
            browsersClosed += 1;
          },
        },
        bindError,
      ),
    (error: unknown) => error === bindError,
  );
  assert.equal(historyClosed, 1);
  await Promise.resolve();
  assert.equal(browsersClosed, 1);
});

test('abandonOwnedSidecarResources still closes browsers if history.close throws', async () => {
  let browsersClosed = 0;
  const bindError = new Error('wal failed');
  assert.throws(
    () =>
      abandonOwnedSidecarResources(
        {
          closeHistory: () => {
            throw new Error('history close failed');
          },
          closeBrowsers: async () => {
            browsersClosed += 1;
          },
        },
        bindError,
      ),
    (error: unknown) => error === bindError,
  );
  await Promise.resolve();
  assert.equal(browsersClosed, 1);
});

test('production bind failure closes already constructed sidecar resources', async () => {
  const previous = process.env.DROIDEX_USER_DATA_DIR;
  const dir = mkdtempSync(join(tmpdir(), 'droidex-canonical-fail-'));
  process.env.DROIDEX_USER_DATA_DIR = dir;
  mkdirSync(join(dir, 'state'), { recursive: true });
  const bad = new DatabaseSync(join(dir, 'state', 'droidex.sqlite'));
  try {
    bad.exec('CREATE TABLE dummy (id INTEGER)');
    bad.exec('PRAGMA user_version = 99');
  } finally {
    bad.close();
  }
  let historyClosed = 0;
  let browsersClosed = 0;
  try {
    assert.throws(() =>
      bindCanonicalStoresForManager(undefined, {
        history: {
          close: () => {
            historyClosed += 1;
          },
        },
        browsers: {
          closeAll: async () => {
            browsersClosed += 1;
          },
        },
      }),
    );
    assert.equal(historyClosed, 1);
    await Promise.resolve();
    assert.equal(browsersClosed, 1);
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
