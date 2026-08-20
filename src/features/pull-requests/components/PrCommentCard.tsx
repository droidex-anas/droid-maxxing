import { useState } from 'react';

import { Octicon } from '../../../components/environment/GithubIcons';
import { openExternal } from '../../../lib/onboarding';
import type { PrComment } from '../../../types/vcs';
import { prCommentBlocks, prCommentProse } from '../lib/prCommentBody';
import {
  commentPreview,
  commentStartsFolded,
  threadStatus,
  type PrThreadStatus,
} from '../lib/prCommentFold';
import { displayLogin } from '../lib/prIdentity';
import { prAbsoluteTime, prRelativeTime } from '../lib/prTime';
import {
  commentActionLabel,
  inlineLocation,
  reviewBadge,
  type PrBadge,
  type PrTone,
} from '../lib/prTimeline';
import { PrBody } from './PrBody';
import { FoldChevron, PrCollapse } from './PrCollapse';
import { HunkPreview, ReactionChips } from './PrCommentContent';

const TONE_CLASS: Record<PrTone, string> = {
  neutral: 'text-droid-text-secondary',
  success: 'text-[var(--diff-add-fg)]',
  danger: 'text-[var(--diff-del-fg)]',
  accent: 'text-droid-accent',
};

function ToneBadge({ badge }: { badge: PrBadge }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full bg-droid-elevated px-2 py-0.5 text-[11px] font-medium ${
        TONE_CLASS[badge.tone]
      }`}
    >
      {badge.tone === 'success' ? <Octicon name="check" size={11} /> : null}
      {badge.tone === 'danger' ? <Octicon name="x" size={11} /> : null}
      {badge.label}
    </span>
  );
}

function ThreadStatusChip({ status }: { status: PrThreadStatus }) {
  return (
    <span
      title={status.title}
      className="inline-flex shrink-0 items-center gap-1 rounded-full bg-droid-elevated px-2 py-0.5 text-[11px] font-medium text-droid-text-secondary"
    >
      <Octicon name={status.icon} size={11} />
      {status.label}
    </span>
  );
}

function CommentByline({ comment }: { comment: PrComment }) {
  const time = prRelativeTime(comment.createdAt);
  return (
    <span className="block truncate text-[13px]">
      <span className="font-semibold text-droid-text">{displayLogin(comment.author)}</span>
      <span className="text-droid-text-muted"> {commentActionLabel(comment)}</span>
      {time ? (
        <span title={prAbsoluteTime(comment.createdAt)} className="text-droid-text-muted">
          {' · '}
          {time} ago
        </span>
      ) : null}
    </span>
  );
}

// Resolved threads and long comments arrive folded: the card shows who said
// what, where, and the first line, then opens on click. A short open comment
// has nothing worth folding, so it keeps a plain header with no chevron.
export function PrCommentCard({ comment }: { comment: PrComment }) {
  const blocks = prCommentBlocks(comment.body);
  const prose = prCommentProse(blocks);
  const foldable = commentStartsFolded(comment, prose);
  const [open, setOpen] = useState(!foldable);
  // Polling can edit or resolve a comment under the same id: a card that stops
  // being foldable must not stay collapsed with no way to expand it.
  const [appliedFoldable, setAppliedFoldable] = useState(foldable);
  if (foldable !== appliedFoldable) {
    setAppliedFoldable(foldable);
    setOpen(!foldable);
  }
  const location = inlineLocation(comment);
  const badge = reviewBadge(comment);
  const status = threadStatus(comment);
  const preview = commentPreview(prose);
  const previewLine = location && preview ? `${location.label} · ${preview}` : preview;

  return (
    <article className="overflow-hidden rounded-xl border border-droid-border bg-droid-surface">
      <header className="flex items-start gap-2 border-b border-droid-border bg-droid-elevated/40 px-3 py-2">
        {foldable ? (
          <button
            type="button"
            aria-expanded={open}
            title={open ? 'Collapse comment' : 'Expand comment'}
            onClick={() => {
              setOpen((value) => !value);
            }}
            className="group -my-1 -ml-1 flex min-w-0 flex-1 items-start gap-1.5 rounded-lg px-1 py-1 text-left transition-colors hover:bg-droid-elevated/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-droid-accent/50"
          >
            <span className="mt-[3px]">
              <FoldChevron open={open} />
            </span>
            <span className="min-w-0 flex-1">
              <CommentByline comment={comment} />
              {!open && previewLine ? (
                <span className="mt-0.5 block truncate text-[12.5px] text-droid-text-muted">
                  {previewLine}
                </span>
              ) : null}
            </span>
          </button>
        ) : (
          <span className="min-w-0 flex-1">
            <CommentByline comment={comment} />
          </span>
        )}
        <span className="flex shrink-0 items-center gap-2 pt-0.5">
          {status ? <ThreadStatusChip status={status} /> : null}
          {badge ? <ToneBadge badge={badge} /> : null}
          {comment.url ? (
            <button
              type="button"
              title="Open on GitHub"
              onClick={() => {
                if (comment.url) void openExternal(comment.url);
              }}
              className="rounded-md p-1 text-droid-text-muted transition-colors hover:bg-droid-active hover:text-droid-text"
            >
              <Octicon name="link-external" size={12} label="Open on GitHub" />
            </button>
          ) : null}
        </span>
      </header>
      <PrCollapse open={open}>
        <div className="px-3.5 py-3">
          {location ? (
            <p
              title={location.title}
              className="mb-2 inline-flex items-center gap-1.5 rounded-lg bg-droid-elevated/60 px-2 py-0.5 text-[12px] text-droid-text-secondary"
            >
              <Octicon name="file-diff" size={12} />
              {location.label}
            </p>
          ) : null}
          {comment.diffHunk ? <HunkPreview diffHunk={comment.diffHunk} /> : null}
          <PrBody blocks={blocks} />
          <ReactionChips reactions={comment.reactions} />
        </div>
      </PrCollapse>
    </article>
  );
}
