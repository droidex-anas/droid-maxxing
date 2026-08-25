import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  sessionIdFromSessionFileName,
  startSessionFileWatcher,
  type SessionFileChange,
} from './sessionFileWatcher.js';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function controlledSessionWatch(): {
  watchDirectory: (
    root: string,
    onChange: (filename: string | null) => void,
  ) => { onError: (listener: (error: unknown) => void) => void; close: () => void };
  emit: (filename: string | null) => void;
} {
  let onChange: ((filename: string | null) => void) | undefined;
  let isClosed = false;
  return {
    watchDirectory: (_root, listener) => {
      onChange = listener;
      return {
        onError: () => {},
        close: () => {
          isClosed = true;
        },
      };
    },
    emit: (filename) => {
      if (!onChange) throw new Error('Controlled session watch has not started');
      if (!isClosed) onChange(filename);
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for watcher condition');
    await delay(10);
  }
}

test('sessionIdFromSessionFileName extracts the provider session id', () => {
  assert.equal(sessionIdFromSessionFileName('encoded-cwd/dir/abc-123.jsonl'), 'abc-123');
  assert.equal(sessionIdFromSessionFileName('abc-123.jsonl'), 'abc-123');
  assert.equal(sessionIdFromSessionFileName('encoded-cwd\\dir\\abc-123.jsonl'), 'abc-123');
  assert.equal(sessionIdFromSessionFileName('encoded-cwd-dir'), undefined);
  assert.equal(sessionIdFromSessionFileName('notes.txt'), undefined);
  assert.equal(sessionIdFromSessionFileName(null), undefined);
});

test('external session file changes fire once with the changed files after writes settle', async () => {
  const root = mkdtempSync(join(tmpdir(), 'session-watcher-'));
  const dir = join(root, 'encoded-cwd');
  mkdirSync(dir);
  const payloads: (SessionFileChange[] | null)[] = [];
  const controlledWatch = controlledSessionWatch();
  const watcher = startSessionFileWatcher(
    {
      root,
      debounceMs: 0,
      onExternalChange: (changes) => {
        payloads.push(changes);
      },
    },
    controlledWatch.watchDirectory,
  );
  assert.ok(watcher);
  try {
    controlledWatch.emit('encoded-cwd/a.jsonl');
    controlledWatch.emit('encoded-cwd/b.jsonl');
    controlledWatch.emit('encoded-cwd/c.jsonl');
    await waitFor(() => payloads.length === 1);
    assert.equal(payloads.length, 1, 'a burst of changes coalesces into one callback');
    const changes = payloads[0];
    assert.ok(changes, 'file events explained by the batch reconcile exactly those files');
    assert.deepEqual(
      new Set(changes.map((change) => change.providerSessionId)),
      new Set(['a', 'b', 'c']),
    );
    for (const change of changes) {
      assert.equal(change.path, join(dir, `${change.providerSessionId}.jsonl`));
    }
  } finally {
    watcher.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a settings sidecar change reports its session file', async () => {
  const root = mkdtempSync(join(tmpdir(), 'session-watcher-'));
  const dir = join(root, 'encoded-cwd');
  mkdirSync(dir);
  const payloads: (SessionFileChange[] | null)[] = [];
  const controlledWatch = controlledSessionWatch();
  const watcher = startSessionFileWatcher(
    {
      root,
      debounceMs: 0,
      onExternalChange: (changes) => {
        payloads.push(changes);
      },
    },
    controlledWatch.watchDirectory,
  );
  assert.ok(watcher);
  try {
    controlledWatch.emit('encoded-cwd/a.settings.json');
    await waitFor(() => payloads.length === 1);
    const changes = payloads[0];
    assert.ok(changes, 'a settings event next to its session file stays targeted');
    assert.deepEqual(changes, [{ providerSessionId: 'a', path: join(dir, 'a.jsonl') }]);
  } finally {
    watcher.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('writes from live in-app sessions do not fire', async () => {
  const root = mkdtempSync(join(tmpdir(), 'session-watcher-'));
  const dir = join(root, 'encoded-cwd');
  mkdirSync(dir);
  let calls = 0;
  const controlledWatch = controlledSessionWatch();
  const watcher = startSessionFileWatcher(
    {
      root,
      debounceMs: 0,
      isLiveSession: (id) => id === 'live-1',
      onExternalChange: () => {
        calls += 1;
      },
    },
    controlledWatch.watchDirectory,
  );
  assert.ok(watcher);
  try {
    controlledWatch.emit('encoded-cwd/live-1.jsonl');
    assert.equal(
      watcher.consumeLiveSessionFile('live-1'),
      join(dir, 'live-1.jsonl'),
      'the watcher retains a live file path for targeted close reconciliation',
    );
    assert.equal(
      watcher.consumeLiveSessionFile('live-1'),
      undefined,
      'consuming a live file path forgets it',
    );
    controlledWatch.emit('encoded-cwd/external-1.jsonl');
    await waitFor(() => calls === 1);
    assert.equal(calls, 1, 'the live write does not add another external callback');
  } finally {
    watcher.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('close stops further callbacks', async () => {
  const root = mkdtempSync(join(tmpdir(), 'session-watcher-'));
  const dir = join(root, 'encoded-cwd');
  mkdirSync(dir);
  let calls = 0;
  const controlledWatch = controlledSessionWatch();
  const watcher = startSessionFileWatcher(
    {
      root,
      debounceMs: 0,
      onExternalChange: () => {
        calls += 1;
      },
    },
    controlledWatch.watchDirectory,
  );
  assert.ok(watcher);
  try {
    controlledWatch.emit('encoded-cwd/a.jsonl');
    await waitFor(() => calls === 1);
    watcher.close();
    controlledWatch.emit('encoded-cwd/b.jsonl');
    assert.equal(calls, 1);
  } finally {
    watcher.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('returns null when the sessions root cannot be watched', () => {
  // A path whose parent is a regular file cannot be created or watched, so
  // the watcher gives up and returns null. A merely-missing root is now
  // created so live republish starts on a first run with no history yet.
  const blocker = join(tmpdir(), 'session-watcher-blocker');
  writeFileSync(blocker, '');
  try {
    const watcher = startSessionFileWatcher({
      root: join(blocker, 'sessions'),
      onExternalChange: () => {},
    });
    assert.equal(watcher, null);
  } finally {
    rmSync(blocker, { force: true });
  }
});

test('a missing sessions root is created so the watcher starts on first run', () => {
  const root = join(tmpdir(), 'session-watcher-first-run-', String(Date.now()), 'sessions');
  const watcher = startSessionFileWatcher({
    root,
    debounceMs: 50,
    onExternalChange: () => {},
  });
  try {
    assert.ok(watcher, 'the watcher starts even when the root did not exist');
    // The root is created so external writes (a first Droid CLI run) are seen.
    assert.ok(existsSync(root), 'the missing sessions root is created');
  } finally {
    watcher?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
