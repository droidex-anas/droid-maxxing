import test from 'node:test';
import assert from 'node:assert/strict';
import type { SessionAttentionKind } from './sessionAttention';
import type { SessionSummary } from '../types/bridge';
import {
  canSettleSession,
  pruneSettledSessions,
  isSidebarFilter,
  DEFAULT_SIDEBAR_PREFERENCES,
  loadSidebarActivity,
  saveSidebarActivity,
  sessionActivityStatus,
  matchesActivityFilter,
  compareSidebarSessions,
} from './sidebarActivity';

const session: SessionSummary = {
  appSessionId: 'older-chat',
  title: 'Review sidebar',
  goal: '',
  cwd: '/workspace',
  sessionPurpose: 'chat',
  interactionMode: 'auto',
  role: 'primary',
  autonomy: 'off',
  phase: 'running',
  streaming: false,
  createdAt: 1,
  updatedAt: 100,
  features: [],
  tokensIn: 0,
  tokensOut: 0,
  contextTokens: 0,
};

test('settling survives reload, while new activity and requests return the task to attention', () => {
  const stored = new Map<string, string>();
  const storage = {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => {
      stored.set(key, value);
    },
  };
  saveSidebarActivity(storage, {
    ...DEFAULT_SIDEBAR_PREFERENCES,
    view: 'activity',
    order: 'title',
    limit: 10,
    settled: { [session.appSessionId]: session.updatedAt },
  });
  const reloaded = loadSidebarActivity(storage);
  assert.equal(reloaded.view, 'activity');
  assert.equal(reloaded.order, 'title');
  assert.equal(reloaded.limit, 10);
  const options: { attention: SessionAttentionKind | null; unread: boolean; settledAt?: number } = {
    attention: null,
    unread: false,
    settledAt: reloaded.settled[session.appSessionId],
  };
  assert.equal(sessionActivityStatus(session, options), 'settled');
  assert.equal(sessionActivityStatus({ ...session, streaming: true }, options), 'working');
  assert.equal(sessionActivityStatus(session, { ...options, attention: 'approval' }), 'approval');
  assert.equal(sessionActivityStatus(session, { ...options, attention: 'question' }), 'input');
  assert.equal(
    sessionActivityStatus({ ...session, updatedAt: 101 }, { ...options, unread: true }),
    'review',
  );
  assert.equal(sessionActivityStatus(session, { ...options, settledAt: undefined }), 'ready');
  assert.equal(matchesActivityFilter('approval', 'attention'), true);
  assert.equal(matchesActivityFilter('working', 'attention'), false);
  const newer = { ...session, appSessionId: 'newer-chat', updatedAt: 200 };
  assert.deepEqual(
    [session, newer]
      .sort((a, b) => compareSidebarSessions(a, b, 'recent'))
      .map((row) => row.appSessionId),
    ['newer-chat', 'older-chat'],
  );
});

test('name ordering uses displayed titles and a stable identity tie-break', () => {
  const a = { ...session, appSessionId: 'a', title: 'Zebra' };
  const b = { ...session, appSessionId: 'b', title: 'Original' };
  const metadata = { a: { displayTitle: 'Alpha' }, b: { displayTitle: 'Alpha' } };
  assert.deepEqual(
    [b, a]
      .sort((left, right) => compareSidebarSessions(left, right, 'title', metadata))
      .map((row) => row.appSessionId),
    ['a', 'b'],
  );
});

test('Ready is a valid filter and settlement excludes work awaiting a response', () => {
  assert.equal(isSidebarFilter('ready'), true);
  assert.equal(matchesActivityFilter('ready', 'ready'), true);
  assert.equal(matchesActivityFilter('review', 'ready'), false);
  for (const status of ['working', 'approval', 'input'] as const)
    assert.equal(canSettleSession(status), false);
  for (const status of ['ready', 'review', 'failed', 'settled'] as const)
    assert.equal(canSettleSession(status), true);
});

test('settled markers prune hidden and superseded sessions, preserve unloaded history, and stay bounded', () => {
  const settled = { unloaded: 5, archived: 5, deleted: 5, changed: 5, current: 100 };
  const result = pruneSettledSessions(
    settled,
    { changed: session, current: session },
    { archived: { archivedAt: 10 }, deleted: { deletedAt: 10 } },
  );
  assert.deepEqual(result, { current: 100, unloaded: 5 });
  assert.equal(pruneSettledSessions(result, {}, {}), result);
  const many = Object.fromEntries(Array.from({ length: 1002 }, (_, i) => [String(i), i]));
  const bounded = pruneSettledSessions(many, {}, {});
  assert.equal(Object.keys(bounded).length, 1000);
  assert.equal(bounded['0'], undefined);
  assert.equal(bounded['1001'], 1001);
});
