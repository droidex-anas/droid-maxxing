import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { GUI_BENCH_SESSION_IDS, seedGuiBenchHistory } from './gui-bench-seed.ts';

const home = mkdtempSync(join(tmpdir(), 'gui-bench-seed-'));

test.after(() => {
  rmSync(home, { recursive: true, force: true });
});

test('seed writes admitted 3k and 10k chats plus a child-heavy and rich-content chat', () => {
  const manifest = seedGuiBenchHistory(home);
  assert.equal(manifest.sessions.length, 4);

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
    const body = readFileSync(session.path, 'utf8');
    assert.ok(body.includes('"type":"session_start"'));
    assert.ok(body.includes('"type":"message"'));
  }

  const events3k = readFileSync(chat3k.path, 'utf8');
  assert.ok(events3k.includes('"toolName":"Task"') || events3k.includes('Task'));
  assert.ok(events3k.includes('```'));

  const childPath = join(
    manifest.sessionsDir,
    `${GUI_BENCH_SESSION_IDS.chatChildren}-child-0.jsonl`,
  );
  const childStart = JSON.parse(readFileSync(childPath, 'utf8').split('\n')[0] ?? '{}') as {
    callingSessionId?: string;
  };
  assert.equal(childStart.callingSessionId, GUI_BENCH_SESSION_IDS.chatChildren);

  const heavy = byId.get(GUI_BENCH_SESSION_IDS.chatHeavy);
  assert.ok(heavy);
  const heavyText = readFileSync(heavy.path, 'utf8');
  assert.ok(heavyText.includes('```mermaid'));
  assert.ok(heavyText.includes('<json-render>'));
  assert.ok(heavyText.includes('```app'));
  assert.ok(heavyText.includes('| Col 0 |'));
});
