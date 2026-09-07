import type { PrBadge } from '../../../lib/github';
import type { PullRequest } from '../../../types/vcs';

export type ReviewerState =
  | 'approved'
  | 'changes_requested'
  | 'dismissed'
  | 'commented'
  | 'pending';

export interface ReviewerRow {
  login: string;
  state: ReviewerState;
}

function reviewerState(state: string): ReviewerState {
  switch (state) {
    case 'approved':
      return 'approved';
    case 'changes_requested':
      return 'changes_requested';
    case 'dismissed':
      return 'dismissed';
    case 'pending':
      return 'pending';
    default:
      return 'commented';
  }
}

// gh lists reviews chronologically, so the last entry for an author is their
// current position; an active review request wins over a previous review.
export function reviewerRows(pr: PullRequest | null): ReviewerRow[] {
  if (!pr) return [];
  const byLogin = new Map<string, ReviewerState>();
  for (const review of pr.reviews) {
    if (review.author) byLogin.set(review.author, reviewerState(review.state));
  }
  for (const login of pr.reviewRequests) {
    if (login) byLogin.set(login, 'pending');
  }
  return [...byLogin].map(([login, state]) => ({ login, state }));
}

export const REVIEWER_STATE_LABEL: Record<ReviewerState, string> = {
  approved: 'approved',
  changes_requested: 'requested changes',
  dismissed: 'review dismissed',
  commented: 'commented',
  pending: 'review pending',
};

// `mergeable` is gh's mergeability, which is only meaningful while the PR is
// open; a merged or closed PR reports its own state instead.
export function mergeStateBadge(pr: PullRequest | null): PrBadge | null {
  if (!pr) return null;
  const state = (pr.state || '').toLowerCase();
  if (state === 'merged') return { label: 'Merged', tone: 'accent' };
  if (state === 'closed') return { label: 'Closed', tone: 'danger' };
  if (pr.isDraft) return { label: 'Draft', tone: 'neutral' };
  switch (pr.mergeable) {
    case 'conflicting':
      return { label: 'Merge conflicts', tone: 'danger' };
    case 'mergeable':
      return { label: 'No conflicts', tone: 'success' };
    default:
      return { label: 'Ready for review', tone: 'neutral' };
  }
}

// What stops this pull request from being merged from here. Branch-protection
// rules are not visible to `gh pr view`, so only the two facts we do know gate
// the button; anything else is left to gh, which reports GitHub's own refusal.
export function mergeBlockReason(pr: PullRequest): string | null {
  if (pr.isDraft) return 'Mark this pull request ready for review before merging.';
  if (pr.mergeable === 'conflicting') return 'Resolve the merge conflicts before merging.';
  return null;
}

export function hasMergeConflicts(pr: PullRequest | null): boolean {
  if (!pr) return false;
  const state = (pr.state || '').toLowerCase();
  return state === 'open' && pr.mergeable === 'conflicting';
}
