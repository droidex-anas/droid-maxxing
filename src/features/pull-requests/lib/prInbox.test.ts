import assert from 'node:assert/strict';
import test from 'node:test';
import {
  attachInboxRepoErrors,
  ensureCurrentInboxGroup,
  filterPullRequests,
  groupInboxPullRequests,
  inboxGroupIsExpanded,
  orderInboxGroups,
  searchPullRequests,
  selectedInboxPullRequest,
  type InboxPullRequest,
} from './prInbox';
import { prBacklogId } from './prBacklog';

function pr(
  partial: Partial<InboxPullRequest> & Pick<InboxPullRequest, 'number' | 'title'>,
): InboxPullRequest {
  return {
    state: 'open',
    url: '',
    isDraft: false,
    headRefName: 'feat',
    baseRefName: 'main',
    mergeable: null,
    reviewDecision: null,
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    createdAt: null,
    updatedAt: null,
    author: 'ana',
    reviewRequests: [],
    reviews: [],
    cwd: '/repo',
    repoName: 'repo',
    ...partial,
  };
}

const rows = [
  pr({ number: 1, title: 'Inbox', author: 'ana', reviewRequests: ['octocat'] }),
  pr({
    number: 2,
    title: 'Diff view',
    author: 'dev',
    reviews: [{ author: 'octocat', state: 'commented' }],
  }),
  pr({ number: 3, title: 'Other', author: 'dev' }),
];

test('all returns every row', () => {
  assert.deepEqual(
    filterPullRequests(rows, 'all', 'octocat').map((item) => item.number),
    [1, 2, 3],
  );
});

test('reviewing is requested or already reviewed by the viewer', () => {
  assert.deepEqual(
    filterPullRequests(rows, 'reviewing', 'octocat').map((item) => item.number),
    [1, 2],
  );
});

test('authored matches the viewer login case-insensitively', () => {
  assert.deepEqual(
    filterPullRequests(rows, 'authored', 'ANA').map((item) => item.number),
    [1],
  );
});

test('empty viewer makes reviewing and authored empty, not all', () => {
  assert.deepEqual(filterPullRequests(rows, 'reviewing', null), []);
  assert.deepEqual(filterPullRequests(rows, 'authored', ''), []);
  assert.equal(filterPullRequests(rows, 'all', null).length, 3);
});

test('search matches title, number, author, branch, and repo name', () => {
  assert.equal(searchPullRequests(rows, '#2')[0].number, 2);
  assert.equal(searchPullRequests(rows, 'inbox')[0].number, 1);
  assert.equal(searchPullRequests(rows, 'dev').length, 2);
  assert.equal(searchPullRequests(rows, 'feat').length, 3);
  assert.deepEqual(searchPullRequests(rows, '   '), rows);
  assert.equal(
    searchPullRequests([pr({ number: 4, title: 'Clinic', repoName: 'dr-koshley' })], 'koshley')
      .length,
    1,
  );
});

test('a hash with no number is not a filter', () => {
  assert.deepEqual(searchPullRequests(rows, '#'), rows);
  assert.deepEqual(searchPullRequests(rows, '#  '), rows);
  assert.deepEqual(
    searchPullRequests(rows, '# 3').map((item) => item.number),
    [3],
  );
});

// Logins are ASCII, so matching is plain case folding: collation rules that
// treat a ligature as the letters it resembles are not login equality.
test('login matching folds ASCII case only, not collation equivalences', () => {
  const row = pr({ number: 4, title: 'Login', author: 'Droidex-Anas', reviewRequests: ['Ana'] });
  assert.deepEqual(filterPullRequests([row], 'authored', 'DROIDEX-ANAS'), [row]);
  assert.deepEqual(filterPullRequests([row], 'reviewing', 'aNa'), [row]);
  assert.equal(
    filterPullRequests(
      [pr({ number: 5, title: 'Ligature', author: 'ﬀactory' })],
      'authored',
      'ffactory',
    ).length,
    0,
  );
});

