import { useEffect, useRef, type Dispatch, type ReactNode } from 'react';
import { ChevronDown, ChevronUp, Copy, Search, X } from 'lucide-react';

import type { TranscriptReachAction, TranscriptReachState } from './transcriptReachState';
import type { transcriptFindScopeNotice } from './transcriptFind';

export function TranscriptReachBar({
  state,
  dispatch,
  countLabel,
  scopeNotice,
  onLoadOlder,
  onCopyRange,
  copied,
}: {
  state: TranscriptReachState;
  dispatch: Dispatch<TranscriptReachAction>;
  countLabel: string;
  scopeNotice: ReturnType<typeof transcriptFindScopeNotice>;
  onLoadOlder: () => void;
  onCopyRange: () => void;
  copied: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!state.open) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [state.open]);

  if (!state.open) return null;

  const onSubmit = (event: { preventDefault(): void }) => {
    event.preventDefault();
    dispatch({ type: 'next' });
  };

  const rangeReady = Boolean(state.rangeStartKey && state.rangeEndKey);
  const hasQuery = state.query.trim().length > 0;

  return (
    <div
      role="search"
      data-testid="transcript-find-bar"
      className="pointer-events-auto flex max-w-[min(100%,42rem)] flex-col gap-1.5 rounded-xl border border-droid-border bg-droid-surface/95 px-2 py-1.5 shadow-lg shadow-black/30 backdrop-blur"
    >
      <form onSubmit={onSubmit} className="flex items-center gap-1.5">
        <Search className="h-3.5 w-3.5 shrink-0 text-droid-text-muted/70" />
        <input
          ref={inputRef}
          data-testid="transcript-find-input"
          value={state.query}
          onChange={(event) => {
            dispatch({ type: 'setQuery', query: event.target.value });
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && event.shiftKey) {
              event.preventDefault();
              dispatch({ type: 'prev' });
            }
          }}
          placeholder="Find in conversation"
          aria-label="Find in conversation"
          className="min-w-0 flex-1 bg-transparent text-[12.5px] text-droid-text placeholder-droid-text-muted/50 focus:outline-none"
        />
        <span
          data-testid="transcript-find-count"
          className="shrink-0 text-[11px] tabular-nums text-droid-text-muted"
        >
          {hasQuery ? countLabel : ''}
        </span>
        <IconButton
          testId="transcript-find-prev"
          title="Previous match"
          disabled={!hasQuery || state.matches.length === 0}
          onClick={() => {
            dispatch({ type: 'prev' });
          }}
        >
          <ChevronUp className="h-3.5 w-3.5" />
        </IconButton>
        <IconButton
          testId="transcript-find-next"
          title="Next match"
          disabled={!hasQuery || state.matches.length === 0}
          onClick={() => {
            dispatch({ type: 'next' });
          }}
        >
          <ChevronDown className="h-3.5 w-3.5" />
        </IconButton>
        <IconButton
          testId="transcript-range-toggle"
          title="Copy a range of messages"
          active={state.rangeSelecting}
          onClick={() => {
            dispatch({ type: state.rangeSelecting ? 'cancelRange' : 'beginRange' });
          }}
        >
          <Copy className="h-3.5 w-3.5" />
        </IconButton>
        <IconButton
          testId="transcript-find-close"
          title="Close"
          onClick={() => {
            dispatch({ type: 'close' });
          }}
        >
          <X className="h-3.5 w-3.5" />
        </IconButton>
      </form>
      {scopeNotice && (
        <div
          role="status"
          data-testid="transcript-find-scope"
          className="flex flex-wrap items-center gap-2 px-1 text-[11px] text-droid-text-muted"
        >
          <span>{scopeNoticeMessage(scopeNotice)}</span>
          {scopeNotice.kind === 'older-history' && (
            <button
              type="button"
              data-testid="transcript-find-load-older"
              onClick={onLoadOlder}
              className="rounded-md border border-droid-border px-1.5 py-0.5 text-[11px] text-droid-text-secondary transition-colors hover:bg-droid-elevated/60"
            >
              Load older history
            </button>
          )}
        </div>
      )}
      {state.rangeSelecting && (
        <div
          data-testid="transcript-range-bar"
          className="flex flex-wrap items-center gap-2 px-1 text-[11px] text-droid-text-muted"
        >
          <span>{rangePrompt(rangeReady, state.rangeStartKey)}</span>
          {activeMatchActions(state, dispatch)}
          <button
            type="button"
            data-testid="transcript-range-copy"
            disabled={!rangeReady}
            onClick={onCopyRange}
            className="rounded-md border border-droid-border px-1.5 py-0.5 text-[11px] text-droid-text-secondary transition-colors hover:bg-droid-elevated/60 disabled:opacity-40"
          >
            {copied ? 'Copied' : 'Copy range'}
          </button>
        </div>
      )}
    </div>
  );
}

function activeMatchActions(
  state: TranscriptReachState,
  dispatch: Dispatch<TranscriptReachAction>,
) {
  const match = state.matches.at(state.activeIndex);
  if (!match) return null;
  return (
    <>
      <button
        type="button"
        data-testid="transcript-range-from-match-start"
        onClick={() => {
          dispatch({ type: 'setRangeBound', bound: 'start', itemKey: match.itemKey });
        }}
        className="rounded-md border border-droid-border px-1.5 py-0.5 text-[11px] text-droid-text-secondary transition-colors hover:bg-droid-elevated/60"
      >
        Start at match
      </button>
      <button
        type="button"
        data-testid="transcript-range-from-match-end"
        onClick={() => {
          dispatch({ type: 'setRangeBound', bound: 'end', itemKey: match.itemKey });
        }}
        className="rounded-md border border-droid-border px-1.5 py-0.5 text-[11px] text-droid-text-secondary transition-colors hover:bg-droid-elevated/60"
      >
        End at match
      </button>
    </>
  );
}

function IconButton({
  title,
  onClick,
  children,
  disabled,
  active,
  testId,
}: {
  title: string;
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
  active?: boolean;
  testId: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className={`rounded-md p-1 text-droid-text-muted transition-colors hover:bg-droid-elevated/70 hover:text-droid-text disabled:opacity-40 ${
        active ? 'bg-droid-accent/15 text-droid-text' : ''
      }`}
    >
      {children}
    </button>
  );
}

function scopeNoticeMessage(
  notice: NonNullable<ReturnType<typeof transcriptFindScopeNotice>>,
): string {
  if (notice.kind === 'loading-older') return 'Loading older history…';
  if (notice.empty) return 'Older history isn’t loaded, so this can miss earlier turns.';
  return 'Showing matches in loaded history. Older turns may also match.';
}

function rangePrompt(rangeReady: boolean, rangeStartKey: string | null): string {
  if (rangeReady) return 'Range selected from conversation state.';
  if (rangeStartKey) return 'Click the last message to copy.';
  return 'Click the first message, then the last.';
}
