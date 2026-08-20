// GitHub pull-request integration for the Context panel, driven by the `gh`
// CLI so it reuses the user's existing authentication and works on every OS.
// Every method degrades gracefully when `gh` is missing or unauthenticated.
const os = require('node:os');
const path = require('node:path');
const { resolveExecutable, runFile } = require('./executable.cjs');
const githubSetup = require('./githubSetup.cjs');

const DEFAULT_TIMEOUT = 15000;
const COMMON_GH_PATHS = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/opt/local/bin/gh'];

let cachedGhExecutablePromise;

function expandHome(value) {
  const str = String(value || '');
  if (str === '~') return os.homedir();
  if (str.startsWith('~/') || str.startsWith('~\\')) return path.join(os.homedir(), str.slice(2));
  return str;
}

function resolveGhExecutable(options = {}) {
  return resolveExecutable({ binaryName: 'gh', commonPaths: COMMON_GH_PATHS }, options);
}

async function cachedGhExecutable() {
  cachedGhExecutablePromise ||= resolveGhExecutable();
  const executable = await cachedGhExecutablePromise;
  if (!executable) cachedGhExecutablePromise = undefined;
  return executable;
}

function install(options = {}) {
  return githubSetup.install({
    ...options,
    resolveGh: options.resolveGh || cachedGhExecutable,
    invalidateGh: () => {
      cachedGhExecutablePromise = undefined;
    },
  });
}

function authenticate(options = {}) {
  return githubSetup.authenticate({
    ...options,
    resolveGh: options.resolveGh || cachedGhExecutable,
  });
}

// Resolve with { code, stdout, stderr } and never reject, so callers can decide
// how to treat non-zero exits (e.g. `gh pr checks` exits 8 while checks pend).
async function gh(cwd, args, { timeout = DEFAULT_TIMEOUT } = {}) {
  const executable = await cachedGhExecutable();
  if (!executable) {
    return { code: 1, stdout: '', stderr: 'GitHub CLI was not found.', spawnFailed: true };
  }
  return runFile(executable, args, {
    cwd: expandHome(cwd) || process.cwd(),
    timeout,
  });
}

function parseJson(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

// A PR selector must be a bare integer. Anything else (a URL, a branch name, or
// a value beginning with `-`) could be parsed by gh as an option and silently
// retarget another repository, so reject it before spawning gh. Callers pass the
// validated selector after a `--` terminator as a second line of defense.
function prSelector(value) {
  if (value == null) return null;
  const s = String(value);
  return /^[0-9]+$/.test(s) ? s : null;
}

async function available(options = {}) {
  const runGh = options.runGh || gh;
  const resolveBrew = options.resolveBrew || githubSetup.resolveBrewExecutable;
  const version = await runGh(process.cwd(), ['--version']);
  if (version.spawnFailed || version.code !== 0) {
    return {
      installed: false,
      authenticated: false,
      installMethod: (await resolveBrew()) ? 'homebrew' : 'manual',
    };
  }
  const auth = await runGh(process.cwd(), ['auth', 'status', '--hostname', 'github.com']);
  return { installed: true, authenticated: auth.code === 0, installMethod: null };
}

const PR_FIELDS = [
  'number',
  'title',
  'state',
  'url',
  'isDraft',
  'headRefName',
  'baseRefName',
  'mergeable',
  'reviewDecision',
  'additions',
  'deletions',
  'changedFiles',
  'createdAt',
  'updatedAt',
  'author',
  'reviewRequests',
  'reviews',
].join(',');

function loginOf(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  return value.login || value.name || null;
}

function normalizeReviewRequests(value) {
  if (!Array.isArray(value)) return [];
  return value.map(loginOf).filter(Boolean);
}

function normalizeReviews(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => ({
      author: loginOf(item?.author) || '',
      state: String(item?.state || '').toLowerCase(),
    }))
    .filter((item) => item.author);
}

// `gh pr view --json commits` reports every commit on the head branch with its
// GitHub author when one is linked; plain git authors only carry a name.
function normalizePrCommits(value) {
  if (!Array.isArray(value)) return [];
  const commits = [];
  for (const commit of value) {
    const oid = typeof commit?.oid === 'string' ? commit.oid : '';
    if (!oid) continue;
    const authors = Array.isArray(commit.authors) ? commit.authors : [];
    commits.push({
      oid,
      headline: String(commit.messageHeadline || '').trim(),
      committedDate: commit.committedDate || null,
      author: loginOf(authors[0]),
    });
  }
  return commits;
}

