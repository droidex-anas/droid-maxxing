import { useEffect, useMemo, useState } from 'react';
import { getGitWorktrees } from '../lib/git';
import {
  discoverWorkspaceScopes,
  type WorkspaceDiscovery,
  type WorkspaceScope,
} from '../lib/workspaces';

const EMPTY_DISCOVERY_RETRY_MS = 5_000;

interface WorkspaceDiscoverySnapshot extends WorkspaceDiscovery {
  key: string;
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
    let cancelled = false;
    let retryTimer: number | undefined;

    const discover = () => {
      void discoverWorkspaceScopes(workspaceCwds, getGitWorktrees).then((result) => {
        if (cancelled) return;
        const canonicalCwds = result.scopes.map((scope) => scope.cwd);
        const canonicalKey = JSON.stringify(canonicalCwds);
        setSnapshot({ key: canonicalKey, ...result });
        if (canonicalKey !== key) onCanonicalCwds(canonicalCwds);
      });
    };

    if (ready) retryTimer = window.setTimeout(discover, EMPTY_DISCOVERY_RETRY_MS);
    else discover();

    return () => {
      cancelled = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    };
  }, [enabled, key, onCanonicalCwds, ready, snapshot, workspaceCwds]);

  return { scopes, ready };
}
