import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';

import {
  getPrChecks,
  getPrComments,
  getPullRequestDiff,
  mergePullRequest,
  postPrComment,
  viewPullRequest,
} from '../../../lib/github';
import { toast } from '../../../lib/toast';
import type {
  PostCommentResult,
  PrChecksResult,
  PrCommentsResult,
  PrMergeMethod,
  PrMergeResult,
  PullRequestDetail,
  PullRequestViewResult,
} from '../../../types/vcs';
import {
  initialPrDetailState,
  reducePrDetail,
  type MetaSuccessFields,
  type PrDetailState,
} from '../lib/prDetailState';

const POLL_MS = 12000;

function sectionError(
  failed: boolean,
  message: string | undefined,
  fallback: string,
  showErrors: boolean,
  previous: string | null,
): string | null {
  if (!failed) return null;
  return showErrors ? (message ?? fallback) : previous;
}

function commentsSectionError(
  result: PrCommentsResult,
  showErrors: boolean,
  previous: string | null,
): string | null {
  if (result.ok) {
    return result.partial ? (result.message ?? 'Some PR comments could not be loaded') : null;
  }
  return sectionError(true, result.message, 'Could not load PR comments', showErrors, previous);
}

export function prevForSettledMeta(
  live: PrDetailState,
  cwd: string | null,
  number: number | null,
): PrDetailState {
  return live.cwd === cwd && live.number === number ? live : initialPrDetailState;
}

export function resolveMeta(
  generation: number,
  results: {
    view: PullRequestViewResult;
    checks: PrChecksResult;
    comments: PrCommentsResult;
  },
  prev: PrDetailState,
  showErrors: boolean,
): { pr: PullRequestDetail | null; event: MetaSuccessFields } {
  const viewRes = results.view;
  const checksRes = results.checks;
  const commentsRes = results.comments;
  const viewed = viewRes.ok ? viewRes.pr : null;
  return {
    pr: viewed,
    event: {
      generation,
      body: viewed ? viewed.body : prev.body,
      commits: viewed ? viewed.commits : prev.commits,
      checks: checksRes.ok ? checksRes.checks : prev.checks,
      comments: commentsRes.ok ? commentsRes.comments : prev.comments,
      checksError: sectionError(
        !checksRes.ok,
        checksRes.message,
        'Could not load PR checks',
        showErrors,
        prev.checksError,
      ),
      commentsError: commentsSectionError(commentsRes, showErrors, prev.commentsError),
      metaError: sectionError(
        !viewed,
        viewRes.message,
        'Could not load pull request',
        showErrors,
        prev.metaError,
      ),
    },
  };
}

