import { useCallback, useEffect, useRef, useState } from 'react';
import { detectPullRequest } from '../lib/github';
import type { PullRequest } from '../types/vcs';

export interface PullRequestState {
  pr: PullRequest | null;
  refresh: () => void;
}

const DETECT_MS = 20000;

// Detects the PR for the session's branch (the Context panel's PR row and the
// "Create pull request" action). Each detection spawns a `gh` child process, so this
// polls only while the window is visible. Checks, comments, and conversation
// detail belong to the PR workspace (features/pull-requests), which loads and
// polls them while open.
export function usePullRequest(
  cwd: string,
  branch: string | null,
  opts: { enabled: boolean },
): PullRequestState {
  const { enabled } = opts;
  const [pr, setPr] = useState<PullRequest | null>(null);
  const detectReq = useRef(0);

  const detect = useCallback(() => {
    // Bump first so any in-flight detection from a prior cwd/branch (or before
    // it was disabled) can no longer resolve and restore a stale PR.
    const id = ++detectReq.current;
    if (!enabled || !cwd) {
      setPr(null);
      return;
    }
    void detectPullRequest(cwd, branch ?? undefined).then((res) => {
      if (id !== detectReq.current) return;
      // A failed lookup (gh hiccup, network) keeps the last-known PR; only an
      // authoritative answer may replace or clear it. Keep the previous object
      // when the payload is unchanged so consumers aren't re-rendered on every
      // detection cycle.
      if (res.ok) {
        setPr((prev) =>
          prev && res.pr && JSON.stringify(prev) === JSON.stringify(res.pr) ? prev : res.pr,
        );
      }
    });
  }, [enabled, cwd, branch]);

  // Drop the previous session's PR the moment cwd/branch changes so the panel
  // never shows or acts on a stale PR while the new detection is in flight.
  useEffect(() => {
    detectReq.current++;
    setPr(null);
  }, [cwd, branch]);

  useEffect(() => {
    detect();
    if (!enabled) return;
    const tick = () => {
      if (!document.hidden) detect();
    };
    const interval = window.setInterval(tick, DETECT_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [detect, enabled]);

  return { pr, refresh: detect };
}
