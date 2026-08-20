const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizePrComments,
  normalizeReviewThreadPage,
  prComments,
} = require('./githubPrConversation.cjs');

const ghResult = (overrides = {}) => ({
  code: 0,
  stdout: '',
  stderr: '',
  spawnFailed: false,
  ...overrides,
});

test('PR comments include top-level, review, and inline review threads', () => {
  const comments = normalizePrComments(
    {
      comments: [
        {
          databaseId: 10,
          author: { login: 'author' },
          body: 'Top-level **comment**',
          createdAt: '2026-08-04T10:00:00Z',
          url: 'https://example.test/comment/10',
          reactionGroups: [{ content: 'EYES', users: { totalCount: 2 } }],
        },
      ],
      reviews: [
        {
          id: 'review-20',
          author: { login: 'reviewer' },
          body: 'Changes requested',
          submittedAt: '2026-08-04T10:01:00Z',
          state: 'CHANGES_REQUESTED',
          reactionGroups: [{ content: 'THUMBS_UP', users: { totalCount: 1 } }],
        },
      ],
    },
    [
      {
        id: 30,
        user: { login: 'inline-reviewer' },
        body: 'Fix `scope` here',
        created_at: '2026-08-04T10:02:00Z',
        html_url: 'https://example.test/review/30',
        path: 'src/components/ReviewPanel.tsx',
        line: 42,
        diff_hunk: '@@ -40,2 +40,3 @@',
        reactions: { '+1': 3, heart: 1, total_count: 4 },
      },
    ],
  );

  assert.deepEqual(
    comments.map(({ kind, author, body, path, line, reactions }) => ({
      kind,
      author,
      body,
      path,
      line,
      reactions,
    })),
    [
      {
        kind: 'comment',
        author: 'author',
        body: 'Top-level **comment**',
        path: undefined,
        line: undefined,
        reactions: [{ content: 'EYES', count: 2 }],
      },
      {
        kind: 'review',
        author: 'reviewer',
        body: 'Changes requested',
        path: undefined,
        line: undefined,
        reactions: [{ content: 'THUMBS_UP', count: 1 }],
      },
      {
        kind: 'inline',
        author: 'inline-reviewer',
        body: 'Fix `scope` here',
        path: 'src/components/ReviewPanel.tsx',
        line: 42,
        reactions: [
          { content: 'THUMBS_UP', count: 3 },
          { content: 'HEART', count: 1 },
        ],
      },
    ],
  );
});

test('PR comment normalization excludes malformed rows', () => {
  const comments = normalizePrComments(
    {
      comments: [
        null,
        { databaseId: 10, author: { login: 'author' }, body: 'top level' },
        'not a comment',
      ],
      reviews: [
        42,
        { databaseId: 20, author: { login: 'reviewer' }, body: 'review', state: 'COMMENTED' },
      ],
    },
    [
      undefined,
      { id: 30, user: { login: 'inline-reviewer' }, body: 'inline' },
      ['not an inline comment'],
    ],
  );

  assert.deepEqual(
    comments.map(({ kind, author, body }) => ({ kind, author, body })),
    [
      { kind: 'comment', author: 'author', body: 'top level' },
      { kind: 'review', author: 'reviewer', body: 'review' },
      { kind: 'inline', author: 'inline-reviewer', body: 'inline' },
    ],
  );
});

test('PR comments report malformed rows as partial while keeping valid rows', async () => {
  const result = await prComments('/repo', { prNumber: 79 }, async (_dir, args) => {
    if (args[0] === 'pr') {
      return ghResult({
        stdout: JSON.stringify({
          comments: [null, { databaseId: 10, author: { login: 'author' }, body: 'top level' }],
          reviews: [{ databaseId: 20, author: { login: 'reviewer' }, body: 'review' }, 42],
        }),
      });
    }
    if (args[1] === 'graphql')
      return ghResult({
        stdout: JSON.stringify({
          data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } },
        }),
      });
    return ghResult({
      stdout: JSON.stringify([
        [undefined, { id: 30, user: { login: 'inline-reviewer' }, body: 'inline' }],
      ]),
    });
  });

  assert.equal(result.ok, true);
  assert.equal(result.partial, true);
  assert.match(result.message, /1 malformed PR conversation comment/);
  assert.match(result.message, /1 malformed PR review/);
  assert.match(result.message, /1 malformed inline review comment/);
  assert.deepEqual(
    result.comments.map(({ kind, body }) => ({ kind, body })),
    [
      { kind: 'comment', body: 'top level' },
      { kind: 'review', body: 'review' },
      { kind: 'inline', body: 'inline' },
    ],
  );
});

