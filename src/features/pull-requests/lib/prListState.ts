import type { PullRequestListResult } from '../../../types/vcs';
import { workspaceName } from '../../../lib/workspaces';
import { prBacklogId } from './prBacklog';
import type { InboxPullRequest } from './prInbox';

export interface InboxRepoError {
  cwd: string;
  repoName: string;
  message: string;
  reason?: string;
}

export interface PrListState {
  cwds: string[];
  generation: number;
  prs: InboxPullRequest[];
  viewerLogin: string | null;
  loading: boolean;
  loaded: boolean;
  error: string | null;
  repoErrors: InboxRepoError[];
}

export const initialPrListState: PrListState = {
  cwds: [],
  generation: 0,
  prs: [],
  viewerLogin: null,
  loading: false,
  loaded: false,
  error: null,
  repoErrors: [],
};

export type PrListEvent =
  | { type: 'bind'; cwds: string[] }
  | { type: 'load-start'; generation: number }
  | {
      type: 'load-success';
      generation: number;
      prs: InboxPullRequest[];
      viewerLogin: string | null;
      repoErrors: InboxRepoError[];
      error: string | null;
    }
  | { type: 'load-failure'; generation: number; message: string };

export function reducePrList(state: PrListState, event: PrListEvent): PrListState {
  if (event.type === 'bind') {
    return { ...initialPrListState, cwds: event.cwds, generation: state.generation + 1 };
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
      error: event.error,
      repoErrors: event.repoErrors,
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

export function mergePullRequestLists(entries: { cwd: string; result: PullRequestListResult }[]): {
  prs: InboxPullRequest[];
  viewerLogin: string | null;
  repoErrors: InboxRepoError[];
  error: string | null;
} {
  const prs: InboxPullRequest[] = [];
  const repoErrors: InboxRepoError[] = [];
  const seen = new Set<string>();
  let viewerLogin: string | null = null;
  let globalError: string | null = null;

  for (const { cwd, result } of entries) {
    const repoName = workspaceName(cwd);
    if (result.ok) {
      viewerLogin ??= result.viewerLogin;
      for (const pr of result.prs) {
        const item: InboxPullRequest = { ...pr, cwd, repoName };
        const id = prBacklogId(item);
        if (seen.has(id)) continue;
        seen.add(id);
        prs.push(item);
      }
      continue;
    }
    if (result.reason === 'gh_unavailable' || result.reason === 'not_desktop') {
      globalError = result.message ?? 'Could not load pull requests';
      continue;
    }
    repoErrors.push({
      cwd,
      repoName,
      message: result.message ?? 'Could not load pull requests',
      reason: result.reason,
    });
  }

  return {
    prs,
    viewerLogin,
    repoErrors,
    error: prs.length === 0 && repoErrors.length === 0 ? globalError : null,
  };
}
