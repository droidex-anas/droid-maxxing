import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { PrCheck, PrComment, PrCommit, PullRequest } from '../../../types/vcs';
import { PrSummary } from '../components/PrSummary';

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

const noop = () => undefined;

function renderSummary(
  overrides: {
    body?: string;
    checks?: PrCheck[];
    comments?: PrComment[];
    commits?: PrCommit[];
    commentsError?: string | null;
    checksError?: string | null;
    metaError?: string | null;
  } = {},
): string {
  return renderToStaticMarkup(
    createElement(PrSummary, {
      pr: samplePr,
      number: 1,
      body: overrides.body ?? '',
      loaded: true,
      loading: false,
      metaError: overrides.metaError ?? null,
      checks: overrides.checks ?? [],
      checksError: overrides.checksError ?? null,
      comments: overrides.comments ?? [],
      commentsError: overrides.commentsError ?? null,
      commits: overrides.commits ?? [],
      viewerLogin: 'ana',
      draft: '',
      posting: false,
      onDraftChange: noop,
      onSubmit: noop,
    }),
  );
}

test('renders review and inline comments as a GitHub-style conversation', () => {
  const html = renderSummary({
    comments: [
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
    ],
  });
  assert.match(html, /octocat/);
  assert.match(html, /approved these changes/);
  assert.match(html, /commented on a file/);
  assert.match(html, /src\/a\.ts:12/);
  assert.match(html, /Looks/);
  assert.match(html, /solid/);
  assert.match(html, /Please rename this\./);
  assert.match(html, /Leave a comment/);
});

test('all-fail first load surfaces checks and comments errors, not empty-state copy', () => {
  const html = renderSummary({
    metaError: 'Could not load pull request',
    checksError: 'Could not load PR checks',
    commentsError: 'Could not load PR comments',
  });
  assert.match(html, /Could not load PR checks/);
  assert.match(html, /Could not load PR comments/);
  assert.doesNotMatch(html, /No checks reported/);
  assert.doesNotMatch(html, /No comments yet/);
});

test('empty comments with an error show the error, not the empty-state copy', () => {
  const html = renderSummary({ commentsError: 'Could not load PR comments' });
  assert.match(html, /Could not load PR comments/);
  assert.doesNotMatch(html, /No comments yet/);
});

test('PR comments expose reactions next to the composer', () => {
  const html = renderSummary({
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
  });
  assert.match(html, /Looks good to me/);
  assert.match(html, /👍/);
  assert.match(html, /👀/);
  assert.match(html, />3</);
  assert.match(html, /Leave a comment/);
});

test('partial comment failures stay visible beside successfully loaded comments', () => {
  const html = renderSummary({
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
    commentsError: 'Some PR comments could not be loaded',
  });
  assert.match(html, /Some PR comments could not be loaded/);
  assert.match(html, /Loaded comment/);
});

test('a resolved inline comment folds behind its status and preview', () => {
  const html = renderSummary({
    comments: [
      {
        id: 'inline-1',
        kind: 'inline',
        author: 'dev',
        body: '## Naming\n\nPlease rename this helper.',
        createdAt: '2026-08-04T10:01:00Z',
        url: null,
        state: 'commented',
        reactions: [],
        path: 'src/a.ts',
        line: 12,
        resolved: true,
        outdated: false,
        resolvedBy: 'ana',
      },
    ],
  });
  assert.match(html, /Resolved/);
  assert.match(html, /Resolved by ana/);
  assert.match(html, /Expand comment/);
  // The preview stands in for the body until the card opens.
  assert.match(html, /a\.ts:12 · Naming/);
  assert.doesNotMatch(html, /Please rename this helper\./);
});

test('an outdated comment is labelled but stays expanded', () => {
  const html = renderSummary({
    comments: [
      {
        id: 'inline-1',
        kind: 'inline',
        author: 'dev',
        body: 'This moved.',
        createdAt: '2026-08-04T10:01:00Z',
        url: null,
        state: 'commented',
        reactions: [],
        path: 'src/a.ts',
        line: 12,
        resolved: false,
        outdated: true,
        resolvedBy: null,
      },
    ],
  });
  assert.match(html, /Outdated/);
  assert.match(html, /This moved\./);
  assert.doesNotMatch(html, /Expand comment/);
});

test('a long comment folds to its first line and offers to expand', () => {
  const body = ['A very long review follows.', ...Array.from({ length: 20 }, () => 'detail')].join(
    '\n',
  );
  const html = renderSummary({
    comments: [
      {
        id: 'comment-1',
        kind: 'comment',
        author: 'reviewer',
        body,
        createdAt: '2026-08-04T10:01:00Z',
        url: null,
        state: null,
        reactions: [],
      },
    ],
  });
  assert.match(html, /A very long review follows\./);
  assert.match(html, /Expand comment/);
  assert.doesNotMatch(html, /detail/);
});

