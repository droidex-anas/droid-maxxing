// The pull request conversation: top-level comments, submitted reviews, and
// inline review threads with their resolution state, gathered through the `gh`
// CLI and normalized into one chronological timeline for the UI.
const { gh, parseJson, prSelector } = require('./github.cjs');

// Resolution lives on the review thread, which `gh pr view --json` cannot
// report, so it comes from GraphQL. gh expands {owner}/{repo} in field values,
// so no repository lookup of our own is needed.
const REVIEW_THREADS_QUERY =
  'query($owner:String!,$repo:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$repo)' +
  '{pullRequest(number:$number){reviewThreads(first:100,after:$cursor){pageInfo{hasNextPage endCursor}' +
  'nodes{id isResolved isOutdated resolvedBy{login} comments(first:100)' +
  '{pageInfo{hasNextPage endCursor}nodes{databaseId}}}}}}}';

// Replies beyond the first page of a single thread, addressed by the thread's
// GraphQL node id.
const THREAD_COMMENTS_QUERY =
  'query($id:ID!,$cursor:String){node(id:$id){... on PullRequestReviewThread' +
  '{comments(first:100,after:$cursor){pageInfo{hasNextPage endCursor}nodes{databaseId}}}}}';

// A pull request can hold more review threads, and a thread more replies, than
// one GraphQL page returns. These caps keep an extreme pull request from
// spawning gh indefinitely; reaching one is reported as truncation so the UI
// never presents a missing verdict as "unresolved".
const MAX_THREAD_PAGES = 10;
const MAX_THREAD_COMMENT_PAGES = 10;

function nextPageCursor(pageInfo) {
  if (pageInfo?.hasNextPage !== true) return null;
  return typeof pageInfo.endCursor === 'string' && pageInfo.endCursor ? pageInfo.endCursor : null;
}

function commentIdsOf(connection) {
  return (Array.isArray(connection?.nodes) ? connection.nodes : [])
    .map((comment) => comment?.databaseId)
    .filter((databaseId) => databaseId != null)
    .map(String);
}

function parseObjectPayload(stdout, message) {
  const payload = parseJson(stdout, null);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, message };
  }
  return { ok: true, payload };
}

function parsePrConversationPayload(stdout) {
  const parsed = parseObjectPayload(stdout, 'Invalid PR conversation payload');
  if (!parsed.ok) return parsed;
  if (!Array.isArray(parsed.payload.comments) || !Array.isArray(parsed.payload.reviews)) {
    return { ok: false, message: 'Invalid PR conversation payload' };
  }
  return parsed;
}

function parseInlineCommentPages(stdout) {
  const payload = parseJson(stdout, null);
  if (!Array.isArray(payload) || payload.some((page) => !Array.isArray(page))) {
    return { ok: false, message: 'Invalid inline review comments payload' };
  }
  return { ok: true, pages: payload };
}

function parseReviewThreadPayload(stdout) {
  const parsed = parseObjectPayload(stdout, 'Invalid review thread status payload');
  if (!parsed.ok) return parsed;
  const connection = parsed.payload.data?.repository?.pullRequest?.reviewThreads;
  if (!connection || typeof connection !== 'object' || !Array.isArray(connection.nodes)) {
    return { ok: false, message: 'Invalid review thread status payload' };
  }
  return parsed;
}

function parseThreadCommentPayload(stdout) {
  const parsed = parseObjectPayload(stdout, 'Invalid review thread replies payload');
  if (!parsed.ok) return parsed;
  const connection = parsed.payload.data?.node?.comments;
  if (!connection || typeof connection !== 'object' || !Array.isArray(connection.nodes)) {
    return { ok: false, message: 'Invalid review thread replies payload' };
  }
  return parsed;
}

// Thread status keyed by the REST comment id, so every comment in a resolved
// thread carries the same verdict. A thread whose replies are themselves paged
// is reported back so the caller can fetch the rest.
function normalizeReviewThreadPage(payload) {
  const connection = payload?.data?.repository?.pullRequest?.reviewThreads;
  const statusByCommentId = new Map();
  const pagedThreads = [];
  for (const node of Array.isArray(connection?.nodes) ? connection.nodes : []) {
    const status = {
      resolved: node?.isResolved === true,
      outdated: node?.isOutdated === true,
      resolvedBy: node?.resolvedBy?.login || null,
    };
    for (const id of commentIdsOf(node?.comments)) statusByCommentId.set(id, status);
    const cursor = nextPageCursor(node?.comments?.pageInfo);
    if (cursor && typeof node?.id === 'string') pagedThreads.push({ id: node.id, cursor, status });
  }
  return { statusByCommentId, pagedThreads, nextCursor: nextPageCursor(connection?.pageInfo) };
}

