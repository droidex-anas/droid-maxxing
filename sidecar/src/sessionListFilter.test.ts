import assert from 'node:assert/strict';
import test from 'node:test';
import type { SessionSummary } from './protocol.js';
import {
  FAMILIAR_PREEXISTING_SESSIONS_PER_WORKSPACE,
  filterSessionListSummaries,
} from './sessionListFilter.js';
import { droidSessionConfiguration } from './providers/providerIdentity.js';

const summary = (
  appSessionId: string,
  cwd: string,
  updatedAt: number,
  extra: Partial<SessionSummary> = {},
): SessionSummary => ({
  appSessionId,
  providerSessionId: appSessionId,
  sessionPurpose: 'chat',
  role: 'primary',
  title: appSessionId,
  goal: appSessionId,
  cwd,
  workspaceKind: cwd ? 'folder' : 'none',
  configuration: droidSessionConfiguration({
    modelId: 'model-default',
    interactionMode: 'auto',
    autonomy: 'low',
  }),
  phase: 'paused',
  features: [],
  tokensIn: 0,
  tokensOut: 0,
  contextTokens: 0,
  createdAt: updatedAt,
  updatedAt,
  ...extra,
});

const nothingIsAppOwned = () => false;
const ownedBy = (appSessionIds: string[]) => (row: SessionSummary) =>
  appSessionIds.includes(row.appSessionId);

test('a workspace open lists only the newest pre-existing sessions and reports the rest', () => {
  const summaries = [
    summary('other-workspace', '/repo/other', 200),
    ...Array.from({ length: 7 }, (_, i) => summary(`app-${String(i)}`, '/repo/app', i + 1)),
    ...Array.from({ length: 3 }, (_, i) => summary(`api-${String(i)}`, '/repo/api', i + 10)),
  ];

  const page = filterSessionListSummaries(
    summaries,
    { workspaceCwds: ['/repo/app', '/repo/api'] },
    nothingIsAppOwned,
  );

  assert.equal(FAMILIAR_PREEXISTING_SESSIONS_PER_WORKSPACE, 5);
  assert.deepEqual(
    page.sessions.map((row) => row.appSessionId),
    ['api-2', 'api-1', 'api-0', 'app-6', 'app-5', 'app-4', 'app-3', 'app-2'],
  );
  assert.deepEqual(page.earlierSessionsByCwd, { '/repo/app': 2 });
});

test('sessions DROIDEX ran are listed regardless of how old they are', () => {
  const summaries = [
    summary('ours-ancient', '/repo/app', 1),
    ...Array.from({ length: 20 }, (_, i) => summary(`theirs-${String(i)}`, '/repo/app', i + 100)),
  ];

  const page = filterSessionListSummaries(
    summaries,
    { workspaceCwds: ['/repo/app'] },
    ownedBy(['ours-ancient']),
  );

  assert.ok(page.sessions.some((row) => row.appSessionId === 'ours-ancient'));
  assert.equal(page.sessions.length, FAMILIAR_PREEXISTING_SESSIONS_PER_WORKSPACE + 1);
  assert.deepEqual(page.earlierSessionsByCwd, { '/repo/app': 15 });
});

test('app-owned sessions do not consume the pre-existing budget', () => {
  const summaries = Array.from({ length: 12 }, (_, i) => summary(`s-${String(i)}`, '/repo/app', i));

  const page = filterSessionListSummaries(
    summaries,
    { workspaceCwds: ['/repo/app'] },
    ownedBy(['s-11', 's-10', 's-9']),
  );

  assert.deepEqual(
    page.sessions.map((row) => row.appSessionId),
    ['s-11', 's-10', 's-9', 's-8', 's-7', 's-6', 's-5', 's-4'],
  );
  assert.deepEqual(page.earlierSessionsByCwd, { '/repo/app': 4 });
});

test('revealing a workspace lists every session it has and clears its earlier count', () => {
  const summaries = Array.from({ length: 9 }, (_, i) =>
    summary(`app-${String(i)}`, '/repo/app', i),
  );

  const page = filterSessionListSummaries(
    summaries,
    { workspaceCwds: ['/repo/app'], revealEarlierCwds: ['/repo/app'] },
    nothingIsAppOwned,
  );

  assert.equal(page.sessions.length, 9);
  assert.deepEqual(page.earlierSessionsByCwd, {});
});

test('revealing one workspace leaves the others bounded', () => {
  const summaries = [
    ...Array.from({ length: 8 }, (_, i) => summary(`app-${String(i)}`, '/repo/app', i)),
    ...Array.from({ length: 8 }, (_, i) => summary(`api-${String(i)}`, '/repo/api', i + 100)),
  ];

  const page = filterSessionListSummaries(
    summaries,
    { workspaceCwds: ['/repo/app', '/repo/api'], revealEarlierCwds: ['/repo/api'] },
    nothingIsAppOwned,
  );

  assert.equal(page.sessions.filter((row) => row.cwd === '/repo/api').length, 8);
  assert.equal(page.sessions.filter((row) => row.cwd === '/repo/app').length, 5);
  assert.deepEqual(page.earlierSessionsByCwd, { '/repo/app': 3 });
});

test('folder-less chats are never withheld', () => {
  const summaries = [
    ...Array.from({ length: 7 }, (_, i) => summary(`plain-${String(i)}`, '', i + 1)),
    ...Array.from({ length: 7 }, (_, i) => summary(`app-${String(i)}`, '/repo/app', i + 20)),
    summary('other-workspace', '/repo/other', 100),
  ];

  const page = filterSessionListSummaries(
    summaries,
    { workspaceCwds: ['/repo/app'], includePlainChats: true },
    nothingIsAppOwned,
  );

  assert.deepEqual(
    page.sessions.map((row) => row.appSessionId),
    [
      'app-6',
      'app-5',
      'app-4',
      'app-3',
      'app-2',
      'plain-6',
      'plain-5',
      'plain-4',
      'plain-3',
      'plain-2',
      'plain-1',
      'plain-0',
    ],
  );
  assert.deepEqual(page.earlierSessionsByCwd, { '/repo/app': 2 });
});

test('an unscoped list is not bounded', () => {
  const summaries = Array.from({ length: 9 }, (_, i) =>
    summary(`app-${String(i)}`, '/repo/app', i),
  );

  const page = filterSessionListSummaries(summaries, {}, nothingIsAppOwned);

  assert.equal(page.sessions.length, 9);
  assert.deepEqual(page.earlierSessionsByCwd, {});
});
