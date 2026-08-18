import { useCallback, useEffect, useLayoutEffect, useReducer, useRef } from 'react';

import { listPullRequests } from '../../../lib/github';
import { initialPrListState, reducePrList } from '../lib/prListState';

const POLL_MS = 20000;

export function usePullRequestList(cwd: string | null, enabled: boolean) {
  const [state, dispatch] = useReducer(reducePrList, initialPrListState);
  const generationRef = useRef(state.generation);

  const load = useCallback(
    (userInitiated: boolean) => {
      if (!cwd || !enabled) return;
      const generation = generationRef.current;
      if (userInitiated) {
        dispatch({ type: 'load-start', generation });
      }
      void listPullRequests(cwd).then((result) => {
        if (generation !== generationRef.current) return;
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
