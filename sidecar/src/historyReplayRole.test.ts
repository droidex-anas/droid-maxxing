import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const originalHome = process.env.HOME;
const home = mkdtempSync(join(tmpdir(), 'droid-history-role-'));
process.env.HOME = home;

const { HistoryIndex, loadSessionPage, loadSessionTranscriptWindow } = await import('./history.js');

test.after(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
});

function writeTranscript(
  id: string,
  start: Record<string, unknown>,
  messages: Record<string, unknown>[] = [
    {
      type: 'message',
      id: 'm1',
      timestamp: '2026-06-12T00:00:00.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'hello from worker' }] },
    },
  ],
): void {
  const dir = join(home, '.factory', 'sessions', '2026', '06');
  mkdirSync(dir, { recursive: true });
  const lines = [
    JSON.stringify({ type: 'session_start', cwd: home, sessionTitle: 'S', ...start }),
    ...messages.map((message) => JSON.stringify(message)),
  ];
  const path = join(dir, `${id}.jsonl`);
  writeFileSync(path, `${lines.join('\n')}\n`);
  const stat = statSync(path);
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
          birthtimeMs: stat.birthtimeMs,
          mtimeMs: stat.mtimeMs,
          sizeBytes: stat.size,
          settingsMtimeMs: null,
          summary: null,
        },
      ],
      removedProviderSessionIds: [],
    });
  } finally {
    index.close();
  }
}

test('loadSessionPage replays a marker-only Task child with worker role keyed to its provider id', () => {
  writeTranscript('child-session', {
    callingSessionId: 'parent-session',
    callingToolUseId: 'tool-1',
  });

  const page = loadSessionPage('child-session', 'parent-app', undefined, 200);
  const text = page.events.find((e) => e.kind === 'text');

  assert.ok(text, 'expected a text event');
  assert.equal(text!.sourceSessionId, 'child-session');
  assert.equal(text!.role, 'worker');
});

test('loadSessionPage replays a top-level session as primary', () => {
  writeTranscript('plain-session', {});

  const page = loadSessionPage('plain-session', 'plain-session', undefined, 200);
  const text = page.events.find((e) => e.kind === 'text');

  assert.ok(text, 'expected a text event');
  assert.equal(text!.sourceSessionId, 'primary');
  assert.equal(text!.role, 'primary');
});

test('loadSessionPage never reclassifies a Task child as a top-level session', () => {
  writeTranscript('orphan-child', {
    callingSessionId: 'gone-parent',
    callingToolUseId: 'tool-x',
  });

  const page = loadSessionPage('orphan-child', 'orphan-child', undefined, 200);
  const text = page.events.find((e) => e.kind === 'text');

  assert.ok(text, 'expected a text event');
  assert.equal(text!.role, 'worker');
  assert.equal(text!.sourceSessionId, 'orphan-child');
});

test('transcript windows parse child-only skill messages with the child role', () => {
  writeTranscript(
    'child-skill',
    {
      callingSessionId: 'parent-session',
      callingToolUseId: 'tool-skill',
    },
    [
      {
        type: 'message',
        id: 'skill-1',
        timestamp: '2026-06-12T00:00:00.000Z',
        message: {
          role: 'user',
          visibility: 'user_only',
          content: [{ type: 'text', text: 'Skill "review" activated: child task' }],
        },
      },
    ],
  );

  const primary = loadSessionTranscriptWindow('parent-app', ['child-skill'], {
    role: 'primary',
  });
  const child = loadSessionTranscriptWindow('parent-app', ['child-skill'], { role: 'worker' });

  assert.equal(primary.events.length, 2);
  assert.deepEqual(child.events, []);
});
