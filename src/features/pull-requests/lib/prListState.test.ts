import assert from 'node:assert/strict';
import test from 'node:test';
import { initialPrListState, reducePrList } from './prListState';
import type { PullRequest } from '../../../types/vcs';

const sample: PullRequest = {
  number: 1,
  title: 'A',
  state: 'open',
  url: '',
  isDraft: false,
  headRefName: 'f',
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
};

test('bind increments generation and drops rows', () => {
  const loaded = reducePrList(initialPrListState, {
    type: 'load-success',
    generation: 0,
    prs: [sample],
    viewerLogin: 'ana',
  });
  const bound = reducePrList(loaded, { type: 'bind', cwd: '/other' });
  assert.equal(bound.prs.length, 0);
  assert.equal(bound.generation, 1);
  assert.equal(bound.loaded, false);
});

test('stale success is ignored and a failed load keeps last rows', () => {
  const start = reducePrList(initialPrListState, { type: 'load-start', generation: 1 });
  const stale = reducePrList(start, {
    type: 'load-success',
    generation: 0,
    prs: [sample],
    viewerLogin: 'ana',
  });
  assert.equal(stale.prs.length, 0);
  const ok = reducePrList(start, {
    type: 'load-success',
    generation: 1,
    prs: [sample],
    viewerLogin: 'ana',
  });
  const failed = reducePrList(ok, { type: 'load-failure', generation: 1, message: 'down' });
  assert.equal(failed.prs[0].number, 1);
  assert.equal(failed.error, 'down');
});
