import type { TranscriptFindMatch } from './transcriptFind';
import { cycleMatchIndex } from './transcriptFind';

export interface TranscriptReachState {
  open: boolean;
  query: string;
  committedQuery: string;
  matches: readonly TranscriptFindMatch[];
  activeIndex: number;
  rangeSelecting: boolean;
  rangeStartKey: string | null;
  rangeEndKey: string | null;
}

export type TranscriptReachAction =
  | { type: 'open' }
  | { type: 'close' }
  | { type: 'setQuery'; query: string }
  | { type: 'setMatches'; query: string; matches: readonly TranscriptFindMatch[] }
  | { type: 'next' }
  | { type: 'prev' }
  | { type: 'beginRange' }
  | { type: 'cancelRange' }
  | { type: 'selectRangeRow'; itemKey: string }
  | { type: 'setRangeBound'; bound: 'start' | 'end'; itemKey: string }
  | { type: 'resetConversation' };

export const INITIAL_TRANSCRIPT_REACH_STATE: TranscriptReachState = {
  open: false,
  query: '',
  committedQuery: '',
  matches: [],
  activeIndex: 0,
  rangeSelecting: false,
  rangeStartKey: null,
  rangeEndKey: null,
};

export function transcriptReachReducer(
  state: TranscriptReachState,
  action: TranscriptReachAction,
): TranscriptReachState {
  switch (action.type) {
    case 'open':
      return { ...state, open: true };
    case 'close':
      return { ...INITIAL_TRANSCRIPT_REACH_STATE };
    case 'setQuery':
      return { ...state, query: action.query };
    case 'setMatches':
      return applyMatches(state, action.query, action.matches);
    case 'next':
      if (state.matches.length === 0) return state;
      return { ...state, activeIndex: cycleMatchIndex(state.activeIndex, state.matches.length, 1) };
    case 'prev':
      if (state.matches.length === 0) return state;
      return {
        ...state,
        activeIndex: cycleMatchIndex(state.activeIndex, state.matches.length, -1),
      };
    case 'beginRange':
      return { ...state, open: true, rangeSelecting: true };
    case 'cancelRange':
      return { ...state, rangeSelecting: false, rangeStartKey: null, rangeEndKey: null };
    case 'selectRangeRow':
      return selectRangeRow(state, action.itemKey);
    case 'setRangeBound':
      return action.bound === 'start'
        ? { ...state, rangeSelecting: true, rangeStartKey: action.itemKey }
        : { ...state, rangeSelecting: true, rangeEndKey: action.itemKey };
    case 'resetConversation':
      return { ...INITIAL_TRANSCRIPT_REACH_STATE };
  }
}

export function orderedRangeKeys(
  startKey: string | null,
  endKey: string | null,
): { fromKey: string; toKey: string } | null {
  if (!startKey || !endKey) return null;
  return { fromKey: startKey, toKey: endKey };
}

function applyMatches(
  state: TranscriptReachState,
  query: string,
  matches: readonly TranscriptFindMatch[],
): TranscriptReachState {
  const previous = state.matches.at(state.activeIndex);
  const kept = previous
    ? matches.findIndex((match) => match.rowId === previous.rowId && match.start === previous.start)
    : -1;
  return {
    ...state,
    committedQuery: query,
    matches,
    activeIndex: kept >= 0 ? kept : 0,
  };
}

function selectRangeRow(state: TranscriptReachState, itemKey: string): TranscriptReachState {
  if (!state.rangeStartKey || state.rangeEndKey) {
    return { ...state, rangeSelecting: true, rangeStartKey: itemKey, rangeEndKey: null };
  }
  return { ...state, rangeStartKey: state.rangeStartKey, rangeEndKey: itemKey };
}
