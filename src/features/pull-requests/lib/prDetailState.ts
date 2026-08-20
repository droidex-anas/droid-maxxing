import type { PrCheck, PrComment, PrCommit } from '../../../types/vcs';

export interface PrDetailState {
  cwd: string | null;
  number: number | null;
  generation: number;
  body: string;
  commits: PrCommit[];
  checks: PrCheck[];
  comments: PrComment[];
  checksError: string | null;
  commentsError: string | null;
  metaError: string | null;
  diff: string | null;
  diffError: string | null;
  diffRequested: boolean;
  loading: boolean;
  loaded: boolean;
}

export const initialPrDetailState: PrDetailState = {
  cwd: null,
  number: null,
  generation: 0,
  body: '',
  commits: [],
  checks: [],
  comments: [],
  checksError: null,
  commentsError: null,
  metaError: null,
  diff: null,
  diffError: null,
  diffRequested: false,
  loading: false,
  loaded: false,
};

export interface MetaSuccessFields {
  generation: number;
  body: string;
  commits: PrCommit[];
  checks: PrCheck[];
  comments: PrComment[];
  checksError: string | null;
  commentsError: string | null;
  metaError?: string | null;
}

export type PrDetailEvent =
  | { type: 'bind'; cwd: string | null; number: number | null }
  | { type: 'meta-start'; generation: number }
  | ({ type: 'meta-success' } & MetaSuccessFields)
  | { type: 'meta-failure'; generation: number; message: string }
  | { type: 'diff-request'; generation: number }
  | { type: 'diff-success'; generation: number; diff: string }
  | { type: 'diff-failure'; generation: number; message: string };

export function reducePrDetail(state: PrDetailState, event: PrDetailEvent): PrDetailState {
  if (event.type === 'bind') {
    return {
      ...initialPrDetailState,
      cwd: event.cwd,
      number: event.number,
      generation: state.generation + 1,
    };
  }
  if (event.type === 'meta-start' || event.type === 'diff-request') {
    if (event.generation < state.generation) return state;
    return event.type === 'meta-start'
      ? { ...state, generation: event.generation, loading: true }
      : { ...state, generation: event.generation, diffRequested: true, diffError: null };
  }
  if (event.generation !== state.generation) return state;
  if (event.type === 'meta-success') {
    return {
      ...state,
      loading: false,
      loaded: true,
      metaError: event.metaError ?? null,
      body: event.body,
      commits: event.commits,
      checks: event.checks,
      comments: event.comments,
      checksError: event.checksError,
      commentsError: event.commentsError,
    };
  }
  if (event.type === 'meta-failure') {
    return { ...state, loading: false, loaded: true, metaError: event.message };
  }
  if (!state.diffRequested) return state;
  if (event.type === 'diff-success') {
    return { ...state, diff: event.diff, diffError: null };
  }
  return { ...state, diffError: event.message };
}