test('PR comments keep conversation comments when inline pagination fails', async () => {
  const result = await prComments('/repo', { prNumber: 79 }, async (_dir, args) => {
    if (args[0] === 'pr') {
      return ghResult({
        stdout: JSON.stringify({
          comments: [{ databaseId: 10, author: { login: 'author' }, body: 'available' }],
          reviews: [],
        }),
      });
    }
    return ghResult({ code: 1, stderr: 'REST rate limited' });
  });

  assert.equal(result.ok, true);
  assert.equal(result.partial, true);
  assert.match(result.message, /REST rate limited/);
  assert.deepEqual(
    result.comments.map((comment) => comment.body),
    ['available'],
  );
});

test('PR comments keep inline comments when conversation lookup fails', async () => {
  const result = await prComments('/repo', { prNumber: 79 }, async (_dir, args) => {
    if (args[0] === 'pr') return ghResult({ code: 1, stderr: 'GraphQL unavailable' });
    if (args[1] === 'graphql') return ghResult({ stdout: '{}' });
    return ghResult({
      stdout: JSON.stringify([
        [
          {
            id: 30,
            user: { login: 'reviewer' },
            body: 'inline available',
            path: 'src/file.ts',
            line: 4,
          },
        ],
      ]),
    });
  });

  assert.equal(result.ok, true);
  assert.equal(result.partial, true);
  assert.match(result.message, /GraphQL unavailable/);
  assert.deepEqual(
    result.comments.map((comment) => comment.body),
    ['inline available'],
  );
});

test('inline comments carry the resolved verdict of their review thread', async () => {
  const inlineRows = [
    [
      { id: 30, user: { login: 'reviewer' }, body: 'first', path: 'a.ts', line: 1 },
      { id: 31, user: { login: 'reviewer' }, body: 'reply in the same thread' },
      { id: 32, user: { login: 'reviewer' }, body: 'still open', path: 'b.ts', line: 2 },
    ],
  ];
  const threads = {
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [
              {
                isResolved: true,
                isOutdated: true,
                resolvedBy: { login: 'ana' },
                comments: { nodes: [{ databaseId: 30 }, { databaseId: 31 }] },
              },
              {
                isResolved: false,
                isOutdated: false,
                resolvedBy: null,
                comments: { nodes: [{ databaseId: 32 }] },
              },
            ],
          },
        },
      },
    },
  };
  const calls = [];
  const result = await prComments('/repo', { prNumber: 79 }, async (_dir, args) => {
    calls.push(args);
    if (args[0] === 'pr')
      return ghResult({ stdout: JSON.stringify({ comments: [], reviews: [] }) });
    if (args[1] === 'graphql') return ghResult({ stdout: JSON.stringify(threads) });
    return ghResult({ stdout: JSON.stringify(inlineRows) });
  });

  assert.equal(result.ok, true);
  assert.equal(result.partial, undefined);
  assert.deepEqual(
    result.comments.map(({ body, resolved, outdated, resolvedBy }) => ({
      body,
      resolved,
      outdated,
      resolvedBy,
    })),
    [
      { body: 'first', resolved: true, outdated: true, resolvedBy: 'ana' },
      { body: 'reply in the same thread', resolved: true, outdated: true, resolvedBy: 'ana' },
      { body: 'still open', resolved: false, outdated: false, resolvedBy: null },
    ],
  );
  const graphql = calls.find((args) => args[1] === 'graphql');
  assert.deepEqual(graphql.slice(2, 8), [
    '-F',
    'owner={owner}',
    '-F',
    'repo={repo}',
    '-F',
    'number=79',
  ]);
  assert.match(graphql.at(-1), /reviewThreads/);
});

test('a failed thread lookup reports itself and leaves the comments unresolved', async () => {
  const result = await prComments('/repo', { prNumber: 79 }, async (_dir, args) => {
    if (args[0] === 'pr')
      return ghResult({ stdout: JSON.stringify({ comments: [], reviews: [] }) });
    if (args[1] === 'graphql') return ghResult({ code: 1, stderr: 'graphql rate limited\n' });
    return ghResult({
      stdout: JSON.stringify([[{ id: 30, user: { login: 'reviewer' }, body: 'inline' }]]),
    });
  });

  assert.equal(result.ok, true);
  assert.equal(result.partial, true);
  assert.match(result.message, /graphql rate limited/);
  assert.deepEqual(
    result.comments.map(({ resolved, outdated, resolvedBy }) => ({
      resolved,
      outdated,
      resolvedBy,
    })),
    [{ resolved: false, outdated: false, resolvedBy: null }],
  );
});

