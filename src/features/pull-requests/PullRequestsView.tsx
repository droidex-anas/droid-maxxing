import { shallowEqual, useStoreSelector } from '../../hooks/useStore';
import { PrWorkspaceEmpty } from './components/PrWorkspaceEmpty';
import { resolvePrWorkspaceCwd } from './lib/prWorkspaceCwd';

export function PullRequestsView() {
  const state = useStoreSelector(
    (current) => ({
      activeAppSessionId: current.activeAppSessionId,
      prWorkspaceCwd: current.prWorkspaceCwd,
      sessions: current.sessions,
      workspaceCwds: current.workspaceCwds,
    }),
    shallowEqual,
  );
  const active = state.activeAppSessionId ? state.sessions[state.activeAppSessionId] : null;
  const cwd = resolvePrWorkspaceCwd({
    boundCwd: state.prWorkspaceCwd,
    activeCwd: active?.cwd,
    workspaceKind: active?.workspaceKind,
    workspaceCwds: state.workspaceCwds,
  });
  return (
    <div data-testid="pull-requests-workspace" className="flex h-full min-h-0">
      <PrWorkspaceEmpty cwd={cwd} />
    </div>
  );
}
