import assert from 'node:assert/strict';
import test from 'node:test';

import type { PrCheck, PullRequest } from '../../../types/vcs';
import { checksSummary } from '../../../lib/github';
import { checksBadge, mergeBlockReason, reviewerRows } from './prMeta';

const pr = (overrides: Partial<PullRequest> = {}): PullRequest => ({
  number: 7,
  title: 'Ship it',
  state: 'open',
  url: 'https://github.com/o/r/pull/7',
  isDraft: false,
  headRefName: 'feature',
  baseRefName: 'main',
  mergeable: 'mergeable',
  reviewDecision: null,
  additions: 1,
  deletions: 0,
  changedFiles: 1,
  createdAt: null,
  updatedAt: null,
  author: 'ana',
  reviewRequests: [],
  reviews: [],
  ...overrides,
});

const check = (bucket: string): PrCheck => ({
  name: bucket,
  workflow: null,
  bucket,
  state: '',
  description: '',
  link: null,
  startedAt: null,
  completedAt: null,
});

test('a mergeable pull request is not blocked', () => {
  assert.equal(mergeBlockReason(pr()), null);
});

test('drafts and conflicting branches block the merge with a reason', () => {
  assert.match(mergeBlockReason(pr({ isDraft: true })) ?? '', /ready for review/);
  assert.match(mergeBlockReason(pr({ mergeable: 'conflicting' })) ?? '', /conflicts/);
});

// Branch protection is invisible to `gh pr view`, so a requested-changes review
// or an unknown mergeability must not disable the button locally; gh reports
// GitHub's own refusal instead.
test('review state and unknown mergeability leave the merge to gh', () => {
  assert.equal(mergeBlockReason(pr({ reviewDecision: 'changes_requested' })), null);
  assert.equal(mergeBlockReason(pr({ mergeable: null })), null);
});

test('checks that all skipped are neutral, not a green run', () => {
  assert.deepEqual(checksBadge(checksSummary(['skipping', 'skipping', 'skipping'].map(check))), {
    label: '3 skipped',
    tone: 'neutral',
  });
  assert.deepEqual(checksBadge(checksSummary(['pass', 'pass', 'pass'].map(check))), {
    label: '3/3 passed',
    tone: 'success',
  });
  assert.equal(checksBadge(checksSummary([])), null);
});

test('a run that passed some and skipped some is partial, not green', () => {
  assert.deepEqual(checksBadge(checksSummary(['pass', 'skipping', 'skipping'].map(check))), {
    label: '1/3 passed',
    tone: 'neutral',
  });
  assert.deepEqual(checksBadge(checksSummary(['pass', 'pass', 'pass'].map(check))), {
    label: '3/3 passed',
    tone: 'success',
  });
});

test('neutral and unknown checks are labelled honestly', () => {
  assert.deepEqual(checksBadge(checksSummary(['neutral', 'neutral'].map(check))), {
    label: '2 neutral',
    tone: 'neutral',
  });
  assert.deepEqual(checksBadge(checksSummary(['mystery'].map(check))), {
    label: '1 unknown',
    tone: 'neutral',
  });
});

test('pending reviews stay pending and current requests override old reviews', () => {
  assert.deepEqual(
    reviewerRows(
      pr({
        reviews: [
          { author: 'ana', state: 'pending' },
          { author: 'rae', state: 'approved' },
        ],
        reviewRequests: ['rae'],
      }),
    ),
    [
      { login: 'ana', state: 'pending' },
      { login: 'rae', state: 'pending' },
    ],
  );
});
