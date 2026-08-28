import { createContext, useContext } from 'react';

export interface TranscriptReachChrome {
  activeRowId: string | null;
  matchRowIds: ReadonlySet<string>;
  rangeSelecting: boolean;
  rangeStartKey: string | null;
  rangeEndKey: string | null;
  onSelectRangeRow: (itemKey: string) => void;
}

const EMPTY_ROW_IDS: ReadonlySet<string> = new Set();

const DEFAULT_CHROME: TranscriptReachChrome = {
  activeRowId: null,
  matchRowIds: EMPTY_ROW_IDS,
  rangeSelecting: false,
  rangeStartKey: null,
  rangeEndKey: null,
  onSelectRangeRow: () => undefined,
};

export const TranscriptReachChromeContext = createContext<TranscriptReachChrome>(DEFAULT_CHROME);

export function useTranscriptReachChrome(): TranscriptReachChrome {
  return useContext(TranscriptReachChromeContext);
}

export function feedRowReachClassName(input: {
  rowId: string;
  itemKey: string;
  activeRowId: string | null;
  matchRowIds: ReadonlySet<string>;
  rangeStartKey: string | null;
  rangeEndKey: string | null;
}): string {
  const classes: string[] = [];
  if (input.matchRowIds.has(input.rowId)) classes.push('transcript-find-hit');
  if (input.activeRowId === input.rowId) classes.push('transcript-find-hit-active');
  if (input.rangeStartKey === input.itemKey || input.rangeEndKey === input.itemKey) {
    classes.push('transcript-range-bound');
  }
  return classes.join(' ');
}
