import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { HistoryIndex as HistoryIndexType } from './history.js';

const originalHome = process.env.HOME;
const home = mkdtempSync(join(tmpdir(), 'droid-history-index-home-'));
process.env.HOME = home;

const {
  HistoryIndex,
  SESSION_SEARCH_INDEX_FILENAME,
  createHistorySessionFileCache,
  invalidateSessionIndex,
  loadSessionHistory,
  loadSessionPage,
  loadSessionTranscriptWindow,
  resolveSessionChain,
} = await import('./history.js');

function reconcileHistoryIndex(
  index: HistoryIndexType,
  changes?: Array<{ providerSessionId: string; path: string }>,
): number {
  const db = new DatabaseSync(join(home, '.factory', 'droidex', SESSION_SEARCH_INDEX_FILENAME));
  try {
    const cache = createHistorySessionFileCache(db);
    const result = changes ? cache.reconcilePathChanges(changes) : cache.reconcileChanges();
    if (!index.applySessionFileReconciliation(result)) {
      index.replaceSessionFileSnapshot(cache.snapshot(result.changed));
    }
    return result.changed;
  } finally {
    db.close();
  }
}

test.after(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
});

let seq = 0;
function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}`;
}

function writeSession(id: string, text?: string): string {
  const dir = join(home, '.factory', 'sessions');
  mkdirSync(dir, { recursive: true });
  const lines = [
    JSON.stringify({
      type: 'session_start',
      cwd: '',
      sessionTitle: `Chat ${id}`,
      settings: { interactionMode: 'auto' },
    }),
  ];
  if (text !== undefined) {
    lines.push(
      JSON.stringify({
        type: 'message',
        id: `m-${id}`,
        timestamp: new Date().toISOString(),
        message: { role: 'user', content: [{ type: 'text', text }] },
      }),
    );
  }
  const path = join(dir, `${id}.jsonl`);
  writeFileSync(path, `${lines.join('\n')}\n`);
  return path;
}

test('session launch settings resolve the exact provider-scoped model and reasoning', () => {
  invalidateSessionIndex();
  const id = nextId('launch-settings');
  const path = writeSession(id);
  writeFileSync(
    path.replace(/\.jsonl$/, '.settings.json'),
    JSON.stringify({ model: 'custom:glm-5.2', reasoningEffort: 'max' }),
  );
  const index = new HistoryIndex();
  try {
    reconcileHistoryIndex(index, [{ providerSessionId: id, path }]);
    unlinkSync(path);
    unlinkSync(path.replace(/\.jsonl$/, '.settings.json'));
    assert.deepEqual(index.sessionLaunchSettings(id), {
      modelId: 'custom:glm-5.2',
      reasoningEffort: 'max',
    });
  } finally {
    index.close();
  }
});

test('a worker reconciliation delta seeds provider paths without a main-thread tree scan', () => {
  invalidateSessionIndex();
  const directory = mkdtempSync(join(tmpdir(), 'droid-history-index-delta-'));
  const id = nextId('worker-delta');
  const path = join(directory, `${id}.jsonl`);
  writeFileSync(
    path,
    `${[
      {
        type: 'session_start',
        cwd: '',
        sessionTitle: `Chat ${id}`,
        settings: { interactionMode: 'auto' },
      },
      {
        type: 'message',
        id: `m-${id}`,
        timestamp: new Date().toISOString(),
        message: { role: 'user', content: [{ type: 'text', text: 'outside tree' }] },
      },
    ]
      .map((line) => JSON.stringify(line))
      .join('\n')}\n`,
  );
  const index = new HistoryIndex();
  try {
    index.applySessionFileReconciliation({
      previousRevision: 0,
      revision: 1,
      changed: 1,
      upserts: [
        {
          providerSessionId: id,
          path,
          birthtimeMs: 1,
          mtimeMs: 1,
          sizeBytes: 1,
          settingsMtimeMs: null,
          summary: null,
        },
      ],
      removedProviderSessionIds: [],
    });

    assert.equal(loadSessionPage(id, id).events[0]?.text, 'outside tree');
  } finally {
    index.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('resolveSessionChain sees new files only after a worker reconciliation delta', () => {
  invalidateSessionIndex();
  const index = new HistoryIndex();
  try {
    const first = nextId('idx-first');
    const firstPath = writeSession(first);
    reconcileHistoryIndex(index, [{ providerSessionId: first, path: firstPath }]);
    assert.deepEqual(resolveSessionChain(first, first), [first]);

    const later = nextId('idx-later');
    const laterPath = writeSession(later);
    assert.deepEqual(resolveSessionChain(later, later), []);
    reconcileHistoryIndex(index, [{ providerSessionId: later, path: laterPath }]);
    assert.deepEqual(resolveSessionChain(later, later), [later]);
    assert.deepEqual(resolveSessionChain(first, first), [first]);
  } finally {
    index.close();
  }
});

test('resolveSessionChain returns an empty chain for a session that exists nowhere', () => {
  invalidateSessionIndex();
  assert.deepEqual(resolveSessionChain('idx-unknown', 'idx-unknown'), []);
});

test('loadSessionPage uses worker-published paths for newly created files', () => {
  invalidateSessionIndex();
  const index = new HistoryIndex();
  try {
    const first = nextId('page-first');
    const firstPath = writeSession(first, 'first');
    reconcileHistoryIndex(index, [{ providerSessionId: first, path: firstPath }]);
    loadSessionPage(first, first);

    const later = nextId('page-later');
    const laterPath = writeSession(later, 'later hello');
    assert.throws(() => loadSessionPage(later, later), /not found/);
    reconcileHistoryIndex(index, [{ providerSessionId: later, path: laterPath }]);
    const page = loadSessionPage(later, later);
    assert.equal(page.events.length, 1);
    assert.equal(page.events[0]?.kind, 'text');
  } finally {
    index.close();
  }
});

test('loadSessionPage still rejects a session that exists nowhere', () => {
  invalidateSessionIndex();
  assert.throws(() => loadSessionPage('page-missing', 'page-missing'), /not found/);
});

test('invalidating the path mirror never triggers a synchronous tree rescan', () => {
  invalidateSessionIndex();
  const first = nextId('list-first');
  const firstPath = writeSession(first);
  const index = new HistoryIndex();
  try {
    reconcileHistoryIndex(index, [{ providerSessionId: first, path: firstPath }]);
    assert.deepEqual(resolveSessionChain(first, first), [first]);
    invalidateSessionIndex();
    assert.deepEqual(resolveSessionChain(first, first), []);
  } finally {
    index.close();
  }
});

test('targeted lookups stay missing until the worker publishes the path', () => {
  invalidateSessionIndex();
  const id = nextId('warm');
  const path = writeSession(id);
  const index = new HistoryIndex();
  try {
    assert.deepEqual(resolveSessionChain(id, id), []);
    reconcileHistoryIndex(index, [{ providerSessionId: id, path }]);
    assert.deepEqual(resolveSessionChain(id, id), [id]);
  } finally {
    index.close();
  }
});

test('loadSessionTranscriptWindow serves repeat loads through the memoized index', () => {
  invalidateSessionIndex();
  const id = nextId('window');
  const path = writeSession(id, 'windowed hello');
  const index = new HistoryIndex();
  try {
    reconcileHistoryIndex(index, [{ providerSessionId: id, path }]);
    const chain = resolveSessionChain(id, id);
    const first = loadSessionTranscriptWindow(id, chain);
    assert.equal(first.events.length, 1);
    const repeat = loadSessionTranscriptWindow(id, chain);
    assert.equal(repeat.events.length, 1);
    assert.equal(repeat.events[0]?.id, first.events[0]?.id);
  } finally {
    index.close();
  }
});

test('a worker reconciliation delta removes a deleted path from the memo', () => {
  invalidateSessionIndex();
  const id = nextId('memo-removed');
  writeSession(id, 'about to be removed');
  const index = new HistoryIndex();
  try {
    // Populate the file cache so a later deletion is detected as a change...
    reconcileHistoryIndex(index);
    // ...then build the lifetime session index memo with the file present.
    assert.deepEqual(resolveSessionChain(id, id), [id]);

    // Remove the file and reconcile: the cache detects the deletion and the
    // memo must drop the now-stale id -> path so a transcript load resolves
    // nothing instead of following a path that no longer exists.
    rmSync(join(home, '.factory', 'sessions', `${id}.jsonl`));
    assert.equal(reconcileHistoryIndex(index), 1, 'the deleted file is reconciled away');
    const window = loadSessionTranscriptWindow(id, [id]);
    assert.equal(window.events.length, 0, 'a removed session resolves no transcript');
  } finally {
    index.close();
  }
});

test('targeted reconciliation invalidates history enumeration for creation and deletion', () => {
  invalidateSessionIndex();
  loadSessionHistory();
  const id = nextId('targeted-memo');
  const path = writeSession(id, 'external session');
  const index = new HistoryIndex();
  try {
    assert.equal(
      reconcileHistoryIndex(index, [{ providerSessionId: id, path }]),
      1,
      'the new file enters the cache',
    );
    assert.equal(
      loadSessionHistory().some((row) => row.providerSessionId === id),
      true,
      'targeted creation refreshes history enumeration',
    );

    rmSync(path);
    assert.equal(
      reconcileHistoryIndex(index, [{ providerSessionId: id, path }]),
      1,
      'the removed file leaves the cache',
    );
    assert.equal(
      loadSessionHistory().some((row) => row.providerSessionId === id),
      false,
      'targeted deletion refreshes history enumeration',
    );
  } finally {
    index.close();
  }
});
