import assert from 'node:assert/strict';
import test from 'node:test';

import type { PullRequest } from '../../../types/vcs';
import { mergeBlockReason } from './prMeta';

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