function normalizeThreadCommentPage(payload) {
  const connection = payload?.data?.node?.comments;
  return { ids: commentIdsOf(connection), nextCursor: nextPageCursor(connection?.pageInfo) };
}

async function fetchThreadReplies(dir, thread, statusByCommentId, runGh) {
  let cursor = thread.cursor;
  let pagesLeft = MAX_THREAD_COMMENT_PAGES;
  while (cursor && pagesLeft > 0) {
    pagesLeft -= 1;
    const res = await runGh(dir, [
      'api',
      'graphql',
      '-f',
      `id=${thread.id}`,
      '-f',
      `cursor=${cursor}`,
      '-f',
      `query=${THREAD_COMMENTS_QUERY}`,
    ]);
    if (res.spawnFailed || res.code !== 0) return { ok: false, message: res.stderr.trim() };
    const parsed = parseThreadCommentPayload(res.stdout);
    if (!parsed.ok) return { ok: false, message: parsed.message };
    const page = normalizeThreadCommentPage(parsed.payload);
    for (const id of page.ids) statusByCommentId.set(id, thread.status);
    cursor = page.nextCursor;
  }
  return { ok: true, truncated: cursor != null };
}

// Resolves with every thread status that could be read plus whether anything was
// left unread, so a partial answer stays usable and honest.
async function fetchReviewThreadStatus(dir, selector, runGh) {
  const statusByCommentId = new Map();
  const pagedThreads = [];
  let cursor = null;
  let pagesLeft = MAX_THREAD_PAGES;
  while (pagesLeft > 0) {
    pagesLeft -= 1;
    const args = [
      'api',
      'graphql',
      '-F',
      'owner={owner}',
      '-F',
      'repo={repo}',
      '-F',
      `number=${selector}`,
    ];
    if (cursor) args.push('-f', `cursor=${cursor}`);
    args.push('-f', `query=${REVIEW_THREADS_QUERY}`);
    const res = await runGh(dir, args);
    if (res.spawnFailed || res.code !== 0) {
      return { ok: false, message: res.stderr.trim(), statusByCommentId, truncated: true };
    }
    const parsed = parseReviewThreadPayload(res.stdout);
    if (!parsed.ok) {
      return { ok: false, message: parsed.message, statusByCommentId, truncated: true };
    }
    const page = normalizeReviewThreadPage(parsed.payload);
    for (const [id, status] of page.statusByCommentId) statusByCommentId.set(id, status);
    pagedThreads.push(...page.pagedThreads);
    cursor = page.nextCursor;
    if (!cursor) break;
  }
  let truncated = cursor != null;
  for (const thread of pagedThreads) {
    const replies = await fetchThreadReplies(dir, thread, statusByCommentId, runGh);
    if (!replies.ok) {
      return { ok: false, message: replies.message, statusByCommentId, truncated: true };
    }
    truncated = truncated || replies.truncated;
  }
  return { ok: true, statusByCommentId, truncated };
}

// Only worth reporting when there are inline comments whose status would now be
// missing; without them the thread query has nothing to say.
function reviewThreadIssue(threads, { inlineSucceeded, inlineCount }) {
  if (!inlineSucceeded || inlineCount === 0) return null;
  if (!threads.ok) return threads.message || 'Could not load review thread status';
  if (threads.truncated) {
    return 'This pull request has more review thread data than DROIDEX can load, so some resolved states are missing.';
  }
  return null;
}