test('a failed thread lookup stays quiet when there are no inline comments', async () => {
  const result = await prComments('/repo', { prNumber: 79 }, async (_dir, args) => {
    if (args[0] === 'pr') {
      return ghResult({
        stdout: JSON.stringify({
          comments: [{ databaseId: 10, author: { login: 'author' }, body: 'top level' }],
          reviews: [],
        }),
      });
    }
    if (args[1] === 'graphql') return ghResult({ code: 1, stderr: 'graphql rate limited' });
    return ghResult({ stdout: '[]' });
  });

  assert.equal(result.ok, true);
  assert.equal(result.partial, undefined);
  assert.equal(result.message, undefined);
});

test('review threads without comment ids are ignored instead of throwing', () => {
  const page = normalizeReviewThreadPage({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: { nodes: [{ isResolved: true, comments: { nodes: [{}] } }, null] },
        },
      },
    },
  });
  assert.equal(page.statusByCommentId.size, 0);
  assert.deepEqual(page.pagedThreads, []);
  assert.equal(page.nextCursor, null);
  assert.equal(normalizeReviewThreadPage(null).statusByCommentId.size, 0);
});

const inlineRowsPayload = (ids) =>
  JSON.stringify([ids.map((id) => ({ id, user: { login: 'reviewer' }, body: `comment ${id}` }))]);

const graphqlQuery = (args) => String(args.at(-1) || '');
const graphqlCursor = (args) => {
  const index = args.findIndex((arg) => String(arg).startsWith('cursor='));
  return index === -1 ? null : String(args[index]).slice('cursor='.length);
};

test('review thread status follows both thread and reply pagination', async () => {
  const threadPages = {
    null: {
      pageInfo: { hasNextPage: true, endCursor: 'THREAD_CURSOR' },
      nodes: [
        {
          id: 'THREAD_A',
          isResolved: true,
          isOutdated: false,
          resolvedBy: { login: 'ana' },
          comments: {
            pageInfo: { hasNextPage: true, endCursor: 'REPLY_CURSOR' },
            nodes: [{ databaseId: 30 }],
          },
        },
      ],
    },
    THREAD_CURSOR: {
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [
        {
          id: 'THREAD_B',
          isResolved: false,
          isOutdated: false,
          resolvedBy: null,
          comments: { pageInfo: { hasNextPage: false }, nodes: [{ databaseId: 32 }] },
        },
      ],
    },
  };
  const cursors = [];
  const result = await prComments('/repo', { prNumber: 79 }, async (_dir, args) => {
    if (args[0] === 'pr')
      return ghResult({ stdout: JSON.stringify({ comments: [], reviews: [] }) });
    if (args[1] !== 'graphql') return ghResult({ stdout: inlineRowsPayload([30, 31, 32]) });
    const cursor = graphqlCursor(args);
    if (/reviewThreads/.test(graphqlQuery(args))) {
      cursors.push(['threads', cursor]);
      return ghResult({
        stdout: JSON.stringify({
          data: { repository: { pullRequest: { reviewThreads: threadPages[String(cursor)] } } },
        }),
      });
    }
    cursors.push(['replies', cursor]);
    assert.ok(args.includes('id=THREAD_A'));
    return ghResult({
      stdout: JSON.stringify({
        data: {
          node: { comments: { pageInfo: { hasNextPage: false }, nodes: [{ databaseId: 31 }] } },
        },
      }),
    });
  });

  assert.equal(result.ok, true);
  assert.equal(result.partial, undefined);
  assert.deepEqual(cursors, [
    ['threads', null],
    ['threads', 'THREAD_CURSOR'],
    ['replies', 'REPLY_CURSOR'],
  ]);
  assert.deepEqual(
    result.comments.map(({ body, resolved, resolvedBy }) => ({ body, resolved, resolvedBy })),
    [
      { body: 'comment 30', resolved: true, resolvedBy: 'ana' },
      { body: 'comment 31', resolved: true, resolvedBy: 'ana' },
      { body: 'comment 32', resolved: false, resolvedBy: null },
    ],
  );
});

test('an unbounded review thread list reports truncation instead of a wrong status', async () => {
  let threadPageCount = 0;
  const result = await prComments('/repo', { prNumber: 79 }, async (_dir, args) => {
    if (args[0] === 'pr')
      return ghResult({ stdout: JSON.stringify({ comments: [], reviews: [] }) });
    if (args[1] !== 'graphql') return ghResult({ stdout: inlineRowsPayload([30]) });
    threadPageCount += 1;
    return ghResult({
      stdout: JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: true, endCursor: `CURSOR_${threadPageCount}` },
                nodes: [],
              },
            },
          },
        },
      }),
    });
  });

  assert.equal(result.ok, true);
  assert.equal(result.partial, true);
  assert.match(result.message, /more review thread data than DROIDEX can load/);
  assert.equal(threadPageCount, 10);
});