function normalizePr(pr) {
  return {
    number: pr.number,
    title: pr.title || '',
    state: String(pr.state || '').toLowerCase(),
    url: pr.url || '',
    isDraft: !!pr.isDraft,
    headRefName: pr.headRefName || null,
    baseRefName: pr.baseRefName || null,
    mergeable: pr.mergeable ? String(pr.mergeable).toLowerCase() : null,
    reviewDecision: pr.reviewDecision ? String(pr.reviewDecision).toLowerCase() : null,
    additions: pr.additions ?? 0,
    deletions: pr.deletions ?? 0,
    changedFiles: pr.changedFiles ?? 0,
    createdAt: pr.createdAt || null,
    updatedAt: pr.updatedAt || null,
    author: loginOf(pr.author),
    reviewRequests: normalizeReviewRequests(pr.reviewRequests),
    reviews: normalizeReviews(pr.reviews),
  };
}

// Distinguishes "queried successfully, no PR" ({ ok: true, pr: null }) from a
// failed query ({ ok: false }), so a transient gh error never erases a PR the
// UI already knows about.
async function detectPr(dir, { branch } = {}) {
  let pr;
  if (branch) {
    // `gh pr view <branch>` treats a numeric branch name (e.g. "123") as a PR
    // number; filtering by `--head` matches the branch name unambiguously.
    const res = await gh(dir, [
      'pr',
      'list',
      '--head',
      branch,
      '--state',
      'all',
      '--limit',
      '1',
      '--json',
      PR_FIELDS,
    ]);
    if (res.code !== 0) return { ok: false, pr: null };
    const list = parseJson(res.stdout, null);
    pr = Array.isArray(list) && list.length > 0 ? list[0] : null;
  } else {
    const res = await gh(dir, ['pr', 'view', '--json', PR_FIELDS]);
    if (res.code !== 0) {
      // gh exits 1 both when no PR exists and when it fails; only the explicit
      // "no pull requests found" message means an authoritative "no PR".
      if (!res.spawnFailed && /no pull requests found/i.test(res.stderr)) {
        return { ok: true, pr: null };
      }
      return { ok: false, pr: null };
    }
    pr = parseJson(res.stdout, null);
  }
  if (!pr || typeof pr.number !== 'number') return { ok: true, pr: null };
  return { ok: true, pr: normalizePr(pr) };
}

async function listPrs(dir, { state = 'open', limit = 50 } = {}, runGh = gh) {
  const list = await runGh(dir, [
    'pr',
    'list',
    '--state',
    state,
    '--limit',
    String(limit),
    '--json',
    PR_FIELDS,
  ]);
  if (list.spawnFailed) {
    return { ok: false, reason: 'gh_unavailable', viewerLogin: null, prs: [] };
  }
  if (list.code !== 0) {
    return {
      ok: false,
      reason: 'gh_error',
      message: list.stderr.trim(),
      viewerLogin: null,
      prs: [],
    };
  }
  const rows = parseJson(list.stdout, null);
  if (!Array.isArray(rows)) {
    return {
      ok: false,
      reason: 'gh_error',
      message: 'invalid list payload',
      viewerLogin: null,
      prs: [],
    };
  }
  const user = await runGh(dir, ['api', 'user', '--jq', '.login']);
  const viewerLogin = user.code === 0 ? String(user.stdout || '').trim() || null : null;
  return {
    ok: true,
    viewerLogin,
    prs: rows.filter((row) => typeof row?.number === 'number').map(normalizePr),
  };
}

async function viewPr(dir, { prNumber } = {}, runGh = gh) {
  const selector = prSelector(prNumber);
  if (selector == null) return { ok: false, reason: 'missing_pr', pr: null };
  const res = await runGh(dir, [
    'pr',
    'view',
    '--json',
    `${PR_FIELDS},body,commits`,
    '--',
    selector,
  ]);
  if (res.spawnFailed) return { ok: false, reason: 'gh_unavailable', pr: null };
  if (res.code !== 0) {
    return { ok: false, reason: 'gh_error', message: res.stderr.trim(), pr: null };
  }
  const raw = parseJson(res.stdout, null);
  if (!raw || typeof raw.number !== 'number') return { ok: true, pr: null };
  return {
    ok: true,
    pr: {
      ...normalizePr(raw),
      body: typeof raw.body === 'string' ? raw.body : '',
      commits: normalizePrCommits(raw.commits),
    },
  };
}

async function prDiff(dir, { prNumber } = {}, runGh = gh) {
  const selector = prSelector(prNumber);
  if (selector == null) return { ok: false, reason: 'missing_pr', diff: '' };
  const res = await runGh(dir, ['pr', 'diff', '--', selector], { timeout: 30000 });
  if (res.spawnFailed) return { ok: false, reason: 'gh_unavailable', diff: '' };
  if (res.code !== 0) {
    return { ok: false, reason: 'gh_error', message: res.stderr.trim(), diff: '' };
  }
  return { ok: true, diff: String(res.stdout || '') };
}

