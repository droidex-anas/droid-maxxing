import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { PrComment } from '../../../types/vcs';
import { PrConversation } from '../components/PrConversation';

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
