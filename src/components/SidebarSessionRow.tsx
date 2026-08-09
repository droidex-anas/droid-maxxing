import { memo, useEffect, useRef, useState } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { MAX_CHAT_TITLE_LENGTH } from '../lib/chatMetadata';
import { formatRelativeTime } from '../lib/time';
import { SESSION_MENU_WIDTH } from './SessionContextMenu';
import type { SessionSummary } from '../types/bridge';

// Simple, smooth ring spinner shown on the left of a row while its model works.
function WorkingSpinner() {
  return (
    <span
      className="w-3 h-3 rounded-full border-[1.5px] border-droid-text-muted/30 border-t-droid-text animate-spin"
      style={{ animationDuration: '1.5s' }}
      aria-label="working"
    />
  );
}

// Typing-style ellipsis shown in place of the timestamp while the model works.
function WorkingDots() {
  return (
    <span className="flex items-center gap-[3px]" aria-label="working">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="dot-pulse rounded-full bg-current"
          style={{ width: 3, height: 3, animationDelay: `${String(i * 0.16)}s` }}
        />
      ))}
    </span>
  );
}

export interface SessionRowProps {
  session: SessionSummary;
  // Effective title: the app-level rename override when set, else the
  // harness-generated title. Resolved by the parent (see lib/chatMetadata).
  title: string;
  active: boolean;
  unread: boolean;
  running: boolean;
  renaming: boolean;
  now: number;
  onSelect: (appSessionId: string) => void;
  onMenu: (appSessionId: string, position: { x: number; y: number }) => void;
  onRenameCommit: (appSessionId: string, title: string) => void;
  onRenameCancel: () => void;
}

export function areSessionRowPropsEqual(prev: SessionRowProps, next: SessionRowProps): boolean {
  return (
    prev.session.appSessionId === next.session.appSessionId &&
    prev.title === next.title &&
    prev.session.updatedAt === next.session.updatedAt &&
    prev.active === next.active &&
    prev.unread === next.unread &&
    prev.running === next.running &&
    prev.renaming === next.renaming &&
    prev.now === next.now &&
    prev.onSelect === next.onSelect &&
    prev.onMenu === next.onMenu &&
    prev.onRenameCommit === next.onRenameCommit &&
    prev.onRenameCancel === next.onRenameCancel
  );
}