async function prChecks(dir, { prNumber } = {}) {
  const selector = prSelector(prNumber);
  if (selector == null) return { ok: false, reason: 'missing_pr', checks: [] };
  const res = await gh(dir, [
    'pr',
    'checks',
    '--json',
    'name,state,bucket,link,workflow,description,startedAt,completedAt',
    '--',
    selector,
  ]);
  // exit 8 = checks pending, exit 1 = a check failed; both still emit JSON.
  if (res.spawnFailed) return { ok: false, reason: 'gh_unavailable', checks: [] };
  const rows = parseJson(res.stdout, null);
  if (!Array.isArray(rows)) {
    // No checks reported is not an error for our UI.
    if (/no checks reported/i.test(res.stderr)) return { ok: true, checks: [] };
    return { ok: false, reason: 'gh_error', message: res.stderr.trim(), checks: [] };
  }
  const checks = rows.map((row) => ({
    name: row.name || row.workflow || 'check',
    workflow: row.workflow || null,
    bucket: String(row.bucket || row.state || '').toLowerCase(), // pass|fail|pending|skipping|cancel
    state: String(row.state || '').toLowerCase(),
    description: row.description || '',
    link: row.link || null,
    startedAt: row.startedAt || null,
    completedAt: row.completedAt || null,
  }));
  return { ok: true, checks };
}

async function createPr(dir, { title, body = '', base, draft = false, head } = {}) {
  if (!title || !title.trim()) return { ok: false, reason: 'empty_title' };
  const args = ['pr', 'create', '--title', title, '--body', body];
  if (base) args.push('--base', base);
  if (head) args.push('--head', head);
  if (draft) args.push('--draft');
  const res = await gh(dir, args, { timeout: 30000 });
  if (res.spawnFailed) return { ok: false, reason: 'gh_unavailable' };
  if (res.code !== 0) return { ok: false, reason: 'gh_error', message: res.stderr.trim() };
  const url = (res.stdout.match(/https?:\/\/\S+/) || [])[0] || null;
  const detected = await detectPr(dir, head ? { branch: head } : {});
  return { ok: true, url, number: detected.pr?.number ?? null, pr: detected.pr };
}

const MERGE_FLAGS = { merge: '--merge', squash: '--squash', rebase: '--rebase' };

// Merging is irreversible from the app's side, so the strategy must be one gh
// understands; passing an unknown method through would let gh fall back to its
// interactive prompt and hang the invisible child process.
async function mergePr(dir, { prNumber, method } = {}, runGh = gh) {
  const selector = prSelector(prNumber);
  if (selector == null) return { ok: false, reason: 'missing_pr' };
  // Own-key only: an inherited name such as `toString` would otherwise resolve
  // to a truthy function and reach execFile in place of a flag string.
  const requested = String(method);
  if (!Object.hasOwn(MERGE_FLAGS, requested)) return { ok: false, reason: 'invalid_method' };
  const flag = MERGE_FLAGS[requested];
  const res = await runGh(dir, ['pr', 'merge', flag, '--', selector], { timeout: 60000 });
  if (res.spawnFailed) return { ok: false, reason: 'gh_unavailable' };
  if (res.code !== 0) return { ok: false, reason: 'gh_error', message: res.stderr.trim() };
  return { ok: true };
}

async function postComment(dir, { prNumber, body } = {}) {
  const selector = prSelector(prNumber);
  if (selector == null) return { ok: false, reason: 'missing_pr' };
  if (!body || !body.trim()) return { ok: false, reason: 'empty_body' };
  const res = await gh(dir, ['pr', 'comment', '--body', body, '--', selector], {
    timeout: 30000,
  });
  if (res.spawnFailed) return { ok: false, reason: 'gh_unavailable' };
  if (res.code !== 0) return { ok: false, reason: 'gh_error', message: res.stderr.trim() };
  const url = (res.stdout.match(/https?:\/\/\S+/) || [])[0] || null;
  return { ok: true, url };
}

module.exports = {
  available,
  authenticate,
  install,
  cancelSetup: githubSetup.cancelSetup,
  isGithubDeviceUrl: githubSetup.isGithubDeviceUrl,
  resolveBrewExecutable: githubSetup.resolveBrewExecutable,
  resolveGhExecutable,
  // Shared with the conversation module, which runs its own gh queries.
  gh,
  parseJson,
  // Exported for unit tests: the validation boundary for PR selectors.
  prSelector,
  normalizePr,
  normalizePrCommits,
  detectPr,
  listPrs,
  viewPr,
  prDiff,
  prChecks,
  createPr,
  postComment,
  mergePr,
};
