import type { PullRequest } from '../../../types/vcs';

export type PrInboxTab = 'all' | 'reviewing' | 'authored';

function sameLogin(left: string | null | undefined, right: string | null | undefined): boolean {
  if (!left || !right) return false;
  return left.localeCompare(right, undefined, { sensitivity: 'accent' }) === 0;
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

export function searchPullRequests(prs: PullRequest[], query: string): PullRequest[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return prs;
  const numberNeedle = needle.startsWith('#') ? needle.slice(1) : needle;
  return prs.filter((item) => {
    const haystacks = [
      item.title,
      String(item.number),
      `#${String(item.number)}`,
      item.author ?? '',
      item.headRefName ?? '',
      item.baseRefName ?? '',
    ];
    return haystacks.some(
      (value) => value.toLowerCase().includes(needle) || value.toLowerCase().includes(numberNeedle),
    );
  });
}
