import { useSidebarPagination } from '../hooks/useSidebarPagination';
import { useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import type { SessionSummary } from '../types/bridge';
import type { ChatMetadataMap, ChatPullRequest } from '../lib/chatMetadata';
import { prKind, prKindLabel } from '../lib/github';
import { PrStateIcon } from './environment/GithubIcons';
import { SidebarSessionList } from './SidebarSessionList';

interface Props {
  sessions: SessionSummary[];
  metadata: Partial<ChatMetadataMap>;
  activeAppSessionId: string | null;
  renderRow: (session: SessionSummary) => ReactNode;
  limit: number;
}

export function SidebarPullRequests({
  sessions,
  metadata,
  activeAppSessionId,
  renderRow,
  limit,
}: Props) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const { defaultVisibleCount, visibleCountFor, showMore, showLess } = useSidebarPagination(limit);
  const groups = new Map<string, { pr: ChatPullRequest; sessions: SessionSummary[] }>();
  const unlinked: SessionSummary[] = [];
  for (const session of sessions) {
    const links = metadata[session.appSessionId]?.pullRequests ?? [];
    if (links.length === 0) unlinked.push(session);
    for (const pr of links) {
      const group = groups.get(pr.url) ?? { pr, sessions: [] };
      group.sessions.push(session);
      groups.set(pr.url, group);
    }
  }
  const list = (key: string, rows: SessionSummary[]) => (
    <SidebarSessionList
      sessions={rows}
      activeAppSessionId={activeAppSessionId}
      renderRow={renderRow}
      visibleCount={visibleCountFor(key)}
      defaultVisibleCount={defaultVisibleCount}
      onShowMore={() => {
        showMore(key);
      }}
      onShowLess={() => {
        showLess(key);
      }}
    />
  );
  return (
    <div className="space-y-3">
      {groups.size === 0 && (
        <p className="px-3 py-1 text-[11px] leading-relaxed text-droid-text-muted">
          Pull requests are linked automatically from your chats’ worktrees.
        </p>
      )}
      {[...groups].map(([url, { pr, sessions: rows }]) => {
        const open = !collapsed.has(url);
        const kind = prKind(pr);
        return (
          <section key={url} aria-label={`PR #${String(pr.number)} ${pr.title}`}>
            <button
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] text-droid-text-secondary hover:bg-droid-elevated/40"
              title={`${url} · ${prKindLabel(kind)} (last detected)`}
              aria-expanded={open}
              onClick={() => {
                const next = new Set(collapsed);
                if (open) next.add(url);
                else next.delete(url);
                setCollapsed(next);
              }}
            >
              <ChevronRight
                className={`h-3 w-3 shrink-0 ${open ? 'rotate-90' : ''}`}
                strokeWidth={1.5}
              />
              <PrStateIcon kind={kind} size={14} />
              <span className="min-w-0 flex-1 truncate">
                #{pr.number} {pr.title}
              </span>
              <span className="shrink-0 text-[10px] text-droid-text-muted">
                {prKindLabel(kind)}
              </span>
            </button>
            {open && list(url, rows)}
          </section>
        );
      })}
      {unlinked.length > 0 && (
        <section aria-label="No linked PR">
          <h3 className="px-3 py-1 text-[11px] font-medium text-droid-text-muted">No linked PR</h3>
          {list('unlinked', unlinked)}
        </section>
      )}
    </div>
  );
}
