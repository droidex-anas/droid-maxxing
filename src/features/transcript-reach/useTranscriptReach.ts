import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';

import type { FeedItem } from '../../components/chat';
import {
  isTranscriptFindNextShortcut,
  isTranscriptFindPreviousShortcut,
  shouldOpenTranscriptFind,
} from '../../lib/keyboardShortcuts';
import { copyTextForFeedItemRange } from './transcriptCopy';
import {
  findTranscriptMatches,
  formatFindCount,
  projectTranscriptSearchIndex,
  TRANSCRIPT_FIND_DEBOUNCE_MS,
  transcriptFindScopeNotice,
  type TranscriptSearchIndex,
} from './transcriptFind';
import {
  orderedRangeKeys,
  transcriptReachReducer,
  INITIAL_TRANSCRIPT_REACH_STATE,
} from './transcriptReachState';

export interface UseTranscriptReachOptions {
  items: readonly FeedItem[];
  updateKind: 'full' | 'append' | 'prepend';
  rebuiltFromItemIndex: number;
  conversationKey: string | null;
  hasOlderHistory: boolean;
  isLoadingOlder: boolean;
  onLoadOlder: () => void;
  onScrollToRow: (rowId: string) => void;
  enabled: boolean;
  specOutlineOpen?: boolean;
  writeText?: (text: string) => Promise<void>;
}

export function useTranscriptReach({
  items,
  updateKind,
  rebuiltFromItemIndex,
  conversationKey,
  hasOlderHistory,
  isLoadingOlder,
  onLoadOlder,
  onScrollToRow,
  enabled,
  specOutlineOpen = false,
  writeText,
}: UseTranscriptReachOptions) {
  const [state, dispatch] = useReducer(transcriptReachReducer, INITIAL_TRANSCRIPT_REACH_STATE);
  const indexRef = useRef<TranscriptSearchIndex | null>(null);

  useEffect(() => {
    dispatch({ type: 'resetConversation' });
  }, [conversationKey]);

  const identity = conversationKey ?? 'none';
  const index = useMemo(
    () =>
      projectTranscriptSearchIndex(
        indexRef.current,
        identity,
        items,
        updateKind,
        rebuiltFromItemIndex,
      ),
    [identity, items, rebuiltFromItemIndex, updateKind],
  );
  indexRef.current = index;

  useEffect(() => {
    if (!enabled && state.open) dispatch({ type: 'close' });
  }, [enabled, state.open]);

  useEffect(() => {
    if (!state.open) return;
    const trimmed = state.query.trim();
    if (!trimmed) {
      dispatch({ type: 'setMatches', query: '', matches: [] });
      return;
    }
    const timer = globalThis.setTimeout(() => {
      dispatch({
        type: 'setMatches',
        query: trimmed,
        matches: findTranscriptMatches(index, trimmed),
      });
    }, TRANSCRIPT_FIND_DEBOUNCE_MS);
    return () => {
      globalThis.clearTimeout(timer);
    };
  }, [index, state.open, state.query]);

  const activeMatch = state.matches[state.activeIndex];
  const activeRowId = activeMatch?.rowId ?? null;
  useEffect(() => {
    if (!state.open || !activeRowId) return;
    onScrollToRow(activeRowId);
  }, [activeRowId, onScrollToRow, state.activeIndex, state.open]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        shouldOpenTranscriptFind(
          event,
          event.target,
          specOutlineOpen || Boolean(document.querySelector('[data-spec-outline]')),
        )
      ) {
        if (!enabled) return;
        event.preventDefault();
        if (event.repeat) return;
        dispatch({ type: 'open' });
        return;
      }
      if (!state.open) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        dispatch({ type: 'close' });
        return;
      }
      if (isTranscriptFindNextShortcut(event)) {
        event.preventDefault();
        dispatch({ type: 'next' });
        return;
      }
      if (isTranscriptFindPreviousShortcut(event)) {
        event.preventDefault();
        dispatch({ type: 'prev' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [enabled, specOutlineOpen, state.open]);

  const copyRange = useCallback(async () => {
    const keys = orderedRangeKeys(state.rangeStartKey, state.rangeEndKey);
    if (!keys) return false;
    const text = copyTextForFeedItemRange(items, keys.fromKey, keys.toKey);
    if (!text) return false;
    const clipboard = writeText ?? navigator.clipboard?.writeText.bind(navigator.clipboard);
    if (!clipboard) return false;
    await clipboard(text);
    return true;
  }, [items, state.rangeEndKey, state.rangeStartKey, writeText]);

  const matchRowIds = useMemo(
    () => new Set(state.matches.map((match) => match.rowId)),
    [state.matches],
  );

  return {
    state,
    dispatch,
    activeRowId,
    matchRowIds,
    countLabel: formatFindCount({
      activeIndex: state.activeIndex,
      matchCount: state.matches.length,
      hasOlderHistory,
    }),
    scopeNotice: transcriptFindScopeNotice({
      hasQuery: state.committedQuery.length > 0,
      matchCount: state.matches.length,
      hasOlderHistory,
      isLoadingOlder,
    }),
    onLoadOlder,
    copyRange,
  };
}
