import type { ReactNode } from 'react';
import { SIDEBAR_VISIBLE_SESSION_LIMIT } from '../lib/workspaces';
import type { SessionSummary } from '../types/bridge';

export interface SidebarSessionListProps {
  sessions: SessionSummary[];
  /** Rows to show before "Show more"; owned by the section, not this list. */
  visibleCount: number;
  activeAppSessionId: string | null;
  renderRow: (session: SessionSummary) => ReactNode;
  onShowMore: () => void;
  onShowLess: () => void;
  /** Pre-existing Droid sessions this folder has that were never sent. */
  earlierSessionCount?: number;
  onShowEarlier?: () => void;
}

const CONTROL_CLASS = 'text-[12px] text-droid-text-muted hover:text-droid-text transition-colors';

// Shows the latest sessions and tucks the rest behind "Show more". A folder
// that also has older pre-existing Droid sessions the sidecar withheld offers
// to load them once everything already loaded is on screen.
export function SidebarSessionList({
  sessions,
  visibleCount,
  activeAppSessionId,
  renderRow,
  onShowMore,
  onShowLess,
  earlierSessionCount = 0,
  onShowEarlier,
}: SidebarSessionListProps) {
  const count = Math.min(visibleCount, sessions.length);
  let visible = sessions.slice(0, count);
  // Keep the active session visible even if it sits below the paged window so
  // selecting an older chat never hides it on the next render.
  const active = activeAppSessionId
    ? sessions.find((session) => session.appSessionId === activeAppSessionId)
    : undefined;
  if (active && !visible.includes(active)) visible = [...visible, active];

  const remaining = sessions.length - count;
  const isExpanded = count > SIDEBAR_VISIBLE_SESSION_LIMIT;
  // Revealing also pages the window forward, otherwise the newly loaded
  // sessions land below it and the click looks like it did nothing.
  const showEarlier =
    remaining === 0 && earlierSessionCount > 0 && onShowEarlier
      ? () => {
          onShowEarlier();
          onShowMore();
        }
      : undefined;

  return (
    <div className="mt-0.5 space-y-0.5">
      {visible.map(renderRow)}
      {(remaining > 0 || isExpanded || showEarlier) && (
        <div className="flex items-center gap-3 pl-3 pr-2 pt-0.5">
          {remaining > 0 && (
            <button onClick={onShowMore} className={CONTROL_CLASS}>
              Show more
            </button>
          )}
          {isExpanded && (
            <button onClick={onShowLess} className={CONTROL_CLASS}>
              Show less
            </button>
          )}
          {showEarlier && (
            <button
              onClick={showEarlier}
              title="Load older Droid sessions already in this folder"
              className={CONTROL_CLASS}
            >
              Show {earlierSessionCount} earlier
            </button>
          )}
        </div>
      )}
    </div>
  );
}
