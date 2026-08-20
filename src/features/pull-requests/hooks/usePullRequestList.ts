import { useCallback, useEffect, useLayoutEffect, useReducer, useRef } from 'react';

import { listPullRequests } from '../../../lib/github';
import { initialPrListState, reducePrList } from '../lib/prListState';

const POLL_MS = 20000;

export function usePullRequestList(cwd: string | null, enabled: boolean) {
  const [state, dispatch] = useReducer(reducePrList, initialPrListState);
  const generationRef = useRef(state.generation);
  // A poll and a manual refresh can be in flight together on one repository, so
  // only the newest request may settle: the generation alone cannot tell them
  // apart.
  const requestRef = useRef(0);

  const load = useCallback(
    (userInitiated: boolean) => {
      if (!cwd || !enabled) return;
      const generation = generationRef.current;
      requestRef.current += 1;
      const request = requestRef.current;
      if (userInitiated) {
        dispatch({ type: 'load-start', generation });
      }
      void listPullRequests(cwd).then((result) => {
        if (generation !== generationRef.current || request !== requestRef.current) return;
        if (result.ok) {
          dispatch({
            type: 'load-success',
            generation,
            prs: result.prs,
            viewerLogin: result.viewerLogin,
          });
          return;
        }
        dispatch({
          type: 'load-failure',
          generation,
          message: result.message ?? 'Could not load pull requests',
        });
      });
    },
    [cwd, enabled],
  );

  useLayoutEffect(() => {
    dispatch({ type: 'bind', cwd });
    generationRef.current += 1;
  }, [cwd]);

  useLayoutEffect(() => {
    if (!enabled || !cwd) return;
    dispatch({ type: 'load-start', generation: generationRef.current });
    load(false);
  }, [cwd, enabled, load]);

  useEffect(() => {
    if (!enabled || !cwd) return;
    const tick = () => {
      if (!document.hidden) load(false);
    };
    const interval = window.setInterval(tick, POLL_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [cwd, enabled, load]);

  const refresh = useCallback(() => {
    load(true);
  }, [load]);

  return {
    prs: state.prs,
    viewerLogin: state.viewerLogin,
    loading: state.loading,
    loaded: state.loaded,
    error: state.error,
    refresh,
  };
}
