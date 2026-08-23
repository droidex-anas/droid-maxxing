import { useEffect, useLayoutEffect, useRef } from 'react';
import { ArrowUp } from 'lucide-react';

import { GithubAvatar } from './GithubAvatar';

const MAX_HEIGHT = 200;

export function PrComposer({
  viewerLogin,
  draft,
  posting,
  onDraftChange,
  onSubmit,
}: {
  viewerLogin: string | null;
  draft: string;
  posting: boolean;
  onDraftChange: (value: string) => void;
  onSubmit: () => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const postingRef = useRef(false);

  useEffect(() => {
    if (!posting) postingRef.current = false;
  }, [posting]);

  // Grow with the draft instead of scrolling a three-row box, but never take
  // over the conversation.
  useLayoutEffect(() => {
    const node = textareaRef.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${String(Math.min(node.scrollHeight, MAX_HEIGHT))}px`;
  }, [draft]);

  const submit = () => {
    if (!draft.trim() || posting || postingRef.current) return;
    postingRef.current = true;
    onSubmit();
  };

  // Same shape as the chat composer: one rounded field with the author on the
  // left of its footer and a round accent send button on the right.
  return (
    <div className="rounded-2xl border border-droid-border bg-droid-elevated transition-colors focus-within:border-droid-border-hover">
      <textarea
        ref={textareaRef}
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
        rows={1}
        placeholder="Leave a comment"
        className="max-h-[200px] w-full resize-none bg-transparent px-3.5 pt-3 text-[13.5px] leading-[1.6] text-droid-text outline-none placeholder:text-droid-text-muted"
      />
      <div className="flex items-center gap-2 px-3 pb-2.5">
        <GithubAvatar login={viewerLogin} size={20} />
        <span className="min-w-0 flex-1 truncate text-[11px] text-droid-text-muted">
          {posting ? 'Posting…' : 'Markdown supported · ⌘⏎ to comment'}
        </span>
        <button
          type="button"
          onClick={submit}
          disabled={!draft.trim() || posting}
          title="Comment (⌘⏎)"
          aria-label="Comment"
          className="shrink-0 rounded-full p-2 text-droid-bg transition-opacity enabled:hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-25"
          style={{ background: 'var(--droid-accent)' }}
        >
          <ArrowUp className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
