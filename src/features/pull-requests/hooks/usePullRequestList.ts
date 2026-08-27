import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef } from 'react';

import { listPullRequests } from '../../../lib/github';
import { initialPrListState, mergePullRequestLists, reducePrList } from '../lib/prListState';

const POLL_MS = 20000;

export function usePullRequestList(cwds: string[], enabled: boolean) {
  const [state, dispatch] = useReducer(reducePrList, initialPrListState);
  const generationRef = useRef(state.generation);
  // A poll and a manual refresh can be in flight together, so only the newest
  // request may settle: the generation alone cannot tell them apart.
  const requestRef = useRef(0);
  const cwdsKey = cwds.join('\n');
  const listedCwds = useMemo(() => cwds, [cwdsKey]);

  const load = useCallback(
    (userInitiated: boolean) => {
      if (!enabled || listedCwds.length === 0) return;
      const generation = generationRef.current;
      requestRef.current += 1;
      const request = requestRef.current;
      if (userInitiated) {
        dispatch({ type: 'load-start', generation });
      }
      void Promise.all(
        listedCwds.map(async (cwd) => ({ cwd, result: await listPullRequests(cwd) })),
      ).then((entries) => {
        if (generation !== generationRef.current || request !== requestRef.current) return;
        const merged = mergePullRequestLists(entries);
        dispatch({
          type: 'load-success',
          generation,
          prs: merged.prs,
          viewerLogin: merged.viewerLogin,
          repoErrors: merged.repoErrors,
          error: merged.error,
        });
      });
    },
    [enabled, listedCwds],
  );

  // Losing the binding (no listable repositories) must invalidate any in-flight
  // request too, or re-enabling the same set renders its rows.
  useLayoutEffect(() => {
    dispatch({ type: 'bind', cwds: listedCwds });
    generationRef.current += 1;
  }, [cwdsKey, enabled, listedCwds]);

  useLayoutEffect(() => {
    if (!enabled || listedCwds.length === 0) return;
    dispatch({ type: 'load-start', generation: generationRef.current });
    load(false);
  }, [enabled, listedCwds, load]);

  useEffect(() => {
    if (!enabled || listedCwds.length === 0) return;
    const tick = () => {
      if (!document.hidden) load(false);
    };
    const interval = window.setInterval(tick, POLL_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [enabled, listedCwds, load]);

  const refresh = useCallback(() => {
    load(true);
  }, [load]);

  return {
    prs: state.prs,
    viewerLogin: state.viewerLogin,
    loading: state.loading,
    loaded: state.loaded,
    error: state.error,
    repoErrors: state.repoErrors,
    refresh,
  };
}