// `running` is derived by the parent so this row can skip unrelated store updates.
export const SessionRow = memo(function SessionRow({
  session,
  title,
  active,
  unread,
  running,
  renaming,
  now,
  onSelect,
  onMenu,
  onRenameCommit,
  onRenameCancel,
}: SessionRowProps) {
  // Set once Enter/Escape settles the edit so the blur that follows the
  // input's unmount does not commit (or commit twice). Reset on every focus.
  const renameHandled = useRef(false);
  const titleRef = useRef<HTMLSpanElement>(null);
  const rowButtonRef = useRef<HTMLButtonElement>(null);
  const wasRenaming = useRef(false);
  const [marqueePx, setMarqueePx] = useState(0);
  const timeLabel = formatRelativeTime(session.updatedAt, now);

  // Return focus to the row when the inline editor closes, unless the user
  // already moved focus elsewhere (e.g. clicked another row).
  useEffect(() => {
    if (wasRenaming.current && !renaming && document.activeElement === document.body) {
      rowButtonRef.current?.focus();
    }
    wasRenaming.current = renaming;
  }, [renaming]);

  // A title longer than the sidebar rests truncated ("name…"); hovering the
  // row sweeps it left to reveal the full name, then slides back. The travel
  // distance and duration are per-row CSS vars measured on hover (fonts and
  // sidebar width can change between renders, so measure fresh every time).
  const handleMarqueeEnter = () => {
    const el = titleRef.current;
    if (!el || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const px = el.scrollWidth - el.clientWidth;
    if (px <= 4) return;
    el.style.setProperty('--title-marquee-x', `${String(-px)}px`);
    el.style.setProperty('--title-marquee-duration', `${String(Math.min(10, 2.5 + px / 50))}s`);
    setMarqueePx(px);
  };
  const handleMarqueeLeave = () => {
    setMarqueePx(0);
    const el = titleRef.current;
    el?.style.removeProperty('--title-marquee-x');
    el?.style.removeProperty('--title-marquee-duration');
  };
  const marquee = marqueePx > 0;
  // Scale the right-edge fade with the overflow so a barely-overflowing title
  // is not revealed entirely inside the faded zone.
  const marqueeFade = Math.min(20, Math.max(6, Math.round(marqueePx / 2)));

  // Rename mode swaps the row for an inline editor: Enter/blur commits, Escape
  // cancels. A blank commit clears the override (back to the generated title).
  if (renaming) {
    return (
      <div className="flex items-center gap-2.5 pl-3 pr-2 py-1.5">
        <span className="w-3 shrink-0" />
        <input
          autoFocus
          defaultValue={title}
          maxLength={MAX_CHAT_TITLE_LENGTH}
          aria-label={`Rename ${title}`}
          onFocus={(e) => {
            renameHandled.current = false;
            e.currentTarget.select();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              renameHandled.current = true;
              onRenameCommit(session.appSessionId, e.currentTarget.value);
            } else if (e.key === 'Escape') {
              // The menu closes before rename starts, so no other escape layer
              // is open and this Escape always reaches the input.
              renameHandled.current = true;
              onRenameCancel();
            }
          }}
          onBlur={(e) => {
            if (!renameHandled.current) onRenameCommit(session.appSessionId, e.currentTarget.value);
          }}
          className="min-w-0 flex-1 rounded-md bg-droid-elevated px-1.5 py-0.5 text-[13px] text-droid-text ring-1 ring-droid-accent/50 focus:outline-none"
        />
      </div>
    );
  }

  return (
    <div
      className="group relative"
      onMouseEnter={handleMarqueeEnter}
      onMouseLeave={handleMarqueeLeave}
    >
      <button
        ref={rowButtonRef}
        data-testid="session-row"
        data-app-session-id={session.appSessionId}
        aria-current={active ? 'true' : undefined}
        onClick={() => {
          onSelect(session.appSessionId);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          onMenu(session.appSessionId, { x: e.clientX, y: e.clientY });
        }}
        className={`w-full flex items-center gap-2.5 pl-3 pr-2 py-1.5 rounded-xl text-left transition-colors ${
          active ? 'bg-droid-active' : 'hover:bg-droid-elevated/40'
        }`}
      >
        <span
          className={`w-3 flex items-center justify-center shrink-0 ${active ? 'text-droid-text' : 'text-droid-text-secondary group-hover:text-droid-text'}`}
        >
          {running && <WorkingSpinner />}
        </span>
        {unread && <span className="sr-only">Unread:</span>}
        <span
          className="min-w-0 flex-1 overflow-hidden"
          style={
            marquee
              ? // Fade the right edge so the sliding title never collides
                // with the hover "..." button.
                {
                  maskImage: `linear-gradient(to right, black calc(100% - ${String(marqueeFade)}px), transparent)`,
                  WebkitMaskImage: `linear-gradient(to right, black calc(100% - ${String(marqueeFade)}px), transparent)`,
                }
              : undefined
          }
        >
          <span
            ref={titleRef}
            className={`block text-[13px] ${marquee ? 'title-marquee whitespace-nowrap' : 'truncate'} ${
              active
                ? 'text-droid-text'
                : unread
                  ? 'text-droid-text font-semibold'
                  : 'text-droid-text-secondary group-hover:text-droid-text'
            }`}
          >
            {title}
          </span>
        </span>
        {running ? (
          // Dots replace the timestamp while the model works; they hide on
          // hover like the timestamp so the "..." trigger stays reachable.
          <span className="shrink-0 text-droid-text-secondary group-hover:invisible group-focus-within:invisible">
            <WorkingDots />
          </span>
        ) : (
          timeLabel && (
            <span
              className={`shrink-0 text-[10.5px] tabular-nums group-hover:invisible group-focus-within:invisible ${
                unread ? 'text-droid-text font-medium' : 'text-droid-text-muted'
              }`}
            >
              {timeLabel}
            </span>
          )
        )}
      </button>
      {/* On hover the timestamp becomes the "..." menu trigger (rename, pin,
          archive). It stays tabbable while hidden so keyboard users can reach
          it; opacity (not display) keeps it in the tab order. */}
      <button
        type="button"
        aria-label={`Actions for ${title}`}
        title="Chat actions"
        onClick={(e) => {
          e.stopPropagation();
          const rect = e.currentTarget.getBoundingClientRect();
          onMenu(session.appSessionId, { x: rect.right - SESSION_MENU_WIDTH, y: rect.bottom + 4 });
        }}
        className="absolute right-1.5 top-1/2 -translate-y-1/2 flex w-5 h-5 items-center justify-center rounded-md text-droid-text-muted opacity-0 pointer-events-none transition-opacity hover:bg-droid-elevated hover:text-droid-text group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 focus-visible:outline-none"
      >
        <MoreHorizontal className="w-4 h-4" />
      </button>
    </div>
  );
}, areSessionRowPropsEqual);
