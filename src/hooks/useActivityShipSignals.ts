import { useEffect, useState } from 'react';
import { getGitDiffStat } from '../lib/git';
import type { GitDiffStat } from '../types/vcs';
import { useDocumentVisible } from './useDocumentVisible';

const POLL_MS = 60_000;

// Uncommitted-change counts for a small set of idle worktrees, refreshed once
// a minute while the Activity view is on screen. Keyed by cwd so chats that
// share a folder share one git call.
export function useActivityShipSignals(
  cwds: readonly string[],
  enabled: boolean,
): Record<string, GitDiffStat> {
  const [stats, setStats] = useState<Record<string, GitDiffStat>>({});
  const visible = useDocumentVisible();
  const key = cwds.join('\n');

  useEffect(() => {
    if (!enabled || !visible || !key) return;
    let cancelled = false;
    let inFlight = false;
    const refresh = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const results = await Promise.all(
          key
            .split('\n')
            .map(async (cwd) => [cwd, await getGitDiffStat(cwd, 'uncommitted')] as const),
        );
        if (cancelled) return;
        const next: Record<string, GitDiffStat> = {};
        for (const [cwd, stat] of results) if (stat) next[cwd] = stat;
        setStats(next);
      } finally {
        inFlight = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [key, enabled, visible]);

  return stats;
}
