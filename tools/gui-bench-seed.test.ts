import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { hasCompletedConversation } from '../sidecar/src/sessionHistoryAdmission.ts';
import { parseFullSessionTranscript } from '../sidecar/src/sessionTranscript.ts';
import { GUI_BENCH_SESSION_IDS, seedGuiBenchHistory } from './gui-bench-seed.ts';

const home = mkdtempSync(join(tmpdir(), 'gui-bench-seed-'));

test.after(() => {
  rmSync(home, { recursive: true, force: true });
});

test('seed writes admitted 3k and 10k chats plus a child-heavy chat', () => {
  const manifest = seedGuiBenchHistory(home);
  assert.equal(manifest.sessions.length, 3);

  const byId = new Map(manifest.sessions.map((session) => [session.id, session]));
  const chat3k = byId.get(GUI_BENCH_SESSION_IDS.chat3k);
  const chat10k = byId.get(GUI_BENCH_SESSION_IDS.chat10k);
  const children = byId.get(GUI_BENCH_SESSION_IDS.chatChildren);
  assert.ok(chat3k);
  assert.ok(chat10k);
  assert.ok(children);

  assert.ok(chat3k.eventCount >= 3_000);
  assert.ok(chat3k.eventCount < 3_040);
  assert.ok(chat10k.eventCount >= 10_000);
  assert.ok(chat10k.eventCount < 10_040);
  assert.equal(children.childCount, 24);

  for (const session of [chat3k, chat10k, children]) {
    const size = readFileSync(session.path).byteLength;
    assert.equal(hasCompletedConversation(session.path, size), true);
    const events = parseFullSessionTranscript(session.id, session.id, session.path, 'primary');
    assert.ok(events.length >= session.eventCount - 2);
    const kinds = new Set(events.map((event) => event.kind));
    assert.ok(kinds.has('text'));
  }

  const events3k = parseFullSessionTranscript(chat3k.id, chat3k.id, chat3k.path, 'primary');
  const kinds3k = new Set(events3k.map((event) => event.kind));
  assert.ok(kinds3k.has('tool_call'));
  assert.ok(kinds3k.has('tool_result'));
  assert.ok(events3k.some((event) => (event.text ?? '').includes('```')));
  assert.ok(events3k.some((event) => event.toolName === 'Task'));

  const childPath = join(manifest.sessionsDir, `${GUI_BENCH_SESSION_IDS.chatChildren}-child-0.jsonl`);
  const childStart = JSON.parse(readFileSync(childPath, 'utf8').split('\n')[0] ?? '{}') as {
    callingSessionId?: string;
  };
  assert.equal(childStart.callingSessionId, GUI_BENCH_SESSION_IDS.chatChildren);
});
