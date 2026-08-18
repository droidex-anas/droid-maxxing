import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { PullRequest } from '../../../types/vcs';
import { PrInbox } from '../components/PrInbox';

const sample: PullRequest = {
  number: 1,
  title: 'Ship the inbox',
  state: 'open',
  url: '',
  isDraft: false,
  headRefName: 'f',
  baseRefName: 'main',
  mergeable: null,
  reviewDecision: null,
  additions: 8,
  deletions: 0,
  changedFiles: 1,
  createdAt: null,
  updatedAt: null,
  author: 'ana',
  reviewRequests: [],
  reviews: [],
};

const noop = () => undefined;

test('selected row shows the title and additions', () => {
  const html = renderToStaticMarkup(
    createElement(PrInbox, {
      prs: [sample],
      viewerLogin: 'ana',
      selectedNumber: 1,
      loading: false,
      error: null,
      onSelect: noop,
      onRetry: noop,
    }),
  );
  assert.match(html, /Ship the inbox/);
  assert.match(html, /\+8/);
});

test('empty All tab shows the repo empty sentence', () => {
  const html = renderToStaticMarkup(
    createElement(PrInbox, {
      prs: [],
      viewerLogin: null,
      selectedNumber: null,
      loading: false,
      error: null,
      onSelect: noop,
      onRetry: noop,
    }),
  );
  assert.match(html, /No open pull requests in this repo\./);
});
