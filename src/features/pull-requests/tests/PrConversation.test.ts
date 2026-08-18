import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { PrComment, PullRequest } from '../../../types/vcs';
import { PrConversation } from '../components/PrConversation';
import { PrSummary } from '../components/PrSummary';

const comments: PrComment[] = [
  {
    id: 'review-1',
    kind: 'review',
    author: 'octocat',
    body: 'Looks **solid**.',
    createdAt: '2026-08-04T10:00:00Z',
    url: null,
    state: 'approved',
    reactions: [],
  },
  {
    id: 'inline-1',
    kind: 'inline',
    author: 'dev',
    body: 'Please rename this.',
    createdAt: '2026-08-04T10:01:00Z',
    url: null,
    state: 'commented',
    reactions: [],
    path: 'src/a.ts',
    line: 12,
  },
];

const noop = () => undefined;

test('renders review and inline comments as an unbordered timeline', () => {
  const html = renderToStaticMarkup(
    createElement(PrConversation, {
      comments,
      loading: false,
      error: null,
      draft: '',
      posting: false,
      onDraftChange: noop,
      onSubmit: noop,
    }),
  );
  assert.match(html, /octocat/);
  assert.match(html, /approved/);
  assert.match(html, /commented/);
  assert.match(html, /src\/a\.ts:12/);
  assert.match(html, /Looks/);
  assert.match(html, /solid/);
  assert.match(html, /Please rename this\./);
  assert.match(html, /Comment on this PR…/);
  assert.doesNotMatch(html, /border-droid-border/);
});

const samplePr: PullRequest = {
  number: 1,
  title: 'Ship it',
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

test('all-fail first load surfaces checks and comments errors, not empty-state copy', () => {
  const html = renderToStaticMarkup(
    createElement(PrSummary, {
      pr: samplePr,
      number: 1,
      body: '',
      loaded: true,
      loading: false,
      metaError: 'Could not load pull request',
      checks: [],
      checksError: 'Could not load PR checks',
      comments: [],
      commentsError: 'Could not load PR comments',
      draft: '',
      posting: false,
      onDraftChange: noop,
      onSubmit: noop,
    }),
  );
  assert.match(html, /Could not load PR checks/);
  assert.match(html, /Could not load PR comments/);
  assert.doesNotMatch(html, /No checks reported/);
  assert.doesNotMatch(html, /No comments yet/);
});

test('empty comments with an error show the error, not the empty-state copy', () => {
  const html = renderToStaticMarkup(
    createElement(PrConversation, {
      comments: [],
      loading: false,
      error: 'Could not load PR comments',
      draft: '',
      posting: false,
      onDraftChange: noop,
      onSubmit: noop,
    }),
  );
  assert.match(html, /Could not load PR comments/);
  assert.doesNotMatch(html, /No comments yet/);
});

test('PR comments expose reactions next to the composer', () => {
  const html = renderToStaticMarkup(
    createElement(PrConversation, {
      comments: [
        {
          id: 'comment-1',
          kind: 'comment',
          author: 'reviewer',
          body: 'Looks good to me',
          createdAt: '2026-08-04T10:01:00Z',
          url: 'https://example.test/comment/1',
          state: null,
          reactions: [
            { content: 'THUMBS_UP', count: 3 },
            { content: 'EYES', count: 1 },
          ],
        },
      ],
      loading: false,
      error: null,
      draft: '',
      posting: false,
      onDraftChange: noop,
      onSubmit: noop,
    }),
  );

  assert.match(html, /Looks good to me/);
  assert.match(html, /👍/);
  assert.match(html, /👀/);
  assert.match(html, />3</);
  assert.match(html, /Comment on this PR…/);
});

test('partial comment failures stay visible beside successfully loaded comments', () => {
  const html = renderToStaticMarkup(
    createElement(PrConversation, {
      comments: [
        {
          id: 'comment-1',
          kind: 'comment',
          author: 'reviewer',
          body: 'Loaded comment',
          createdAt: '2026-08-04T10:01:00Z',
          url: 'https://example.test/comment/1',
          state: null,
          reactions: [],
        },
      ],
      loading: false,
      error: 'Some PR comments could not be loaded',
      draft: '',
      posting: false,
      onDraftChange: noop,
      onSubmit: noop,
    }),
  );

  assert.match(html, /Some PR comments could not be loaded/);
  assert.match(html, /Loaded comment/);
});