export function usePullRequestDetail(
  cwd: string | null,
  number: number | null,
  options: { active: boolean; loadDiff: boolean },
) {
  const { active, loadDiff } = options;
  const [state, dispatch] = useReducer(reducePrDetail, initialPrDetailState);
  const [pr, setPr] = useState<PullRequestDetail | null>(null);
  const [merging, setMerging] = useState(false);
  const generationRef = useRef(state.generation);
  // The poll, a visibility tick, a manual refresh and the post-comment reload
  // can be in flight together on one pull request, so only the newest response
  // may settle: the generation alone cannot tell them apart.
  const metaRequestRef = useRef(0);
  const diffRequestRef = useRef(0);
  const stateRef = useRef(state);
  stateRef.current = state;

  const loadMeta = useCallback(
    (userInitiated: boolean) => {
      if (!cwd || number == null || !active) return;
      const generation = generationRef.current;
      metaRequestRef.current += 1;
      const request = metaRequestRef.current;
      if (userInitiated) dispatch({ type: 'meta-start', generation });
      void Promise.all([
        viewPullRequest(cwd, number),
        getPrChecks(cwd, number),
        getPrComments(cwd, number),
      ]).then(([viewRes, checksRes, commentsRes]) => {
        if (generation !== generationRef.current || request !== metaRequestRef.current) return;
        const live = stateRef.current;
        const prev = prevForSettledMeta(live, cwd, number);
        const showErrors = !prev.loaded || userInitiated;
        const resolved = resolveMeta(
          generation,
          { view: viewRes, checks: checksRes, comments: commentsRes },
          prev,
          showErrors,
        );
        if (resolved.pr) setPr(resolved.pr);
        dispatch({ type: 'meta-success', ...resolved.event });
      });
    },
    [active, cwd, number],
  );

  const loadDiffNow = useCallback(() => {
    if (!cwd || number == null) return;
    const generation = generationRef.current;
    diffRequestRef.current += 1;
    const request = diffRequestRef.current;
    dispatch({ type: 'diff-request', generation });
    void getPullRequestDiff(cwd, number).then((result) => {
      if (generation !== generationRef.current || request !== diffRequestRef.current) return;
      if (result.ok) {
        dispatch({ type: 'diff-success', generation, diff: result.diff });
        return;
      }
      dispatch({
        type: 'diff-failure',
        generation,
        message: result.message ?? 'Could not load pull request diff',
      });
    });
  }, [cwd, number]);

  useLayoutEffect(() => {
    dispatch({ type: 'bind', cwd, number });
    generationRef.current += 1;
    setPr(null);
    setMerging(false);
  }, [cwd, number]);

  useLayoutEffect(() => {
    if (!active || !cwd || number == null) return;
    dispatch({ type: 'meta-start', generation: generationRef.current });
    loadMeta(false);
  }, [active, cwd, loadMeta, number]);

  useEffect(() => {
    if (!active || !cwd || number == null) return;
    const tick = () => {
      if (!document.hidden) loadMeta(false);
    };
    const interval = window.setInterval(tick, POLL_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [active, cwd, loadMeta, number]);

  useEffect(() => {
    if (!loadDiff || !cwd || number == null || state.diffRequested) return;
    loadDiffNow();
  }, [cwd, loadDiff, loadDiffNow, number, state.diffRequested]);

  const refresh = useCallback(() => {
    loadMeta(true);
    if (stateRef.current.diffRequested) loadDiffNow();
  }, [loadDiffNow, loadMeta]);

  const submitComment = useCallback(
    async (body: string, successMessage = 'Comment posted'): Promise<PostCommentResult> => {
      if (!cwd || number == null) {
        return { ok: false, reason: 'error', message: 'Could not post comment' };
      }
      const generation = generationRef.current;
      try {
        const result = await postPrComment(cwd, number, body);
        if (!result.ok) {
          toast.error(result.message ?? 'Could not post comment');
          return result;
        }
        toast.success(successMessage);
        if (generation === generationRef.current) loadMeta(false);
        return result;
      } catch {
        toast.error('Could not post comment');
        return { ok: false, reason: 'error', message: 'Could not post comment' };
      }
    },
    [cwd, loadMeta, number],
  );

  // Merging is user-initiated and irreversible, so its outcome is always
  // reported; only the in-flight flag and the reload are dropped when the
  // workspace moved on to another pull request while gh was running.
  const merge = useCallback(
    async (method: PrMergeMethod): Promise<PrMergeResult> => {
      if (!cwd || number == null) {
        return { ok: false, reason: 'error', message: 'Could not merge pull request' };
      }
      const generation = generationRef.current;
      setMerging(true);
      const result = await mergePullRequest(cwd, number, method);
      if (result.ok) toast.success(`Pull request #${String(number)} merged`);
      else toast.error(result.message ?? 'Could not merge pull request');
      if (generation === generationRef.current) {
        setMerging(false);
        if (result.ok) loadMeta(true);
      }
      return result;
    },
    [cwd, loadMeta, number],
  );

  return {
    pr,
    body: state.body,
    commits: state.commits,
    checks: state.checks,
    comments: state.comments,
    checksError: state.checksError,
    commentsError: state.commentsError,
    metaError: state.metaError,
    diff: state.diff,
    diffError: state.diffError,
    diffRequested: state.diffRequested,
    loading: state.loading,
    loaded: state.loaded,
    merging,
    refresh,
    submitComment,
    merge,
  };
}
