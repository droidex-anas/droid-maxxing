import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import type { FeedItem } from '../../components/chatFeed';
import { toast } from '../../lib/toast';
import { TranscriptReachBar } from './TranscriptReachBar';
import { TranscriptReachChromeContext } from './transcriptReachContext';
import { useTranscriptReach } from './useTranscriptReach';

export function TranscriptReachHost({
  items,
  updateKind,
  rebuiltFromItemIndex,
  conversationKey,
  hasOlderHistory,
  isLoadingOlder,
  onLoadOlder,
  onScrollToRow,
  enabled,
  children,
}: {
  items: readonly FeedItem[];
  updateKind: 'full' | 'append' | 'prepend';
  rebuiltFromItemIndex: number;
  conversationKey: string | null;
  hasOlderHistory: boolean;
  isLoadingOlder: boolean;
  onLoadOlder: () => void;
  onScrollToRow: (rowId: string) => void;
  enabled: boolean;
  children: ReactNode;
}) {
  const { state, dispatch, activeRowId, matchRowIds, countLabel, scopeNotice, copyRange } =
    useTranscriptReach({
      items,
      updateKind,
      rebuiltFromItemIndex,
      conversationKey,
      hasOlderHistory,
      isLoadingOlder,
      onLoadOlder,
      onScrollToRow,
      enabled,
    });
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (copiedTimer.current) globalThis.clearTimeout(copiedTimer.current);
    },
    [],
  );

  const onSelectRangeRow = useCallback(
    (itemKey: string) => {
      dispatch({ type: 'selectRangeRow', itemKey });
    },
    [dispatch],
  );

  const chrome = useMemo(
    () => ({
      activeRowId,
      matchRowIds,
      rangeSelecting: state.rangeSelecting,
      rangeStartKey: state.rangeStartKey,
      rangeEndKey: state.rangeEndKey,
      onSelectRangeRow,
    }),
    [
      activeRowId,
      matchRowIds,
      onSelectRangeRow,
      state.rangeEndKey,
      state.rangeSelecting,
      state.rangeStartKey,
    ],
  );

  const onCopyRange = useCallback(() => {
    void copyRange().then((ok) => {
      if (!ok) {
        toast.error('Could not copy that range.');
        return;
      }
      toast.success('Copied conversation range.');
      setCopied(true);
      if (copiedTimer.current) globalThis.clearTimeout(copiedTimer.current);
      copiedTimer.current = globalThis.setTimeout(() => {
        copiedTimer.current = null;
        setCopied(false);
      }, 1200);
    });
  }, [copyRange]);

  return (
    <TranscriptReachChromeContext.Provider value={chrome}>
      {children}
      <div className="pointer-events-none absolute right-3 top-2 z-20">
        <TranscriptReachBar
          state={state}
          dispatch={dispatch}
          countLabel={countLabel}
          scopeNotice={scopeNotice}
          onLoadOlder={onLoadOlder}
          onCopyRange={onCopyRange}
          copied={copied}
        />
      </div>
    </TranscriptReachChromeContext.Provider>
  );
}