test('the header states the rolled-up check state and the merge status', () => {
  const check = (name: string, bucket: PrCheck['bucket']): PrCheck => ({
    name,
    workflow: 'ci',
    bucket,
    state: bucket,
    description: '',
    link: null,
    startedAt: null,
    completedAt: null,
  });

  const passing = renderSummary({ checks: [check('build', 'pass'), check('lint', 'pass')] });
  assert.match(passing, /Checks/);
  assert.match(passing, /2\/2 passed/);
  assert.match(passing, /Status/);
  assert.match(passing, /Ready for review/);

  const failing = renderSummary({ checks: [check('build', 'fail'), check('lint', 'pass')] });
  assert.match(failing, /1 failing/);

  assert.match(renderSummary(), /No checks reported/);
  // A failed load must not read as a pull request without checks.
  const failed = renderSummary({ checksError: 'Could not load PR checks' });
  assert.match(failed, /Unavailable/);
  assert.doesNotMatch(failed, /No checks reported/);
});

test('a generated description renders as prose instead of raw HTML', () => {
  const html = renderSummary({
    body: `## Summary by cubic
Shows pasted images inline.

<sup>Written for commit 7387c06.</sup>

<a href="https://cubic.dev/pr/o/r/pull/114"><picture><img alt="Review in cubic" src="https://www.cubic.dev/buttons/review-in-cubic-dark.svg"></picture></a>

<!-- End of auto-generated description by cubic. -->`,
  });
  assert.match(html, /Summary by cubic/);
  assert.match(html, /Written for commit 7387c06\./);
  assert.doesNotMatch(html, /&lt;a href|&lt;picture|&lt;sup|&lt;!--/);
});

test('a bot review shows its findings and hides the agent prompt behind a disclosure', () => {
  const html = renderSummary({
    comments: [
      {
        id: 'comment-1',
        kind: 'comment',
        author: 'cubic-dev-ai[bot]',
        body: `<!-- cubic:review-summary:start -->
**1 issue found** across 4 files
<!-- cubic:review-summary:end -->
<details><summary>Prompt for AI agents</summary>

\`\`\`text
<file name="src/App.tsx">Fix it.</file>
\`\`\`
</details>
<sub>You're on the cubic free plan. [Upgrade](https://example.test)</sub>`,
        createdAt: '2026-08-04T10:01:00Z',
        url: null,
        state: null,
        reactions: [],
      },
    ],
  });
  assert.match(html, /1 issue found/);
  assert.match(html, /Prompt for AI agents/);
  assert.doesNotMatch(html, /cubic:review-summary|&lt;details|&lt;summary/);
  assert.doesNotMatch(html, /free plan/);
});

test('a short comment renders open with no fold affordance', () => {
  const html = renderSummary({
    comments: [
      {
        id: 'comment-1',
        kind: 'comment',
        author: 'reviewer',
        body: 'Ship it',
        createdAt: '2026-08-04T10:01:00Z',
        url: null,
        state: null,
        reactions: [],
      },
    ],
  });
  assert.match(html, /Ship it/);
  assert.doesNotMatch(html, /Expand comment/);
  assert.doesNotMatch(html, /Collapse comment/);
});

test('pushed commits appear in the timeline as one folded group', () => {
  const commits: PrCommit[] = [
    {
      oid: 'aaaaaaaaaaaaaaaa',
      headline: 'Add the inbox',
      committedDate: '2026-08-04T09:00:00Z',
      author: 'ana',
    },
    {
      oid: 'bbbbbbbbbbbbbbbb',
      headline: 'Polish the header',
      committedDate: '2026-08-04T09:30:00Z',
      author: 'ana',
    },
  ];
  const html = renderSummary({ commits });
  assert.match(html, /2 commits/);
  // Folded by default: the commit subjects stay hidden until the group opens.
  assert.doesNotMatch(html, /Add the inbox/);
  assert.doesNotMatch(html, /No comments yet/);
});

test('a single commit is shown outright with its short sha', () => {
  const html = renderSummary({
    commits: [
      {
        oid: 'cccccccdddddddd',
        headline: 'Fix the merge gate',
        committedDate: '2026-08-04T09:00:00Z',
        author: 'ana',
      },
    ],
  });
  assert.match(html, /1 commit/);
  assert.match(html, /Fix the merge gate/);
  assert.match(html, /ccccccc/);
});
