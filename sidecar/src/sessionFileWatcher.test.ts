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
  return {
    watchDirectory: (_root, listener) => {
      onChange = listener;
      return {
        onError: () => {},
        close: () => {},
      };
    },
    emit: (filename) => {
      if (!onChange) throw new Error('Controlled session watch has not started');
      onChange(filename);
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

function manualClock(): {
  now: () => number;
  schedule: (callback: () => void, delayMs: number) => NodeJS.Timeout;
  cancel: (timer: NodeJS.Timeout) => void;
  advance: (ms: number) => void;
  pendingTimers: () => number;
} {
  let currentMs = 0;
  const timers = new Map<number, { dueAt: number; callback: () => void }>();
  let nextId = 0;
  return {
    now: () => currentMs,
    schedule: (callback, delayMs) => {
      nextId += 1;
      timers.set(nextId, { dueAt: currentMs + delayMs, callback });
      return nextId as unknown as NodeJS.Timeout;
    },
    cancel: (timer) => {
      timers.delete(timer as unknown as number);
    },
    advance: (ms) => {
      const targetMs = currentMs + ms;
      for (;;) {
        const due = [...timers].filter(([, entry]) => entry.dueAt <= targetMs);
        if (due.length === 0) break;
        due.sort((left, right) => left[1].dueAt - right[1].dueAt);
        const [id, entry] = due[0];
        timers.delete(id);
        currentMs = entry.dueAt;
        entry.callback();
      }
      currentMs = targetMs;
    },
    pendingTimers: () => timers.size,
  };
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
      batchWindowMs: 0,
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
      batchWindowMs: 0,
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
      batchWindowMs: 0,
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

test('a subagent writing its own session file is reported while it keeps writing', () => {
  const root = mkdtempSync(join(tmpdir(), 'session-watcher-'));
  const dir = join(root, 'encoded-cwd');
  mkdirSync(dir);
  const payloads: (SessionFileChange[] | null)[] = [];
  const clock = manualClock();
  const controlledWatch = controlledSessionWatch();
  const watcher = startSessionFileWatcher(
    {
      root,
      batchWindowMs: 1_500,
      onExternalChange: (changes) => {
        payloads.push(changes);
      },
      now: clock.now,
      schedule: clock.schedule,
      cancel: clock.cancel,
    },
    controlledWatch.watchDirectory,
  );
  assert.ok(watcher);
  const subagent = [{ providerSessionId: 'subagent', path: join(dir, 'subagent.jsonl') }];
  try {
    // A spawned subagent creates its session file and then writes to it for as
    // long as it works.
    controlledWatch.emit('encoded-cwd/subagent.jsonl');
    clock.advance(50);
    assert.deepEqual(payloads, [subagent], 'a file nobody has reported yet is not made to wait');

    for (let elapsed = 0; elapsed < 1_500; elapsed += 100) {
      controlledWatch.emit('encoded-cwd/subagent.jsonl');
      clock.advance(100);
    }
    assert.deepEqual(payloads, [subagent, subagent], 'later writes report once per batch window');
  } finally {
    watcher.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('live session writes neither delay an external batch nor arm a timer', () => {
  const root = mkdtempSync(join(tmpdir(), 'session-watcher-'));
  const dir = join(root, 'encoded-cwd');
  mkdirSync(dir);
  const payloads: (SessionFileChange[] | null)[] = [];
  const clock = manualClock();
  const controlledWatch = controlledSessionWatch();
  const watcher = startSessionFileWatcher(
    {
      root,
      batchWindowMs: 1_500,
      isLiveSession: (id) => id === 'live-1',
      onExternalChange: (changes) => {
        payloads.push(changes);
      },
      now: clock.now,
      schedule: clock.schedule,
      cancel: clock.cancel,
    },
    controlledWatch.watchDirectory,
  );
  assert.ok(watcher);
  try {
    for (let elapsed = 0; elapsed < 5_000; elapsed += 100) {
      controlledWatch.emit('encoded-cwd/live-1.jsonl');
      clock.advance(100);
    }
    assert.equal(clock.pendingTimers(), 0, 'a live session streaming alone schedules no work');
    assert.equal(payloads.length, 0);

    controlledWatch.emit('encoded-cwd/external-1.jsonl');
    for (let elapsed = 0; elapsed < 1_500; elapsed += 100) {
      controlledWatch.emit('encoded-cwd/live-1.jsonl');
      clock.advance(100);
    }
    assert.deepEqual(
      payloads,
      [[{ providerSessionId: 'external-1', path: join(dir, 'external-1.jsonl') }]],
      'the live stream neither delayed nor duplicated the external report',
    );
    assert.equal(
      watcher.consumeLiveSessionFile('live-1'),
      join(dir, 'live-1.jsonl'),
      'live paths are still retained for targeted close reconciliation',
    );
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
      batchWindowMs: 0,
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
    batchWindowMs: 50,
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
