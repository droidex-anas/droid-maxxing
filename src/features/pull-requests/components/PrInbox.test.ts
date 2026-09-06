import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { PrInbox, prInboxEmptyCopy, shouldShowPrInboxEmpty } from './PrInbox';
import type { InboxPullRequest } from '../lib/prInbox';

function pr(
  partial: Partial<InboxPullRequest> & Pick<InboxPullRequest, 'number' | 'title' | 'cwd'>,
): InboxPullRequest {
  return {
    state: 'open',
    url: '',
    isDraft: false,
    headRefName: 'feat',
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
    repoName: partial.cwd.split('/').filter(Boolean).pop() ?? 'repo',
    ...partial,
  };
}

function renderInbox(overrides: Partial<Parameters<typeof PrInbox>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(PrInbox, {
      prs: [
        pr({ number: 12, title: 'App PR', cwd: '/repos/droid-control', additions: 8 }),
        pr({ number: 3, title: 'Site PR', cwd: '/repos/clinic' }),
      ],
      viewerLogin: 'ana',
      currentCwd: '/repos/droid-control',
      selectedCwd: '/repos/droid-control',
      selectedNumber: null,
      loading: false,
      error: null,
      repoErrors: [],
      backlogIds: new Set(),
      onSelect: () => undefined,
      onRetry: () => undefined,
      onToggleBacklog: () => undefined,
      ...overrides,
    }),
  );
}

test('an initial list failure does not also claim the repository is empty', () => {
  assert.equal(shouldShowPrInboxEmpty('Could not load pull requests', 0), false);
  assert.equal(shouldShowPrInboxEmpty(null, 0), true);
  assert.equal(shouldShowPrInboxEmpty(null, 2), false);
});

test('selected row shows the title, additions, and both branches', () => {
  const html = renderInbox({ selectedNumber: 12 });
  assert.match(html, /App PR/);
  assert.match(html, /\+8/);
  assert.match(html, /main ← feat/);
  assert.match(html, /aria-current="true"/);
});

test('an unselected row carries no current state', () => {
  const html = renderInbox({ selectedNumber: null });
  assert.doesNotMatch(html, /aria-current/);
});

test('empty All tab shows the repo empty sentence', () => {
  const html = renderInbox({ prs: [], selectedNumber: null });
  assert.match(html, /No open pull requests in this repo\./);
});

test('the filters are a labelled tab list and the search field names itself', () => {
  const html = renderInbox();
  assert.match(html, /role="tablist"/);
  assert.match(html, /aria-label="Pull request filters"/);
  assert.match(html, /role="tab" aria-selected="true"[^>]*>All</);
  assert.match(html, /role="tab" aria-selected="false"[^>]*>Reviewing</);
  assert.match(html, /role="tab" aria-selected="false"[^>]*>Backlog</);
  assert.match(html, /aria-label="Search pull requests"/);
  assert.match(html, /focus-visible:ring-2/);
});

test('a query with no matches uses search-specific empty copy', () => {
  assert.equal(prInboxEmptyCopy('all', 'missing'), 'No pull requests match your search.');
  assert.equal(prInboxEmptyCopy('authored', '   '), 'You have not opened any.');
  assert.equal(prInboxEmptyCopy('backlog', ''), 'Nothing in the backlog.');
  assert.equal(prInboxEmptyCopy('all', '', true), 'No open pull requests in these workspaces.');
});

test('the current workspace lists its pull requests without a group header', () => {
  const html = renderInbox();
  assert.match(html, /App PR/);
  assert.doesNotMatch(html, /Show droid-control pull requests/);
  assert.match(html, /Move to backlog/);
  assert.doesNotMatch(html, /Archive/);
});

test('other workspaces start collapsed until the group is opened', () => {
  const html = renderInbox();
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /Show clinic pull requests/);
  assert.doesNotMatch(html, /Site PR/);
});

test('an empty other workspace does not show a zero count', () => {
  const html = renderInbox({
    prs: [pr({ number: 12, title: 'App PR', cwd: '/repos/droid-control' })],
    repoErrors: [
      {
        cwd: '/repos/clinic',
        repoName: 'clinic',
        message: 'GitHub could not find clinic.',
      },
    ],
  });
  assert.match(html, /Show clinic pull requests/);
  assert.doesNotMatch(html, />0</);
});

test('selecting a pull request in another workspace expands that group', () => {
  const html = renderInbox({
    selectedCwd: '/repos/clinic',
    selectedNumber: 3,
  });
  assert.match(html, /Site PR/);
  assert.match(html, /aria-expanded="true"/);
});

test('a failed sibling repository stays collapsed without a GraphQL dump', () => {
  const html = renderInbox({
    repoErrors: [
      {
        cwd: '/repos/clinic',
        repoName: 'clinic',
        message: 'GitHub could not find evilfps/dr-koshley-skin-clinic.',
        reason: 'unresolved_repository',
      },
    ],
  });
  assert.match(html, /App PR/);
  assert.match(html, /Show clinic pull requests/);
  assert.doesNotMatch(html, /Site PR/);
  assert.doesNotMatch(html, /GraphQL/);
});
