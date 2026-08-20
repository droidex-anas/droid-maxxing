import assert from 'node:assert/strict';
import test from 'node:test';
import { filterPullRequests, searchPullRequests } from './prInbox';
import type { PullRequest } from '../../../types/vcs';

function pr(partial: Partial<PullRequest> & Pick<PullRequest, 'number' | 'title'>): PullRequest {
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

test('search matches title, number, author, and branch', () => {
  assert.equal(searchPullRequests(rows, '#2')[0].number, 2);
  assert.equal(searchPullRequests(rows, 'inbox')[0].number, 1);
  assert.equal(searchPullRequests(rows, 'dev').length, 2);
  assert.equal(searchPullRequests(rows, 'feat').length, 3);
  assert.deepEqual(searchPullRequests(rows, '   '), rows);
});

test('a hash with no number is not a filter', () => {
  assert.deepEqual(searchPullRequests(rows, '#'), rows);
  assert.deepEqual(searchPullRequests(rows, '#  '), rows);
  assert.deepEqual(
    searchPullRequests(rows, '# 3').map((item) => item.number),
    [3],
  );
});
