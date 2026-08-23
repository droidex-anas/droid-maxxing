import type { PullRequest } from '../../../types/vcs';

export interface PrListState {
  cwd: string | null;
  generation: number;
  prs: PullRequest[];
  viewerLogin: string | null;
  loading: boolean;
  loaded: boolean;
  error: string | null;
}

export const initialPrListState: PrListState = {
  cwd: null,
  generation: 0,
  prs: [],
  viewerLogin: null,
  loading: false,
  loaded: false,
  error: null,
};

export type PrListEvent =
  | { type: 'bind'; cwd: string | null }
  | { type: 'load-start'; generation: number }
  | {
      type: 'load-success';
      generation: number;
      prs: PullRequest[];
      viewerLogin: string | null;
    }
  | { type: 'load-failure'; generation: number; message: string };

export function reducePrList(state: PrListState, event: PrListEvent): PrListState {
  if (event.type === 'bind') {
    return { ...initialPrListState, cwd: event.cwd, generation: state.generation + 1 };
  }
  // load-start may adopt a newer generation so a load can begin without bind.
  if (event.type === 'load-start') {
    if (event.generation < state.generation) return state;
    return { ...state, generation: event.generation, loading: true };
  }
  if (event.generation !== state.generation) return state;
  if (event.type === 'load-success') {
    return {
      ...state,
      loading: false,
      loaded: true,
      error: null,
      prs: event.prs,
      viewerLogin: event.viewerLogin,
    };
  }
  return {
    ...state,
    loading: false,
    loaded: true,
    error: event.message,
  };
}
