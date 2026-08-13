import { useEffect, useMemo, useState } from 'react';
import { getGitWorktrees } from '../lib/git';
import { stable } from '../lib/stable';
import {
  discoverWorkspaceScopes,
  type WorkspaceDiscovery,
  type WorkspaceScope,
} from '../lib/workspaces';
import type { GitWorktree } from '../types/vcs';

const EMPTY_DISCOVERY_RETRY_MS = 5_000;

export interface WorkspaceDiscoverySnapshot extends WorkspaceDiscovery {
  key: string;
}

export interface WorkspaceDiscoveryLoopOptions {
  workspaceCwds: readonly string[];
  /** JSON key of `workspaceCwds`; a canonical result matching it is current. */
  key: string;
  /** Delay before the first discovery; null runs it immediately. */
  startDelayMs: number | null;
  retryDelayMs: number;
  loadWorktrees: (cwd: string) => Promise<GitWorktree[]>;
  publish: (snapshot: WorkspaceDiscoverySnapshot) => void;
  onCanonicalCwds: (cwds: string[]) => void;
}

// Discover-and-retry loop for one workspace-cwd key. While a discovery stays
// incomplete (some workspace reported no worktrees yet), it reschedules itself
// so the retry cadence does not depend on the published snapshot changing
// identity: an unchanged result must NOT re-render the app just to keep the
// retry chain alive. Returns a cancel function that stops the loop and drops
// any in-flight result.
export function startWorkspaceDiscovery(options: WorkspaceDiscoveryLoopOptions): () => void {
  let cancelled = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  const discover = () => {
    retryTimer = undefined;
    void discoverWorkspaceScopes(options.workspaceCwds, options.loadWorktrees).then((result) => {
      if (cancelled) return;
      const canonicalCwds = result.scopes.map((scope) => scope.cwd);
      const canonicalKey = JSON.stringify(canonicalCwds);
      options.publish({ key: canonicalKey, ...result });
      if (canonicalKey !== options.key) {
        // The canonical cwds re-key the caller's state; the loop for the new
        // key owns any further discovery.
        options.onCanonicalCwds(canonicalCwds);
        return;
      }
      if (!result.complete) retryTimer = setTimeout(discover, options.retryDelayMs);
    });
  };

  if (options.startDelayMs === null) discover();
  else retryTimer = setTimeout(discover, options.startDelayMs);

  return () => {
    cancelled = true;
    if (retryTimer !== undefined) clearTimeout(retryTimer);
  };
}

export function useWorkspaceScopes(
  workspaceCwds: readonly string[],
  enabled: boolean,
  onCanonicalCwds: (cwds: string[]) => void,
): { scopes: WorkspaceScope[]; ready: boolean } {
  const key = JSON.stringify(workspaceCwds);
  const [snapshot, setSnapshot] = useState<WorkspaceDiscoverySnapshot | null>(null);
  const ready = snapshot?.key === key;
  const scopes = useMemo(
    () => (ready ? snapshot.scopes : workspaceCwds.map((cwd) => ({ cwd, executionCwds: [cwd] }))),
    [ready, snapshot, workspaceCwds],
  );

  useEffect(() => {
    if (!enabled || (ready && snapshot.complete)) return;
    return startWorkspaceDiscovery({
      workspaceCwds,
      key,
      // A current-but-incomplete snapshot means this is a retry pass; wait out
      // the cadence instead of hammering discovery on every remount.
      startDelayMs: ready ? EMPTY_DISCOVERY_RETRY_MS : null,
      retryDelayMs: EMPTY_DISCOVERY_RETRY_MS,
      loadWorktrees: getGitWorktrees,
      // `stable` keeps the previous snapshot's identity when a retry returns
      // the same data, so downstream memo/effect deps (sidebar grouping, the
      // sessions.list refresh in App) do not churn every retry.
      publish: (next) => {
        setSnapshot((prev) => stable(prev, next));
      },
      onCanonicalCwds,
    });
  }, [enabled, key, onCanonicalCwds, ready, snapshot, workspaceCwds]);

  return { scopes, ready };
}
