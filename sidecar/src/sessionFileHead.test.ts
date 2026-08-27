import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readSessionFileHead, readSessionStart } from './sessionFileHead.js';

const workspace = mkdtempSync(join(tmpdir(), 'droid-session-head-'));

test.after(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function messageLine(role: 'user' | 'assistant', text: string): string {
  return JSON.stringify({
    type: 'message',
    timestamp: '2026-08-09T00:00:00.000Z',
    message: { role, content: [{ type: 'text', text }] },
  });
}

// One provider session file: a session_start, a completed exchange, then a
// transcript body of `bodyLines` further assistant turns.
function writeSessionFile(name: string, bodyLines: number, padding = 512): string {
  const path = join(workspace, name);
  const body = Array.from({ length: bodyLines }, (_, index) =>
    messageLine('assistant', `${String(index)} ${'x'.repeat(padding)}`),
  );
  writeFileSync(
    path,
    `${[
      JSON.stringify({ type: 'session_start', cwd: '/repo/app', sessionTitle: 'Head test' }),
      messageLine('user', 'hello'),
      messageLine('assistant', 'hi'),
      ...body,
    ].join('\n')}\n`,
  );
  return path;
}

// rchar counts bytes this process pulled through read(2) whether or not they
// came from the page cache, which is exactly the cost the sidebar list pays.
function readCharsOrNull(): number | null {
  try {
    const match = /^rchar:\s*(\d+)$/m.exec(readFileSync('/proc/self/io', 'utf8'));
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

test('a session head read reports the start and a completed exchange', () => {
  const path = writeSessionFile('complete.jsonl', 4);

  const head = readSessionFileHead(path, statSync(path).size);

  assert.equal(head.start.type, 'session_start');
  assert.equal(head.start.cwd, '/repo/app');
  assert.equal(head.start.sessionTitle, 'Head test');
  assert.equal(head.hasCompletedConversation, true);
});

test('a session with no model reply is not a completed conversation', () => {
  const path = join(workspace, 'unanswered.jsonl');
  writeFileSync(
    path,
    `${[
      JSON.stringify({ type: 'session_start', cwd: '/repo/app', sessionTitle: 'Unanswered' }),
      messageLine('user', 'hello'),
    ].join('\n')}\n`,
  );

  const head = readSessionFileHead(path, statSync(path).size);

  assert.equal(head.start.sessionTitle, 'Unanswered');
  assert.equal(head.hasCompletedConversation, false);
});

test('an empty session file yields an empty start rather than throwing', () => {
  const path = join(workspace, 'empty.jsonl');
  writeFileSync(path, '');

  assert.deepEqual(readSessionFileHead(path, 0), {
    start: {},
    hasCompletedConversation: false,
  });
  assert.deepEqual(readSessionStart(path, 0), {});
});

test('a session_start beyond the first few lines is not searched for forever', () => {
  const path = join(workspace, 'no-start.jsonl');
  const lines = Array.from({ length: 40 }, (_, index) => messageLine('user', String(index)));
  lines.push(JSON.stringify({ type: 'session_start', sessionTitle: 'Too late' }));
  writeFileSync(path, `${lines.join('\n')}\n`);

  assert.deepEqual(readSessionStart(path, statSync(path).size), {});
});

test(
  'building a summary reads the head of a large transcript, not the transcript',
  { skip: readCharsOrNull() === null ? 'no /proc/self/io on this host' : false },
  () => {
    // ~8 MB of transcript behind a head that settles in the first kilobyte.
    const path = writeSessionFile('large.jsonl', 8_000, 1_000);
    const sizeBytes = statSync(path).size;
    assert.ok(sizeBytes > 8_000_000, `fixture is ${String(sizeBytes)} bytes`);
    // Warm the page cache so the measurement covers only the scan itself.
    readSessionFileHead(path, sizeBytes);

    const before = readCharsOrNull();
    readSessionFileHead(path, sizeBytes);
    const after = readCharsOrNull();

    assert.ok(before !== null && after !== null);
    const bytesRead = after - before;
    assert.ok(
      bytesRead < 16 * 1024,
      `head read consumed ${String(bytesRead)} of ${String(sizeBytes)} bytes`,
    );
  },
);

test('a session_start larger than the first scan window is still read whole', () => {
  const path = join(workspace, 'wide-start.jsonl');
  writeFileSync(
    path,
    `${[
      JSON.stringify({
        type: 'session_start',
        cwd: '/repo/app',
        sessionTitle: 'Wide start',
        // A settings blob well past the initial 8 KiB scan window.
        settings: { notes: 'n'.repeat(40_000) },
      }),
      messageLine('user', 'hello'),
      messageLine('assistant', 'hi'),
    ].join('\n')}\n`,
  );

  const head = readSessionFileHead(path, statSync(path).size);

  assert.equal(head.start.sessionTitle, 'Wide start');
  assert.equal(head.start.cwd, '/repo/app');
  assert.equal(head.hasCompletedConversation, true);
});
