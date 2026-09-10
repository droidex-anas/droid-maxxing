import { useEffect, useRef } from 'react';
import { shallowEqual, useStoreDispatch, useStoreSelector } from '../hooks/useStore';
import { bindLazySurfaceIntent } from '../lib/chunkPreloader';
import { isEmbedded } from '../lib/embed';
import { resolvePrWorkspaceCwd } from '../features/pull-requests/lib/prWorkspaceCwd';
import { GitPullRequestIcon } from './environment/GithubIcons';
import { Clock } from '@droidex/icons';

export function SidebarNavigation() {
  const dispatch = useStoreDispatch();
  const state = useStoreSelector((current) => {
    const activeSession = current.activeAppSessionId
      ? current.sessions[current.activeAppSessionId]
      : null;
    return {
      activeSession,
      mainView: current.mainView,
      prWorkspaceCwd: current.prWorkspaceCwd,
      workspaceCwds: current.workspaceCwds,
    };
  }, shallowEqual);
  const automationsButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => bindLazySurfaceIntent('automations', automationsButtonRef.current), []);

  if (isEmbedded()) return null;

  return (
    <>
      <button
        data-testid="pull-requests-nav"
        onClick={() => {
          const cwd = resolvePrWorkspaceCwd({
            boundCwd: state.prWorkspaceCwd,
            activeCwd: state.activeSession?.cwd,
            workspaceKind: state.activeSession?.workspaceKind,
            workspaceCwds: state.workspaceCwds,
          });
          dispatch({ type: 'OPEN_PULL_REQUESTS', cwd });
        }}
        className={`group mt-0.5 flex w-full items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-[13px] font-medium transition-colors ${
          state.mainView === 'pull-requests'
            ? 'bg-droid-active text-droid-text'
            : 'text-droid-text hover:bg-droid-elevated'
        }`}
      >
        <span
          className={`flex h-4 w-4 shrink-0 items-center justify-center transition-colors ${
            state.mainView === 'pull-requests'
              ? 'text-droid-text'
              : 'text-droid-text-secondary group-hover:text-droid-text'
          }`}
        >
          <GitPullRequestIcon size={15} />
        </span>
        Pull requests
      </button>
      <button
        ref={automationsButtonRef}
        data-testid="automations-nav"
        onClick={() => {
          dispatch({ type: 'OPEN_AUTOMATIONS' });
        }}
        aria-current={state.mainView === 'automations' ? 'page' : undefined}
        className={`group mt-0.5 flex w-full items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-[13px] font-medium transition-colors ${
          state.mainView === 'automations'
            ? 'bg-droid-active text-droid-text'
            : 'text-droid-text hover:bg-droid-elevated'
        }`}
      >
        <Clock
          className={`h-3.5 w-3.5 shrink-0 transition-colors ${
            state.mainView === 'automations'
              ? 'text-droid-text'
              : 'text-droid-text-secondary group-hover:text-droid-text'
          }`}
        />
        Automations
      </button>
    </>
  );
}
