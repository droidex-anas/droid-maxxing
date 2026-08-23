import { useState, type ReactNode } from 'react';

import { Octicon } from '../../../components/environment/GithubIcons';
import type { PrComment, PrCommit, PullRequest } from '../../../types/vcs';
import { displayLogin } from '../lib/prIdentity';
import { prAbsoluteTime, prRelativeTime } from '../lib/prTime';
import { buildPrTimeline, openedEvent, shortSha } from '../lib/prTimeline';
import { GithubAvatar } from './GithubAvatar';
import { FoldChevron, PrCollapse } from './PrCollapse';
import { PrCommentCard } from './PrCommentCard';

function TimelineRow({ marker, children }: { marker: ReactNode; children: ReactNode }) {
  return (
    <div className="relative flex items-start gap-3 pb-3 last:pb-0">
      <div className="relative z-10 flex w-8 shrink-0 justify-center bg-droid-bg">{marker}</div>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function EventRow({ pr }: { pr: PullRequest }) {
  const event = openedEvent(pr);
  if (!event) return null;
  const time = prRelativeTime(event.createdAt);
  return (
    <TimelineRow
      marker={
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-droid-elevated text-droid-text-secondary">
          <Octicon name={event.isDraft ? 'git-pull-request-draft' : 'git-pull-request'} size={14} />
        </span>
      }
    >
      <p className="pt-1.5 text-[13px] text-droid-text-secondary">
        <span className="font-medium text-droid-text">{displayLogin(event.author)}</span> opened
        this pull request
        {time ? (
          <span title={prAbsoluteTime(event.createdAt)} className="text-droid-text-muted">
            {' · '}
            {time} ago
          </span>
        ) : null}
      </p>
    </TimelineRow>
  );
}

function CommitRow({ commit }: { commit: PrCommit }) {
  const time = prRelativeTime(commit.committedDate);
  return (
    <div className="flex min-w-0 items-center gap-2 py-[3px]">
      <GithubAvatar login={commit.author} size={16} />
      <span className="min-w-0 flex-1 truncate text-[13px] text-droid-text">
        {commit.headline || shortSha(commit.oid)}
      </span>
      <span className="shrink-0 font-mono text-[11.5px] text-droid-text-muted">
        {shortSha(commit.oid)}
      </span>
      {time ? (
        <span
          title={prAbsoluteTime(commit.committedDate)}
          className="shrink-0 text-[11.5px] text-droid-text-muted"
        >
          {time} ago
        </span>
      ) : null}
    </div>
  );
}

// A run of commits folds behind its own header, so a 40-commit branch never
// pushes the conversation off screen; a single commit is shown outright.
function CommitsEntry({ commits }: { commits: PrCommit[] }) {
  const [open, setOpen] = useState(commits.length === 1);
  const latest = commits.at(-1);
  const time = prRelativeTime(latest?.committedDate ?? null);
  return (
    <TimelineRow
      marker={
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-droid-elevated text-droid-text-secondary">
          <Octicon name="git-commit" size={14} />
        </span>
      }
    >
      <div className="rounded-xl border border-droid-border bg-droid-surface px-3 py-2">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => {
            setOpen((value) => !value);
          }}
          className="group flex w-full items-center gap-1.5 text-left"
        >
          <FoldChevron open={open} />
          <span className="text-[13px] font-medium text-droid-text">
            {commits.length} {commits.length === 1 ? 'commit' : 'commits'}
          </span>
          {time ? (
            <span className="ml-auto shrink-0 text-[11.5px] text-droid-text-muted">{time} ago</span>
          ) : null}
        </button>
        <PrCollapse open={open}>
          <div className="mt-1.5 border-t border-droid-border pt-1.5">
            {commits.map((commit) => (
              <CommitRow key={commit.oid} commit={commit} />
            ))}
          </div>
        </PrCollapse>
      </div>
    </TimelineRow>
  );
}

export function PrTimeline({
  pr,
  comments,
  commits,
  loading,
  error,
}: {
  pr: PullRequest | null;
  comments: PrComment[];
  commits: PrCommit[];
  loading: boolean;
  error: string | null;
}) {
  const items = buildPrTimeline(comments, commits);
  const showEmpty = items.length === 0 && !loading;
  return (
    <div>
      {error ? <p className="mb-3 text-[13px] text-droid-text-muted">{error}</p> : null}
      {/* The rail sits behind the markers, which paint their own background so
          the line reads as a connector between events. */}
      <div className="relative">
        <span
          aria-hidden="true"
          className="absolute top-2 bottom-2 left-4 w-px -translate-x-1/2 bg-droid-border"
        />
        {pr ? <EventRow pr={pr} /> : null}
        {items.map((item) =>
          item.kind === 'comment' ? (
            <TimelineRow
              key={item.id}
              marker={<GithubAvatar login={item.comment.author} size={32} />}
            >
              <PrCommentCard comment={item.comment} />
            </TimelineRow>
          ) : (
            <CommitsEntry key={item.id} commits={item.commits} />
          ),
        )}
      </div>
      {loading && items.length === 0 ? (
        <div className="mt-2 h-20 rounded-xl border border-droid-border bg-droid-elevated/30" />
      ) : null}
      {showEmpty && !error ? (
        <p className="mt-1 pl-11 text-[13px] text-droid-text-muted">
          No comments yet. Start the conversation below.
        </p>
      ) : null}
    </div>
  );
}