test('malformed successful conversation payload is reported instead of hidden', async () => {
  const result = await prComments('/repo', { prNumber: 79 }, async (_dir, args) => {
    if (args[0] === 'pr') return ghResult({ stdout: '{' });
    if (args[1] === 'graphql')
      return ghResult({
        stdout: JSON.stringify({
          data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } },
        }),
      });
    return ghResult({ stdout: inlineRowsPayload([30]) });
  });

  assert.equal(result.ok, true);
  assert.equal(result.partial, true);
  assert.match(result.message, /Invalid PR conversation payload/);
  assert.deepEqual(
    result.comments.map((comment) => comment.body),
    ['comment 30'],
  );
});

test('malformed successful inline payload is reported instead of hidden', async () => {
  const result = await prComments('/repo', { prNumber: 79 }, async (_dir, args) => {
    if (args[0] === 'pr') {
      return ghResult({
        stdout: JSON.stringify({ comments: [{ body: 'top level' }], reviews: [] }),
      });
    }
    if (args[1] === 'graphql')
      return ghResult({
        stdout: JSON.stringify({
          data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } },
        }),
      });
    return ghResult({ stdout: '{}' });
  });

  assert.equal(result.ok, true);
  assert.equal(result.partial, true);
  assert.match(result.message, /Invalid inline review comments payload/);
  assert.deepEqual(
    result.comments.map((comment) => comment.body),
    ['top level'],
  );
});

test('malformed successful payloads fail when no comment source is usable', async () => {
  const result = await prComments('/repo', { prNumber: 79 }, async (_dir, args) => {
    if (args[0] === 'pr') return ghResult({ stdout: '{' });
    if (args[1] === 'graphql')
      return ghResult({
        stdout: JSON.stringify({
          data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } },
        }),
      });
    return ghResult({ stdout: '{}' });
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'gh_error');
  assert.match(result.message, /Invalid PR conversation payload/);
  assert.match(result.message, /Invalid inline review comments payload/);
  assert.deepEqual(result.comments, []);
});

test('malformed successful review thread payload is reported when inline comments need status', async () => {
  const result = await prComments('/repo', { prNumber: 79 }, async (_dir, args) => {
    if (args[0] === 'pr')
      return ghResult({ stdout: JSON.stringify({ comments: [], reviews: [] }) });
    if (args[1] === 'graphql') return ghResult({ stdout: '{}' });
    return ghResult({ stdout: inlineRowsPayload([30]) });
  });

  assert.equal(result.ok, true);
  assert.equal(result.partial, true);
  assert.match(result.message, /Invalid review thread status payload/);
  assert.deepEqual(
    result.comments.map(({ resolved, outdated, resolvedBy }) => ({
      resolved,
      outdated,
      resolvedBy,
    })),
    [{ resolved: false, outdated: false, resolvedBy: null }],
  );
});

test('malformed successful review thread replies payload is reported as partial', async () => {
  const result = await prComments('/repo', { prNumber: 79 }, async (_dir, args) => {
    if (args[0] === 'pr')
      return ghResult({ stdout: JSON.stringify({ comments: [], reviews: [] }) });
    if (args[1] !== 'graphql') return ghResult({ stdout: inlineRowsPayload([30, 31]) });
    if (/reviewThreads/.test(graphqlQuery(args))) {
      return ghResult({
        stdout: JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [
                    {
                      id: 'THREAD_A',
                      isResolved: true,
                      comments: {
                        pageInfo: { hasNextPage: true, endCursor: 'REPLY_CURSOR' },
                        nodes: [{ databaseId: 30 }],
                      },
                    },
                  ],
                },
              },
            },
          },
        }),
      });
    }
    return ghResult({ stdout: '{}' });
  });

  assert.equal(result.ok, true);
  assert.equal(result.partial, true);
  assert.match(result.message, /Invalid review thread replies payload/);
  assert.deepEqual(
    result.comments.map(({ body, resolved }) => ({ body, resolved })),
    [
      { body: 'comment 30', resolved: true },
      { body: 'comment 31', resolved: false },
    ],
  );
});

test('PR comments fail only when neither source succeeds', async () => {
  const result = await prComments('/repo', { prNumber: 79 }, async (_dir, args) =>
    ghResult({ code: 1, stderr: `${args[0]} failed` }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'gh_error');
  assert.deepEqual(result.comments, []);
  assert.match(result.message, /pr failed/);
  assert.match(result.message, /api failed/);
});
