import { useMemo, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { useSidebarContentSearch } from '../hooks/useSidebarContentSearch';
import { shallowEqual, useStoreSelector } from '../hooks/useStore';
import { chatDisplayTitle, isChatHidden } from '../lib/chatMetadata';
import { sidebarSearchNotice } from '../lib/sidebarSearchStatus';
import { formatRelativeTime } from '../lib/time';
import type { SessionSearchMatch, SessionSummary } from '../types/bridge';
import PaletteShell from './PaletteShell';
import SidebarSearchNotice from './SidebarSearchNotice';
import { usePaletteNavigation } from './usePaletteNavigation';

interface SearchEntry {
  session: SessionSummary;
  matches: SessionSearchMatch[];
}

const MAX_ENTRIES = 12;
const RECENT_ENTRIES = 8;
const SNIPPETS_PER_ROW = 2;

export default function SidebarSearch({
  onClose,
  onOpen,
}: {
  onClose: () => void;
  onOpen: (appSessionId: string) => void;
}) {
  const state = useStoreSelector(
    (current) => ({
      chatMetadata: current.chatMetadata,
      sessionOrder: current.sessionOrder,
      sessions: current.sessions,
    }),
    shallowEqual,
  );
  const [query, setQuery] = useState('');
  const { pending, contentResults, searchUnavailable, indexingIncomplete } =
    useSidebarContentSearch(query);

  const entries = useMemo<SearchEntry[]>(() => {
    const sessions = state.sessionOrder
      .map((id) => state.sessions[id])
      .filter((s): s is SessionSummary => Boolean(s))
      .filter((s) => !isChatHidden(state.chatMetadata[s.appSessionId]))
      .map((s) => {
        const title = chatDisplayTitle(s, state.chatMetadata[s.appSessionId]);
        return title === s.title ? s : { ...s, title };
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) {
      return sessions.slice(0, RECENT_ENTRIES).map((session) => ({ session, matches: [] }));
    }
    const byId = new Map<string, SearchEntry>();
    for (const session of sessions) {
      const titleHit = session.title.toLowerCase().includes(trimmed);
      const contentMatches = contentResults.get(session.appSessionId);
      if (!titleHit && !contentMatches) continue;
      byId.set(session.appSessionId, { session, matches: contentMatches ?? [] });
    }
    return [...byId.values()].slice(0, MAX_ENTRIES);
  }, [query, state.sessionOrder, state.sessions, state.chatMetadata, contentResults]);

  const open = (entry: SearchEntry) => {
    onOpen(entry.session.appSessionId);
    onClose();
  };

  const { selected, setSelected, handleKeyDown } = usePaletteNavigation(
    query,
    entries,
    open,
    onClose,
  );

  const now = Date.now();
  const trimmed = query.trim();
  const notice = sidebarSearchNotice({
    queryLength: trimmed.length,
    pending,
    searchUnavailable,
    indexingIncomplete,
    entryCount: entries.length,
  });

  return (
    <PaletteShell
      onClose={onClose}
      query={query}
      onQueryChange={setQuery}
      onKeyDown={handleKeyDown}
      placeholder="Search sessions and messages..."
      inputAriaLabel="Search sessions and messages"
      enterHint="Open session"
      footerRight={trimmed ? 'Titles and message text' : 'Recent sessions'}
    >
      {notice ? <SidebarSearchNotice kind={notice.kind} layout={notice.layout} /> : null}
      {entries.map((entry, i) => (
        <button
          key={entry.session.appSessionId}
          data-testid="sidebar-search-result"
          onMouseEnter={() => {
            setSelected(i);
          }}
          onClick={() => {
            open(entry);
          }}
          className={`w-full flex items-start gap-3 px-4 py-2.5 text-left transition-colors ${
            i === selected ? 'bg-droid-accent/10' : 'hover:bg-droid-surface'
          }`}
        >
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-sm text-droid-text">
                {entry.session.title}
              </span>
              <span className="shrink-0 text-[10.5px] tabular-nums text-droid-text-muted">
                {formatRelativeTime(entry.session.updatedAt, now)}
              </span>
            </span>
            {entry.matches.slice(0, SNIPPETS_PER_ROW).map((m, j) => (
              <span key={j} className="block truncate text-[12px] text-droid-text-muted mt-0.5">
                {m.author === 'user' ? 'You: ' : ''}
                {m.snippet}
              </span>
            ))}
          </span>
          {i === selected && <ArrowRight className="w-3.5 h-3.5 mt-1 shrink-0 text-droid-accent" />}
        </button>
      ))}
    </PaletteShell>
  );
}
