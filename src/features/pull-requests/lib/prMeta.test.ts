import assert from 'node:assert/strict';
import test from 'node:test';

import type { PullRequest } from '../../../types/vcs';
import { checksBadge, mergeBlockReason } from './prMeta';

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
  assert.deepEqual(checksBadge({ total: 3, pass: 0, fail: 0, pending: 0, status: 'neutral' }), {
    label: '3 skipped',
    tone: 'neutral',
  });
  assert.deepEqual(checksBadge({ total: 3, pass: 3, fail: 0, pending: 0, status: 'success' }), {
    label: '3/3 passed',
    tone: 'success',
  });
  assert.equal(checksBadge({ total: 0, pass: 0, fail: 0, pending: 0, status: 'none' }), null);
});

test('a run that passed some and skipped some is partial, not green', () => {
  // The summary marks any run with a passing check 'success', so the badge has
  // to account for the skipped checks itself.
  assert.deepEqual(checksBadge({ total: 3, pass: 1, fail: 0, pending: 0, status: 'success' }), {
    label: '1/3 passed',
    tone: 'neutral',
  });
  assert.deepEqual(checksBadge({ total: 3, pass: 3, fail: 0, pending: 0, status: 'success' }), {
    label: '3/3 passed',
    tone: 'success',
  });
});
