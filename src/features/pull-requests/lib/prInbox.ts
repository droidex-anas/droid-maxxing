import type { PullRequest } from '../../../types/vcs';
import { comparablePath } from '../../../lib/pathComparison';
import { prBacklogId } from './prBacklog';

export type PrInboxTab = 'all' | 'reviewing' | 'authored' | 'backlog';

export interface InboxPullRequest extends PullRequest {
  cwd: string;
  repoName: string;
}

export interface InboxRepoGroup {
  cwd: string;
  repoName: string;
  prs: InboxPullRequest[];
}

// Logins are ASCII, so plain case folding is enough; a locale-sensitive
// compare would fold them differently under, say, a Turkish locale.
function sameLogin(left: string | null | undefined, right: string | null | undefined): boolean {
  if (!left || !right) return false;
  return left.toLowerCase() === right.toLowerCase();
}

export function filterPullRequests(
  prs: InboxPullRequest[],
  tab: PrInboxTab,
  viewerLogin: string | null,
  backlogIds: ReadonlySet<string> = new Set(),
): InboxPullRequest[] {
  if (tab === 'backlog') return prs.filter((item) => backlogIds.has(prBacklogId(item)));
  const active =
    backlogIds.size === 0 ? prs : prs.filter((item) => !backlogIds.has(prBacklogId(item)));
  if (tab === 'all') return active;
  if (!viewerLogin) return [];
  if (tab === 'authored') return active.filter((item) => sameLogin(item.author, viewerLogin));
  return active.filter(
    (item) =>
      item.reviewRequests.some((login) => sameLogin(login, viewerLogin)) ||
      item.reviews.some((review) => sameLogin(review.author, viewerLogin)),
  );
}

// `#` is how a pull request number is written, so a leading one narrows the
// search to the number. On its own it carries no query and matches everything.
export function searchPullRequests(prs: InboxPullRequest[], query: string): InboxPullRequest[] {
  const trimmed = query.trim().toLowerCase();
  const numbered = trimmed.startsWith('#');
  const needle = numbered ? trimmed.slice(1).trim() : trimmed;
  if (!needle) return prs;
  return prs.filter((item) => {
    if (String(item.number).includes(needle)) return true;
    if (numbered) return false;
    const haystacks = [
      item.title,
      item.author ?? '',
      item.headRefName ?? '',
      item.baseRefName ?? '',
      item.repoName,
    ];
    return haystacks.some((value) => value.toLowerCase().includes(needle));
  });
}

export function groupInboxPullRequests(prs: InboxPullRequest[]): InboxRepoGroup[] {
  const groups: InboxRepoGroup[] = [];
  const index = new Map<string, InboxRepoGroup>();
  for (const pr of prs) {
    const key = comparablePath(pr.cwd);
    const existing = index.get(key);
    if (existing) {
      existing.prs.push(pr);
      continue;
    }
    const group = { cwd: pr.cwd, repoName: pr.repoName, prs: [pr] };
    index.set(key, group);
    groups.push(group);
  }
  return groups;
}

export function selectedInboxPullRequest(
  prs: InboxPullRequest[],
  cwd: string | null,
  number: number | null,
): InboxPullRequest | null {
  if (!cwd || number == null) return null;
  const bound = comparablePath(cwd);
  return prs.find((item) => item.number === number && comparablePath(item.cwd) === bound) ?? null;
}

export function isCurrentInboxGroup(cwd: string, currentCwd: string | null): boolean {
  return currentCwd != null && comparablePath(cwd) === comparablePath(currentCwd);
}

export function orderInboxGroups(
  groups: InboxRepoGroup[],
  currentCwd: string | null,
): InboxRepoGroup[] {
  if (!currentCwd) return groups;
  const current = comparablePath(currentCwd);
  const head: InboxRepoGroup[] = [];
  const tail: InboxRepoGroup[] = [];
  for (const group of groups) {
    if (comparablePath(group.cwd) === current) head.push(group);
    else tail.push(group);
  }
  return [...head, ...tail];
}

export function attachInboxRepoErrors(
  groups: InboxRepoGroup[],
  errors: readonly { cwd: string; repoName: string }[],
): InboxRepoGroup[] {
  const present = new Set(groups.map((group) => comparablePath(group.cwd)));
  const extras = errors
    .filter((error) => !present.has(comparablePath(error.cwd)))
    .map((error) => ({ cwd: error.cwd, repoName: error.repoName, prs: [] as InboxPullRequest[] }));
  return [...groups, ...extras];
}

export function ensureCurrentInboxGroup(
  groups: InboxRepoGroup[],
  currentCwd: string | null,
  repoName: string,
): InboxRepoGroup[] {
  if (!currentCwd) return groups;
  if (groups.some((group) => isCurrentInboxGroup(group.cwd, currentCwd))) return groups;
  return [{ cwd: currentCwd, repoName, prs: [] }, ...groups];
}

export function inboxGroupIsExpanded(input: {
  cwd: string;
  currentCwd: string | null;
  expandedOther: ReadonlySet<string>;
  searching: boolean;
  selectedCwd: string | null;
}): boolean {
  if (isCurrentInboxGroup(input.cwd, input.currentCwd)) return true;
  if (input.searching) return true;
  if (input.selectedCwd && comparablePath(input.selectedCwd) === comparablePath(input.cwd)) {
    return true;
  }
  return input.expandedOther.has(comparablePath(input.cwd));
}
