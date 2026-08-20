import assert from 'node:assert/strict';
import test from 'node:test';

import type { PullRequest } from '../../../types/vcs';
import { prChatSeed } from './prChatSeed';

const pr: PullRequest = {
  number: 42,
  title: 'Add the PR workspace',
  state: 'open',
  url: 'https://github.com/o/r/pull/42',
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
};

test('the chat seed types the pull request and its link, then leaves a blank line', () => {
  assert.equal(
    prChatSeed(pr),
    'Pull request #42: Add the PR workspace\nhttps://github.com/o/r/pull/42\n\n',
  );
});

test('a pull request without a title or url still seeds its number', () => {
  assert.equal(prChatSeed({ ...pr, title: '  ', url: '' }), 'Pull request #42\n\n');
});
