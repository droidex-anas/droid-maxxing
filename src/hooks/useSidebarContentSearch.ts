import { useEffect, useRef, useState } from 'react';

import { bridge } from '../lib/bridge';
import { searchSessions } from '../lib/commands';
import { useHistoryHealth } from './useHistoryHealth';
import { SIDEBAR_CONTENT_SEARCH_MIN_QUERY } from '../lib/sidebarSearchStatus';
import type { SessionSearchMatch } from '../types/bridge';

const DEBOUNCE_MS = 250;

export function useSidebarContentSearch(query: string): {
  pending: boolean;
  contentResults: ReadonlyMap<string, SessionSearchMatch[]>;
  searchUnavailable: boolean;
  indexingIncomplete: boolean;
} {
  const historyHealth = useHistoryHealth();
  const [contentResults, setContentResults] = useState<ReadonlyMap<string, SessionSearchMatch[]>>(
    new Map(),
  );
  const [searchPending, setSearchPending] = useState(false);
  const [indexingIncomplete, setIndexingIncomplete] = useState(false);
  const [requestUnavailable, setRequestUnavailable] = useState(false);
  const requestSeq = useRef(0);
  const latestRequestId = useRef<string | null>(null);
  const instanceId = useRef(Math.random().toString(36).slice(2));
  const searchUnavailable = historyHealth.search === 'unavailable' || requestUnavailable;

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < SIDEBAR_CONTENT_SEARCH_MIN_QUERY) {
      latestRequestId.current = null;
      setSearchPending(false);
      setContentResults(new Map());
      setIndexingIncomplete(false);
      setRequestUnavailable(false);
      return;
    }
    if (historyHealth.search === 'unavailable') {
      latestRequestId.current = null;
      setSearchPending(false);
      setContentResults(new Map());
      setIndexingIncomplete(false);
      return;
    }
    const requestId = `sidebar-search-${instanceId.current}-${String(++requestSeq.current)}`;
    latestRequestId.current = requestId;
    setSearchPending(true);
    setRequestUnavailable(false);
    setIndexingIncomplete(false);
    const timer = setTimeout(() => {
      searchSessions(requestId, trimmed);
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [historyHealth.search, query]);

  useEffect(() => {
    return bridge.subscribe((ev) => {
      if (ev.type === 'sessions.searchResults') {
        if (ev.requestId !== latestRequestId.current) return;
        setSearchPending(false);
        setRequestUnavailable(false);
        setIndexingIncomplete(ev.indexingIncomplete);
        setContentResults(new Map(ev.results.map((r) => [r.appSessionId, r.matches])));
        return;
      }
      if (ev.type !== 'error' || ev.code !== 'history.search_unavailable') return;
      if (ev.requestId !== latestRequestId.current) return;
      setSearchPending(false);
      setRequestUnavailable(true);
      setIndexingIncomplete(false);
      setContentResults(new Map());
    });
  }, []);

  return {
    pending: searchPending,
    contentResults,
    searchUnavailable,
    indexingIncomplete,
  };
}
