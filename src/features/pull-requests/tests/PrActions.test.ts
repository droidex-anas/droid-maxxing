import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { PullRequest } from '../../../types/vcs';
import { PrMergeButton, mergeButtonTitle, mergePullRequestKey } from '../components/PrMergeButton';
import { PrReviewButton } from '../components/PrReviewButton';

const pr: PullRequest = {
  number: 1,
  title: 'Ship it',
  state: 'open',
  url: 'https://github.com/acme/repo/pull/1',
  isDraft: false,
  headRefName: 'feature',
  baseRefName: 'main',
  mergeable: 'MERGEABLE',
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

test('merge tooltip describes blocked, merging, and merged states', () => {
  assert.equal(mergeButtonTitle('Checks are failing', false, false), 'Checks are failing');
  assert.equal(mergeButtonTitle(null, true, false), 'Merging pull request');
  assert.equal(mergeButtonTitle(null, false, true), 'Pull request merged');
});

test('merge and review dropdown triggers expose menu state', () => {
  const mergeHtml = renderToStaticMarkup(
    createElement(PrMergeButton, {
      pr,
      repositoryKey: '/repo',
      merging: false,
      onMerge: async () => true,
    }),
  );
  assert.match(mergeHtml, /aria-haspopup="menu"/);
  assert.match(mergeHtml, /aria-expanded="false"/);

  const reviewHtml = renderToStaticMarkup(
    createElement(PrReviewButton, {
      pr,
      cubicInstalled: true,
      requesting: false,
      onRunCubicReview: () => undefined,
      onReviewWithDroid: () => undefined,
    }),
  );
  assert.match(reviewHtml, /aria-haspopup="menu"/);
  assert.match(reviewHtml, /aria-expanded="false"/);
});

test('URL-less pull requests are keyed by repository and number', () => {
  const withoutUrl = { ...pr, url: '' };
  assert.equal(mergePullRequestKey(withoutUrl, '/repo-a'), '/repo-a#1');
  assert.equal(mergePullRequestKey(withoutUrl, '/repo-b'), '/repo-b#1');
});
