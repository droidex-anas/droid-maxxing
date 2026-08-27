import type { FeedItem } from '../../components/chat';
import { feedRowId } from '../../hooks/conversationViewportAnchor';
import { copyTextForFeedItem } from './transcriptCopy';

export const TRANSCRIPT_FIND_DEBOUNCE_MS = 150;

export interface TranscriptSearchRow {
  rowId: string;
  itemKey: string;
  haystack: string;
  displayText: string;
}

export interface TranscriptSearchIndex {
  identity: string;
  rows: readonly TranscriptSearchRow[];
}

export interface TranscriptFindMatch {
  rowId: string;
  itemKey: string;
  start: number;
  end: number;
  snippet: string;
}

export function searchableTextForFeedItem(item: FeedItem): string {
  return copyTextForFeedItem(item);
}

export function projectTranscriptSearchIndex(
  previous: TranscriptSearchIndex | null,
  identity: string,
  items: readonly FeedItem[],
  updateKind: 'full' | 'append' | 'prepend',
  rebuiltFromItemIndex: number,
): TranscriptSearchIndex {
  if (!previous || previous.identity !== identity || updateKind === 'full') {
    return { identity, rows: items.map(searchRowForItem) };
  }
  if (updateKind === 'prepend') {
    const previousFirstKey = previous.rows[0]?.itemKey;
    const overlap = previousFirstKey
      ? items.findIndex((item) => item.key === previousFirstKey)
      : -1;
    if (overlap <= 0) return { identity, rows: items.map(searchRowForItem) };
    const prefix = items.slice(0, overlap).map(searchRowForItem);
    return { identity, rows: [...prefix, ...previous.rows] };
  }
  const start = Math.max(0, Math.min(rebuiltFromItemIndex, items.length, previous.rows.length));
  const prefix = previous.rows.slice(0, start);
  const suffix = items.slice(start).map(searchRowForItem);
  return { identity, rows: [...prefix, ...suffix] };
}

export function findTranscriptMatches(
  index: TranscriptSearchIndex,
  query: string,
): TranscriptFindMatch[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const matches: TranscriptFindMatch[] = [];
  for (const row of index.rows) {
    let from = 0;
    while (from < row.haystack.length) {
      const start = row.haystack.indexOf(needle, from);
      if (start < 0) break;
      const end = start + needle.length;
      matches.push({
        rowId: row.rowId,
        itemKey: row.itemKey,
        start,
        end,
        snippet: snippetAround(row.displayText, start, end),
      });
      from = end;
    }
  }
  return matches;
}

export function cycleMatchIndex(index: number, count: number, delta: number): number {
  if (count <= 0) return 0;
  return (index + delta + count * 8) % count;
}

export function formatFindCount(input: {
  activeIndex: number;
  matchCount: number;
  hasOlderHistory: boolean;
}): string {
  if (input.matchCount === 0) {
    return input.hasOlderHistory ? 'No matches in loaded history' : 'No matches';
  }
  const position = `${String(input.activeIndex + 1)} of ${String(input.matchCount)}`;
  return input.hasOlderHistory ? `${position} in loaded history` : position;
}

export function transcriptFindScopeNotice(input: {
  hasQuery: boolean;
  matchCount: number;
  hasOlderHistory: boolean;
  isLoadingOlder: boolean;
}): { kind: 'loading-older' | 'older-history'; empty: boolean } | null {
  if (!input.hasQuery || !input.hasOlderHistory) return null;
  if (input.isLoadingOlder) return { kind: 'loading-older', empty: input.matchCount === 0 };
  return { kind: 'older-history', empty: input.matchCount === 0 };
}

function searchRowForItem(item: FeedItem): TranscriptSearchRow {
  const displayText = searchableTextForFeedItem(item);
  return {
    rowId: feedRowId(item),
    itemKey: item.key,
    haystack: displayText.toLowerCase(),
    displayText,
  };
}

function snippetAround(text: string, start: number, end: number): string {
  const pad = 32;
  const from = Math.max(0, start - pad);
  const to = Math.min(text.length, end + pad);
  const prefix = from > 0 ? '…' : '';
  const suffix = to < text.length ? '…' : '';
  return `${prefix}${text.slice(from, to)}${suffix}`;
}
