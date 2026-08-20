import type { ChecksSummary } from '../../../lib/github';
import type { PullRequest } from '../../../types/vcs';
import type { PrBadge, PrTone } from './prTimeline';

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
    default:
      return 'commented';
  }
}

// gh lists reviews chronologically, so the last entry for an author is their
// current position; requested-but-silent reviewers stay pending.
export function reviewerRows(pr: PullRequest | null): ReviewerRow[] {
  if (!pr) return [];
  const byLogin = new Map<string, ReviewerState>();
  for (const login of pr.reviewRequests) {
    if (login) byLogin.set(login, 'pending');
  }
  for (const review of pr.reviews) {
    if (review.author) byLogin.set(review.author, reviewerState(review.state));
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

export function reviewDecisionBadge(pr: PullRequest | null): PrBadge | null {
  switch (pr?.reviewDecision) {
    case 'approved':
      return { label: 'Approved', tone: 'success' };
    case 'changes_requested':
      return { label: 'Changes requested', tone: 'danger' };
    case 'review_required':
      return { label: 'Review required', tone: 'neutral' };
    default:
      return null;
  }
}

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

export function checksBadge(summary: ChecksSummary): PrBadge | null {
  if (summary.total === 0) return null;
  if (summary.fail > 0) {
    return { label: `${String(summary.fail)} failing`, tone: 'danger' };
  }
  if (summary.pending > 0) {
    return { label: `${String(summary.pending)} running`, tone: 'neutral' };
  }
  // Skipped or neutral checks never ran: a run that passed some and skipped
  // some is partial, and only a run where every check passed is green.
  const skipped = summary.total - summary.pass - summary.fail - summary.pending;
  if (summary.pass === 0) {
    return { label: `${String(skipped)} skipped`, tone: 'neutral' };
  }
  if (skipped > 0) {
    return { label: `${String(summary.pass)}/${String(summary.total)} passed`, tone: 'neutral' };
  }
  return { label: `${String(summary.pass)}/${String(summary.total)} passed`, tone: 'success' };
}

export const TONE_TEXT_CLASS: Record<PrTone, string> = {
  neutral: 'text-droid-text-secondary',
  success: 'text-[var(--diff-add-fg)]',
  danger: 'text-[var(--diff-del-fg)]',
  accent: 'text-[#a371f7]',
};
