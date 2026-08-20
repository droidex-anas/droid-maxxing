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

test('the inbox row names both branches and marks the selected pull request', () => {
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
  assert.match(html, /main ← f/);
  assert.match(html, /aria-current="true"/);
});

test('an unselected row carries no current state', () => {
  const html = renderToStaticMarkup(
    createElement(PrInbox, {
      prs: [sample],
      viewerLogin: 'ana',
      selectedNumber: null,
      loading: false,
      error: null,
      onSelect: noop,
      onRetry: noop,
    }),
  );
  assert.doesNotMatch(html, /aria-current/);
});

test('the filters are a labelled tab list and the search field names itself', () => {
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
  assert.match(html, /role="tablist"/);
  assert.match(html, /aria-label="Pull request filters"/);
  assert.match(html, /role="tab" aria-selected="true"[^>]*>All</);
  assert.match(html, /role="tab" aria-selected="false"[^>]*>Reviewing</);
  assert.match(html, /aria-label="Search pull requests"/);
});
