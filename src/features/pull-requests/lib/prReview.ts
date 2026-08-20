import type { PrKind } from '../../../lib/github';
import type { PrComment, PullRequest } from '../../../types/vcs';

// Review is a DROIDEX concept with providers underneath it. Cubic is the first
// cloud provider; the local Droid agent is always available.
export const CUBIC_INVITE_URL = 'https://www.cubic.dev/invite/anasibnanwar1-droid';

// Cubic reviews a pull request when it is mentioned on the conversation, which
// is the same thing a human would type on GitHub.
export const CUBIC_REVIEW_MENTION = '@cubic-dev-ai review this PR';

function normalizeLogin(login: string): string {
  return login
    .trim()
    .toLowerCase()
    .replace(/\[bot\]$/, '');
}

// Cubic posts conversation comments as `cubic-dev-ai` and reviews as
// `cubic-dev-ai[bot]`; no other login counts as Cubic activity.
const CUBIC_LOGIN = 'cubic-dev-ai';

export function isCubicAuthor(login: string): boolean {
  return normalizeLogin(login) === CUBIC_LOGIN;
}

export function hasCubicActivity(comments: readonly PrComment[]): boolean {
  return comments.some((comment) => isCubicAuthor(comment.author));
}

// Cubic is installed per repository, so its memory is keyed by the repository
// the pull request belongs to rather than by the local checkout.
export function repoKeyFromPrUrl(url: string | null | undefined): string | null {
  const match = /^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/pull\//.exec(url ?? '');
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : null;
}

export type PrReviewAction = 'enable-cubic' | 'run-cubic' | 'droid';

export interface PrReviewOption {
  action: PrReviewAction;
  title: string;
  hint: string;
}

const DROID_OPTION: PrReviewOption = {
  action: 'droid',
  title: 'Review with Droid',
  hint: 'Opens a new chat with the review skill',
};

// What the Review menu offers: the cloud provider first when it can act, then
// the local agent, which is always available. A merged or closed pull request
// has nothing left for Cubic to review.
export function prReviewOptions(input: {
  cubicInstalled: boolean;
  kind: PrKind;
}): PrReviewOption[] {
  const open = input.kind === 'open' || input.kind === 'draft';
  if (!input.cubicInstalled) {
    return [
      { action: 'enable-cubic', title: 'Enable Cubic', hint: 'AI review requires Cubic' },
      DROID_OPTION,
    ];
  }
  if (!open) return [DROID_OPTION];
  return [
    { action: 'run-cubic', title: 'Run AI review', hint: 'Asks Cubic to review this pull request' },
    DROID_OPTION,
  ];
}

// The prompt the new chat opens with: the review skill, then which pull request
// to review. Sending stays the user's decision.
export function droidReviewSeed(pr: PullRequest): string {
  const reference = pr.url ? `\n${pr.url}` : '';
  return `/review Pull request #${String(pr.number)}: ${pr.title}${reference}`;
}
