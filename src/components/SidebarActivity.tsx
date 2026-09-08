import { useSidebarPagination } from '../hooks/useSidebarPagination';
import { useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import type { SessionSummary } from '../types/bridge';
import { ACTIVITY_GROUPS, type SessionActivityStatus } from '../lib/sidebarActivity';
import { SidebarSessionList } from './SidebarSessionList';

interface Props {
  sessions: SessionSummary[];
  activeAppSessionId: string | null;
  statusFor: (session: SessionSummary) => SessionActivityStatus;
  renderRow: (session: SessionSummary) => ReactNode;
  limit: number;
  showSettled: boolean;
  // Chats aged out of the inbox; they stay reachable from Workspaces.
  hiddenCount: number;
}

// An inbox: chats grouped by what they need from the user, most urgent first.
// Rows and chat actions are shared with workspace browsing.
export function SidebarActivity({
  sessions,
  activeAppSessionId,
  statusFor,
  renderRow,
  limit,
  showSettled,
  hiddenCount,
}: Props) {
  const [settledOpen, setSettledOpen] = useState(false);
  const { defaultVisibleCount, visibleCountFor, showMore, showLess } = useSidebarPagination(limit);
  return (
    <div className="space-y-3">
      {sessions.length === 0 && (
        <p className="px-3 py-2 text-[12px] text-droid-text-muted">
          {hiddenCount > 0 ? 'Nothing to show right now.' : 'No tasks match this view.'}
        </p>
      )}
      {ACTIVITY_GROUPS.map((group) => {
        const rows = sessions.filter((session) => group.statuses.includes(statusFor(session)));
        if (rows.length === 0) return null;
        const isSettled = group.label === 'Settled';
        const open = !isSettled || settledOpen || showSettled;
        const heading = (
          <>
            <span className="flex-1">{group.label}</span>
            <span className="tabular-nums">{rows.length}</span>
          </>
        );
        return (
          <section key={group.label} aria-label={group.label}>
            {isSettled && !showSettled ? (
              <button
                onClick={() => {
                  setSettledOpen(!settledOpen);
                }}
                aria-expanded={open}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-1 text-left text-[11px] font-medium text-droid-text-muted hover:text-droid-text"
              >
                <ChevronRight
                  className={`h-3 w-3 transition-transform ${open ? 'rotate-90' : ''}`}
                  strokeWidth={1.5}
                />
                {heading}
              </button>
            ) : (
              <h3 className="flex items-center gap-2 px-3 py-1 text-[11px] font-medium text-droid-text-muted">
                {heading}
              </h3>
            )}
            {open && (
              <SidebarSessionList
                sessions={rows}
                activeAppSessionId={activeAppSessionId}
                visibleCount={visibleCountFor(group.label)}
                defaultVisibleCount={defaultVisibleCount}
                renderRow={renderRow}
                onShowMore={() => {
                  showMore(group.label);
                }}
                onShowLess={() => {
                  showLess(group.label);
                }}
              />
            )}
          </section>
        );
      })}
      {hiddenCount > 0 && (
        <p className="px-3 pt-1 text-[11px] text-droid-text-muted/70">
          {String(hiddenCount)} older {hiddenCount === 1 ? 'chat lives' : 'chats live'} in
          Workspaces.
        </p>
      )}
    </div>
  );
}
