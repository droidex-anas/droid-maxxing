import { useEffect, useRef, type ReactNode } from 'react';

import { Markdown } from '../../../components/Markdown';
import { normalizePrCommentBody } from '../../../lib/prCommentPresentation';
import { formatRelativeTime } from '../../../lib/time';
import type { PrComment } from '../../../types/vcs';

const REACTION_DETAILS = {
  THUMBS_UP: { emoji: '👍', label: 'thumbs up' },
  THUMBS_DOWN: { emoji: '👎', label: 'thumbs down' },
  LAUGH: { emoji: '😄', label: 'laugh' },
  HOORAY: { emoji: '🎉', label: 'hooray' },
  CONFUSED: { emoji: '😕', label: 'confused' },
  HEART: { emoji: '❤️', label: 'heart' },
  ROCKET: { emoji: '🚀', label: 'rocket' },
  EYES: { emoji: '👀', label: 'eyes' },
} as const;

function reactionDetails(content: string) {
  if (content in REACTION_DETAILS) {
    return REACTION_DETAILS[content as keyof typeof REACTION_DETAILS];
  }
  return null;
}

function relativeTime(iso: string | null): string {
  if (!iso) return '';
  const ts = Date.parse(iso);
  return Number.isFinite(ts) ? formatRelativeTime(ts) : '';
}

function inlineLocation(comment: PrComment): string | null {
  if (comment.kind !== 'inline' || !comment.path) return null;
  return comment.line == null ? comment.path : `${comment.path}:${String(comment.line)}`;
}

function ReactionChips({ reactions }: { reactions: PrComment['reactions'] }) {
  if (reactions.length === 0) return null;
  return (
    <span className="mt-2 flex flex-wrap gap-1">
      {reactions.map((reaction) => {
        const details = reactionDetails(reaction.content);
        if (!details) return null;
        return (
          <span
            key={reaction.content}
            title={`${String(reaction.count)} ${details.label}`}
            className="inline-flex items-center gap-1 rounded-full bg-droid-elevated/50 px-1.5 py-0.5 text-[10px] text-droid-text-muted"
          >
            <span aria-hidden="true">{details.emoji}</span>
            <span>{reaction.count}</span>
          </span>
        );
      })}
    </span>
  );
}

function CommentItem({ comment }: { comment: PrComment }) {
  const body = normalizePrCommentBody(comment.body);
  const time = relativeTime(comment.createdAt);
  const location = inlineLocation(comment);
  return (
    <article className="py-4">
      <header className="flex flex-wrap items-baseline gap-x-1.5 text-[13px]">
        <span className="font-medium text-droid-text">{comment.author}</span>
        {time ? <span className="text-droid-text-muted">· {time}</span> : null}
        {comment.state ? <span className="text-droid-text-muted">· {comment.state}</span> : null}
      </header>
      {location ? (
        <p className="mt-1 font-mono text-[11px] text-droid-text-muted">{location}</p>
      ) : null}
      {body ? (
        <div className="mt-2 text-droid-text-secondary [&_div]:!text-[13px] [&_div]:!leading-[1.55]">
          <Markdown allowGeneratedContent={false}>{body}</Markdown>
        </div>
      ) : null}
      <ReactionChips reactions={comment.reactions} />
    </article>
  );
}

function Timeline({
  comments,
  loading,
  error,
}: {
  comments: PrComment[];
  loading: boolean;
  error: string | null;
}) {
  if (comments.length === 0) {
    if (loading) {
      return <div className="mt-3 h-16 rounded-xl bg-droid-elevated/40" />;
    }
    if (error) {
      return <p className="mt-3 text-[13px] text-droid-text-muted">{error}</p>;
    }
    return <p className="mt-3 text-[13px] text-droid-text-muted">No comments yet</p>;
  }
  return (
    <div>
      {error ? <p className="mt-3 text-[13px] text-droid-text-muted">{error}</p> : null}
      {comments.map((comment) => (
        <CommentItem key={comment.id} comment={comment} />
      ))}
    </div>
  );
}

export function PrConversation({
  header,
  comments,
  loading,
  error,
  draft,
  posting,
  onDraftChange,
  onSubmit,
}: {
  header?: ReactNode;
  comments: PrComment[];
  loading: boolean;
  error: string | null;
  draft: string;
  posting: boolean;
  onDraftChange: (value: string) => void;
  onSubmit: () => void;
}) {
  const postingRef = useRef(false);

  useEffect(() => {
    if (!posting) postingRef.current = false;
  }, [posting]);

  const submit = () => {
    if (!draft.trim() || posting || postingRef.current) return;
    postingRef.current = true;
    onSubmit();
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="pr-workspace-scroll min-h-0 flex-1 overflow-y-auto px-8 py-6">
        {header}
        <Timeline comments={comments} loading={loading} error={error} />
      </div>
      <div className="px-8 pb-5">
        <div className="rounded-xl bg-droid-field p-2.5">
          <textarea
            value={draft}
            onChange={(event) => {
              onDraftChange(event.target.value);
            }}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                event.preventDefault();
                submit();
              }
            }}
            rows={3}
            placeholder="Comment on this PR…"
            className="w-full resize-none bg-transparent text-[13px] text-droid-text outline-none placeholder:text-droid-text-muted"
          />
          <div className="mt-1 flex justify-end">
            <button
              type="button"
              onClick={submit}
              disabled={!draft.trim() || posting}
              title="Comment (⌘⏎)"
              className="rounded-lg px-2 py-1 text-[11.5px] font-medium text-droid-text-muted transition-colors hover:text-droid-text disabled:opacity-40"
            >
              ⌘⏎
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
