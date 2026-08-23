import type { PullRequest } from '../../../types/vcs';

export type PrInboxTab = 'all' | 'reviewing' | 'authored';

// Logins are ASCII, so plain case folding is enough; a locale-sensitive
// compare would fold them differently under, say, a Turkish locale.
function sameLogin(left: string | null | undefined, right: string | null | undefined): boolean {
  if (!left || !right) return false;
  return left.toLowerCase() === right.toLowerCase();
}

export function filterPullRequests(
  prs: PullRequest[],
  tab: PrInboxTab,
  viewerLogin: string | null,
): PullRequest[] {
  if (tab === 'all') return prs;
  if (!viewerLogin) return [];
  if (tab === 'authored') return prs.filter((item) => sameLogin(item.author, viewerLogin));
  return prs.filter(
    (item) =>
      item.reviewRequests.some((login) => sameLogin(login, viewerLogin)) ||
      item.reviews.some((review) => sameLogin(review.author, viewerLogin)),
  );
}

// `#` is how a pull request number is written, so a leading one narrows the
// search to the number. On its own it carries no query and matches everything.
export function searchPullRequests(prs: PullRequest[], query: string): PullRequest[] {
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
    ];
    return haystacks.some((value) => value.toLowerCase().includes(needle));
  });
}
