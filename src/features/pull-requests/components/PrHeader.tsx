import type { ReactNode } from 'react';

import { CheckStatusIcon, Octicon } from '../../../components/environment/GithubIcons';
import { checksSummary, prKind, prKindLabel } from '../../../lib/github';
import type { PrCheck, PullRequest } from '../../../types/vcs';
import { displayLogin } from '../lib/prIdentity';
import {
  REVIEWER_STATE_LABEL,
  TONE_TEXT_CLASS,
  checksBadge,
  mergeStateBadge,
  reviewDecisionBadge,
  reviewerRows,
} from '../lib/prMeta';
import { prAbsoluteTime, prRelativeTime } from '../lib/prTime';
import type { PrBadge } from '../lib/prTimeline';
import { GithubAvatar } from './GithubAvatar';

const STATE_PILL = {
  open: { class: 'bg-[#238636] text-white', icon: 'git-pull-request' },
  draft: { class: 'bg-droid-elevated text-droid-text-secondary', icon: 'git-pull-request-draft' },
  merged: { class: 'bg-[#8250df] text-white', icon: 'git-merge' },
  closed: { class: 'bg-[#da3633] text-white', icon: 'git-pull-request-closed' },
} as const;

function Badge({ badge }: { badge: PrBadge }) {
  return (
    <span
      className={`rounded-full border border-droid-border px-2 py-0.5 text-[11.5px] font-medium ${
        TONE_TEXT_CLASS[badge.tone]
      }`}
    >
      {badge.label}
    </span>
  );
}

function MetaRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="pt-0.5 text-[12.5px] text-droid-text-muted">{label}</dt>
      <dd className="min-w-0 text-[13px] text-droid-text-secondary">{children}</dd>
    </>
  );
}

function Reviewers({ pr }: { pr: PullRequest }) {
  const rows = reviewerRows(pr);
  if (rows.length === 0) return <span className="text-droid-text-muted">No reviewers</span>;
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {rows.map((row) => (
        <span key={row.login} className="flex items-center gap-1.5">
          <GithubAvatar login={row.login} size={18} />
          <span className="text-droid-text">{displayLogin(row.login)}</span>
          <span className="text-droid-text-muted">{REVIEWER_STATE_LABEL[row.state]}</span>
        </span>
      ))}
    </span>
  );
}

// The rolled-up check state, next to the reviewers and comment count it is read
// with. The Checks section below owns the individual runs.
function ChecksMeta({
  checks,
  loading,
  error,
}: {
  checks: PrCheck[];
  loading: boolean;
  error: string | null;
}) {
  const summary = checksSummary(checks);
  const badge = checksBadge(summary);
  if (!badge) {
    // A failed load must not read as "this pull request has no checks"; the
    // Checks section below states the error itself.
    if (loading) return <span className="text-droid-text-muted">Loading…</span>;
    return (
      <span className="text-droid-text-muted">{error ? 'Unavailable' : 'No checks reported'}</span>
    );
  }
  return (
    <span className="flex items-center gap-1.5">
      <CheckStatusIcon status={summary.status === 'none' ? 'neutral' : summary.status} size={14} />
      <span className={TONE_TEXT_CLASS[badge.tone]}>{badge.label}</span>
    </span>
  );
}

export function PrHeader({
  pr,
  number,
  commentCount,
  checks,
  checksLoading,
  checksError,
}: {
  pr: PullRequest | null;
  number: number;
  commentCount: number;
  checks: PrCheck[];
  checksLoading: boolean;
  checksError: string | null;
}) {
  const kind = pr ? prKind(pr) : null;
  const updated = prRelativeTime(pr?.updatedAt ?? pr?.createdAt ?? null);
  const mergeState = mergeStateBadge(pr);
  const decision = reviewDecisionBadge(pr);

  return (
    <header>
      <h1 className="text-[21px] leading-snug font-semibold text-droid-text">
        {pr ? (
          <>
            {pr.title}
            <span className="ml-2 font-normal tabular-nums text-droid-text-muted">
              #{String(number)}
            </span>
          </>
        ) : (
          `Pull request #${String(number)}`
        )}
      </h1>
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        {kind ? (
          <span
            className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-medium ${STATE_PILL[kind].class}`}
          >
            <Octicon name={STATE_PILL[kind].icon} size={13} />
            {prKindLabel(kind)}
          </span>
        ) : (
          <span className="inline-flex h-7 w-20 rounded-full bg-droid-elevated/60" />
        )}
        {pr ? (
          <span className="flex items-center gap-1.5 text-[13px] text-droid-text-secondary">
            <GithubAvatar login={pr.author} size={20} />
            <span className="text-droid-text">{displayLogin(pr.author)}</span>
            {updated ? (
              <span
                title={prAbsoluteTime(pr.updatedAt ?? pr.createdAt)}
                className="text-droid-text-muted"
              >
                {/* `prRelativeTime` returns either "now" or an age like "3d",
                    and only an age reads as "ago". */}
                updated {updated === 'now' ? 'now' : `${updated} ago`}
              </span>
            ) : null}
          </span>
        ) : null}
        {decision ? <Badge badge={decision} /> : null}
      </div>
      {pr ? (
        <dl className="mt-4 grid grid-cols-[86px_minmax(0,1fr)] gap-x-4 gap-y-2">
          <MetaRow label="Branch">
            <span className="flex min-w-0 items-center gap-1.5">
              <Octicon name="git-branch" size={13} className="shrink-0 text-droid-text-muted" />
              <span className="truncate text-droid-text">{pr.headRefName ?? 'unknown'}</span>
              <span className="shrink-0 text-droid-text-muted">into</span>
              <span className="truncate">{pr.baseRefName ?? 'unknown'}</span>
            </span>
          </MetaRow>
          <MetaRow label="Changes">
            <span className="flex items-center gap-2 tabular-nums">
              <span>
                {pr.changedFiles} {pr.changedFiles === 1 ? 'file' : 'files'}
              </span>
              <span style={{ color: 'var(--diff-add-fg)' }}>+{pr.additions}</span>
              <span style={{ color: 'var(--diff-del-fg)' }}>−{pr.deletions}</span>
            </span>
          </MetaRow>
          <MetaRow label="Reviewers">
            <Reviewers pr={pr} />
          </MetaRow>
          <MetaRow label="Comments">
            <span className="tabular-nums">{commentCount}</span>
          </MetaRow>
          <MetaRow label="Checks">
            <ChecksMeta checks={checks} loading={checksLoading} error={checksError} />
          </MetaRow>
          {mergeState ? (
            <MetaRow label="Status">
              <span className={TONE_TEXT_CLASS[mergeState.tone]}>{mergeState.label}</span>
            </MetaRow>
          ) : null}
        </dl>
      ) : null}
    </header>
  );
}
