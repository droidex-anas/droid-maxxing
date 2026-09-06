import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type * as Protocol from './protocol.js';
import { FAMILIAR_PREEXISTING_SESSIONS_PER_WORKSPACE } from './sessionListFilter.js';
import { providerSessionJsonl } from './testing/providerSessionFixtures.js';
import { persistTestSummaries } from './testing/historyPersistenceFixture.js';

const originalHome = process.env.HOME;
const home = mkdtempSync(join(tmpdir(), 'droid-session-scoping-home-'));
process.env.HOME = home;

const { HistoryIndex } = await import('./history.js');
const { SessionManager } = await import('./SessionManager.js');

const workspace = join(home, 'repo');

test.after(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
});

// A session file a Droid CLI (or any other client) left behind. `ageRank` orders
// the folder: 0 is the newest. mtime is the recency signal the list sorts by.
function writePreexistingSession(id: string, cwd: string, ageRank: number): string {
  const dir = join(home, '.factory', 'sessions');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.jsonl`);
  writeFileSync(
    path,
    providerSessionJsonl({
      type: 'session_start',
      cwd,
      sessionTitle: `CLI chat ${id}`,
      settings: { interactionMode: 'auto' },
    }),
  );
  const modified = new Date(Date.UTC(2026, 0, 1) + (100 - ageRank) * 60_000);
  utimesSync(path, modified, modified);
  return path;
}

function appSummary(appSessionId: string, cwd: string, updatedAt: number): Protocol.SessionSummary {
  return {
    appSessionId,
    providerSessionId: appSessionId,
    sessionPurpose: 'chat',
    interactionMode: 'auto',
    role: 'primary',
    title: `DROIDEX chat ${appSessionId}`,
    goal: `DROIDEX chat ${appSessionId}`,
    cwd,
    workspaceKind: 'folder',
    autonomy: 'low',
    phase: 'paused',
    streaming: false,
    queuedSends: 0,
    features: [],
    tokensIn: 0,
    tokensOut: 0,
    contextTokens: 0,
    createdAt: updatedAt,
    updatedAt,
  };
}

async function listSessions(
  command: Extract<Protocol.ClientCommand, { type: 'sessions.list' }>,
): Promise<Extract<Protocol.ServerEvent, { type: 'sessions.list' }>> {
  const events: Protocol.ServerEvent[] = [];
  const manager = new SessionManager((event) => events.push(event));
  try {
    await manager.handle(command);
  } finally {
    await manager.shutdown();
  }
  const list = events.filter((event) => event.type === 'sessions.list').at(-1);
  assert.ok(list?.type === 'sessions.list', 'the command publishes a session list');
  return list;
}

const PREEXISTING_COUNT = 12;
for (let rank = 0; rank < PREEXISTING_COUNT; rank++) {
  writePreexistingSession(`cli-${String(rank)}`, workspace, rank);
}
// The oldest file in the folder, but DROIDEX ran it.
writePreexistingSession('ours-oldest', workspace, PREEXISTING_COUNT + 10);
const index = new HistoryIndex();
persistTestSummaries([appSummary('ours-oldest', workspace, 1)]);
index.close();

test('opening a folder lists the newest pre-existing sessions and reports the rest', async () => {
  const list = await listSessions({ type: 'sessions.list', workspaceCwds: [workspace] });

  const preexisting = list.sessions.filter((session) => session.appSessionId.startsWith('cli-'));
  assert.deepEqual(
    preexisting.map((session) => session.appSessionId),
    ['cli-0', 'cli-1', 'cli-2', 'cli-3', 'cli-4'],
  );
  assert.equal(preexisting.length, FAMILIAR_PREEXISTING_SESSIONS_PER_WORKSPACE);
  assert.deepEqual(list.earlierSessionsByCwd, {
    [workspace]: PREEXISTING_COUNT - FAMILIAR_PREEXISTING_SESSIONS_PER_WORKSPACE,
  });
});

test('a session DROIDEX ran stays listed even as the oldest file in the folder', async () => {
  const list = await listSessions({ type: 'sessions.list', workspaceCwds: [workspace] });

  assert.ok(list.sessions.some((session) => session.appSessionId === 'ours-oldest'));
  assert.equal(list.sessions.length, FAMILIAR_PREEXISTING_SESSIONS_PER_WORKSPACE + 1);
});

test('showing earlier sessions lists the whole folder and clears its count', async () => {
  const list = await listSessions({
    type: 'sessions.list',
    workspaceCwds: [workspace],
    revealEarlierCwds: [workspace],
  });

  assert.equal(list.sessions.length, PREEXISTING_COUNT + 1);
  assert.deepEqual(list.earlierSessionsByCwd, {});
});

test('a revealed session still opens with its complete history', async () => {
  const events: Protocol.ServerEvent[] = [];
  const manager = new SessionManager((event) => events.push(event));
  try {
    await manager.handle({
      type: 'sessions.list',
      workspaceCwds: [workspace],
      revealEarlierCwds: [workspace],
    });
    // cli-11 is the oldest pre-existing session, withheld until revealed.
    await manager.handle({ type: 'session.loadHistory', appSessionId: 'cli-11' });
  } finally {
    await manager.shutdown();
  }

  const history = events.filter((event) => event.type === 'session.history').at(-1);
  assert.ok(history?.type === 'session.history');
  assert.equal(history.appSessionId, 'cli-11');
  assert.deepEqual(
    history.transcripts.map((entry) => [entry.kind, entry.author, entry.text]),
    [
      ['text', 'user', 'hello'],
      ['text', undefined, 'hello'],
    ],
  );
});