function normalizePrComments(data, inlineRows = [], threadStatus = new Map()) {
  const normalizeReactionGroups = (groups) => {
    if (!Array.isArray(groups)) return [];
    return groups
      .map((group) => ({
        content: String(group?.content || '').toUpperCase(),
        count: Number(group?.users?.totalCount || 0),
      }))
      .filter((reaction) => reaction.content && reaction.count > 0);
  };
  const normalizeRestReactions = (reactions) => {
    const contentByField = {
      '+1': 'THUMBS_UP',
      '-1': 'THUMBS_DOWN',
      laugh: 'LAUGH',
      hooray: 'HOORAY',
      confused: 'CONFUSED',
      heart: 'HEART',
      rocket: 'ROCKET',
      eyes: 'EYES',
    };
    if (!reactions || typeof reactions !== 'object') return [];
    return Object.entries(contentByField)
      .map(([field, content]) => ({ content, count: Number(reactions[field] || 0) }))
      .filter((reaction) => reaction.count > 0);
  };
  const comments = (Array.isArray(data?.comments) ? data.comments : []).map((c, i) => ({
    id: `comment-${String(c.databaseId || c.id || `${i}-${c.createdAt || ''}`)}`,
    kind: 'comment',
    author: c.author?.login || 'unknown',
    body: c.body || '',
    createdAt: c.createdAt || null,
    url: c.url || null,
    state: null,
    reactions: normalizeReactionGroups(c.reactionGroups),
  }));
  const reviews = (Array.isArray(data?.reviews) ? data.reviews : [])
    .filter((r) => (r.body && r.body.trim()) || (r.state && r.state !== 'COMMENTED'))
    .map((r, i) => ({
      id: `review-${String(r.databaseId || r.id || `${i}-${r.submittedAt || ''}`)}`,
      kind: 'review',
      author: r.author?.login || 'unknown',
      body: r.body || '',
      createdAt: r.submittedAt || null,
      url: r.url || null,
      state: r.state ? String(r.state).toLowerCase() : null,
      reactions: normalizeReactionGroups(r.reactionGroups),
    }));
  const inline = (Array.isArray(inlineRows) ? inlineRows : []).map((comment, i) => {
    const status = threadStatus.get(String(comment.id)) ?? null;
    return {
      id: `inline-${String(comment.id || `${i}-${comment.created_at || ''}`)}`,
      kind: 'inline',
      author: comment.user?.login || 'unknown',
      body: comment.body || '',
      createdAt: comment.created_at || null,
      url: comment.html_url || null,
      state: null,
      path: comment.path || null,
      line: comment.line ?? comment.original_line ?? null,
      diffHunk: comment.diff_hunk || null,
      resolved: status?.resolved === true,
      outdated: status?.outdated === true,
      resolvedBy: status?.resolvedBy ?? null,
      reactions: normalizeRestReactions(comment.reactions),
    };
  });
  return [...comments, ...reviews, ...inline].sort(
    (a, b) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime(),
  );
}

async function prComments(dir, { prNumber } = {}, runGh = gh) {
  const selector = prSelector(prNumber);
  if (selector == null) return { ok: false, reason: 'missing_pr', comments: [] };
  const [view, inline, threads] = await Promise.all([
    runGh(dir, ['pr', 'view', '--json', 'comments,reviews', '--', selector]),
    runGh(dir, ['api', '--paginate', '--slurp', `repos/{owner}/{repo}/pulls/${selector}/comments`]),
    fetchReviewThreadStatus(dir, selector, runGh),
  ]);
  const viewSucceeded = !view.spawnFailed && view.code === 0;
  const inlineSucceeded = !inline.spawnFailed && inline.code === 0;
  if (!viewSucceeded && !inlineSucceeded) {
    const message = [view.stderr, inline.stderr]
      .map((value) => value.trim())
      .filter(Boolean)
      .join('\n');
    return {
      ok: false,
      reason: view.spawnFailed || inline.spawnFailed ? 'gh_unavailable' : 'gh_error',
      message,
      comments: [],
    };
  }
  const viewPayload = viewSucceeded ? parsePrConversationPayload(view.stdout) : null;
  const inlinePayload = inlineSucceeded ? parseInlineCommentPages(inline.stdout) : null;
  const parsedViewSucceeded = viewPayload?.ok === true;
  const parsedInlineSucceeded = inlinePayload?.ok === true;
  if (!parsedViewSucceeded && !parsedInlineSucceeded) {
    return {
      ok: false,
      reason: view.spawnFailed || inline.spawnFailed ? 'gh_unavailable' : 'gh_error',
      message: [
        viewPayload?.message || view.stderr.trim(),
        inlinePayload?.message || inline.stderr.trim(),
      ]
        .filter(Boolean)
        .join('\n'),
      comments: [],
    };
  }
  const data = parsedViewSucceeded ? viewPayload.payload : { comments: [], reviews: [] };
  const inlineRows = parsedInlineSucceeded ? inlinePayload.pages.flat() : [];
  const threadIssue = reviewThreadIssue(threads, {
    inlineSucceeded: parsedInlineSucceeded,
    inlineCount: inlineRows.length,
  });
  const failures = [
    ...(parsedViewSucceeded
      ? []
      : [viewPayload?.message || view.stderr.trim() || 'Could not load PR conversation comments']),
    ...(parsedInlineSucceeded
      ? []
      : [
          inlinePayload?.message || inline.stderr.trim() || 'Could not load inline review comments',
        ]),
    ...(threadIssue ? [threadIssue] : []),
  ];
  return {
    ok: true,
    ...(failures.length === 0 ? {} : { partial: true, message: failures.join('\n') }),
    comments: normalizePrComments(data, inlineRows, threads.statusByCommentId),
  };
}

module.exports = {
  prComments,
  // Exported for unit tests: the pure normalizers behind the timeline.
  normalizePrComments,
  normalizeReviewThreadPage,
};