test('backlog rows leave All, Reviewing, and Authored', () => {
  const ids = new Set([prBacklogId(rows[2])]);
  assert.deepEqual(
    filterPullRequests(rows, 'all', 'octocat', ids).map((item) => item.number),
    [1, 2],
  );
  assert.deepEqual(
    filterPullRequests(rows, 'reviewing', 'octocat', ids).map((item) => item.number),
    [1, 2],
  );
  assert.deepEqual(
    filterPullRequests(rows, 'backlog', 'octocat', ids).map((item) => item.number),
    [3],
  );
});

test('groupInboxPullRequests keeps repository order and path identity', () => {
  const grouped = groupInboxPullRequests([
    pr({ number: 1, title: 'A', cwd: '/repo/app', repoName: 'app' }),
    pr({ number: 2, title: 'B', cwd: '/repo/site', repoName: 'site' }),
    pr({ number: 3, title: 'C', cwd: '/repo/app', repoName: 'app' }),
  ]);
  assert.deepEqual(
    grouped.map((group) => [group.repoName, group.prs.map((item) => item.number)]),
    [
      ['app', [1, 3]],
      ['site', [2]],
    ],
  );
});

test('selectedInboxPullRequest matches repository and number together', () => {
  const listed = [
    pr({ number: 1, title: 'A', cwd: '/repo/app' }),
    pr({ number: 1, title: 'B', cwd: '/repo/site' }),
  ];
  assert.equal(selectedInboxPullRequest(listed, '/repo/site', 1)?.title, 'B');
  assert.equal(selectedInboxPullRequest(listed, '/missing', 1), null);
});

test('orderInboxGroups pins the current workspace above the others', () => {
  const grouped = groupInboxPullRequests([
    pr({ number: 1, title: 'A', cwd: '/site', repoName: 'site' }),
    pr({ number: 2, title: 'B', cwd: '/app', repoName: 'app' }),
  ]);
  assert.deepEqual(
    orderInboxGroups(grouped, '/app').map((group) => group.repoName),
    ['app', 'site'],
  );
});

test('attachInboxRepoErrors keeps a workspace that failed to list', () => {
  const grouped = attachInboxRepoErrors(
    groupInboxPullRequests([pr({ number: 1, title: 'A', cwd: '/app', repoName: 'app' })]),
    [{ cwd: '/clinic', repoName: 'clinic' }],
  );
  assert.deepEqual(
    grouped.map((group) => [group.repoName, group.prs.length]),
    [
      ['app', 1],
      ['clinic', 0],
    ],
  );
});

test('ensureCurrentInboxGroup inserts an empty current repository when listing missed it', () => {
  const grouped = ensureCurrentInboxGroup(
    groupInboxPullRequests([pr({ number: 1, title: 'A', cwd: '/site', repoName: 'site' })]),
    '/app',
    'app',
  );
  assert.deepEqual(
    grouped.map((group) => [group.repoName, group.prs.length]),
    [
      ['app', 0],
      ['site', 1],
    ],
  );
});

test('inboxGroupIsExpanded keeps the current repo open and others closed', () => {
  assert.equal(
    inboxGroupIsExpanded({
      cwd: '/app',
      currentCwd: '/app',
      expandedOther: new Set(),
      searching: false,
      selectedCwd: '/app',
    }),
    true,
  );
  assert.equal(
    inboxGroupIsExpanded({
      cwd: '/site',
      currentCwd: '/app',
      expandedOther: new Set(),
      searching: false,
      selectedCwd: '/app',
    }),
    false,
  );
  assert.equal(
    inboxGroupIsExpanded({
      cwd: '/site',
      currentCwd: '/app',
      expandedOther: new Set(),
      searching: false,
      selectedCwd: '/site',
    }),
    true,
  );
  assert.equal(
    inboxGroupIsExpanded({
      cwd: '/site',
      currentCwd: '/app',
      expandedOther: new Set(),
      searching: true,
      selectedCwd: '/app',
    }),
    true,
  );
});
