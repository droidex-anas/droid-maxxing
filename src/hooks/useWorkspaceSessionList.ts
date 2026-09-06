import { useCallback, useEffect, useState } from 'react';
import { listSessions } from '../lib/commands';
import type { WorkspaceScope } from '../lib/workspaces';

// Identity is the re-request trigger, so revealing folders that are already
// revealed must return the same array.
export function withRevealedCwds(
  revealed: readonly string[],
  executionCwds: readonly string[],
): readonly string[] {
  const next = new Set(revealed);
  for (const cwd of executionCwds) next.add(cwd);
  return next.size === revealed.length ? revealed : [...next];
}

// Single owner of the sidebar's `sessions.list` request. The sidecar bounds how
// many pre-existing Droid sessions a freshly opened folder contributes, so the
// folders the user asked to see the rest of belong to the same request rather
// than a second, later list that would race this one.
export function useWorkspaceSessionList(
  scopes: readonly WorkspaceScope[],
  enabled: boolean,
): (executionCwds: readonly string[]) => void {
  const [revealEarlierCwds, setRevealEarlierCwds] = useState<readonly string[]>([]);

  useEffect(() => {
    if (!enabled) return;
    const workspaceCwds = [...new Set(scopes.flatMap((scope) => scope.executionCwds))];
    listSessions({
      workspaceCwds,
      includePlainChats: true,
      revealEarlierCwds: [...revealEarlierCwds],
    });
  }, [enabled, scopes, revealEarlierCwds]);

  return useCallback((executionCwds: readonly string[]) => {
    setRevealEarlierCwds((revealed) => withRevealedCwds(revealed, executionCwds));
  }, []);
}
