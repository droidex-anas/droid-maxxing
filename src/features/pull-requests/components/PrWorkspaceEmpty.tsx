import { useStoreDispatch } from '../../../hooks/useStore';
import { useGithubSetup, type GithubSetupController } from '../../../hooks/useGithubSetup';
import { pickDirectory } from '../../../lib/desktop';

function setupActionLabel(setup: GithubSetupController): string {
  if (setup.action === 'installing') return 'Installing…';
  if (setup.action === 'authenticating') {
    return setup.authCode ? 'Show sign-in code' : 'Waiting for GitHub…';
  }
  if (setup.availability?.installed) return 'Sign in to GitHub';
  if (setup.availability?.installMethod === 'manual' && setup.manualGuideOpened) {
    return 'Check installation';
  }
  return 'Install GitHub CLI';
}

function EmptyCopy({ children }: { children: string }) {
  return (
    <p className="max-w-sm text-center text-[13px] leading-5 text-droid-text-muted">{children}</p>
  );
}

export function PrWorkspaceEmpty({ cwd, isGitHub }: { cwd: string | null; isGitHub?: boolean }) {
  const dispatch = useStoreDispatch();
  const setup = useGithubSetup(true, cwd ?? 'none');

  const openWorkspace = async () => {
    const nextCwd = await pickDirectory();
    if (!nextCwd) return;
    dispatch({ type: 'ADD_WORKSPACE', cwd: nextCwd });
    dispatch({ type: 'OPEN_PULL_REQUESTS', cwd: nextCwd });
  };

  if (!cwd) {
    return (
      <div className="flex h-full min-h-0 flex-1 flex-col items-center justify-center px-8">
        <EmptyCopy>Open a workspace to see its pull requests.</EmptyCopy>
        <button
          type="button"
          onClick={() => {
            void openWorkspace();
          }}
          className="mt-4 rounded-xl bg-droid-elevated px-3 py-2 text-[13px] font-medium text-droid-text transition-colors hover:bg-droid-active focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-droid-accent/60"
        >
          Open workspace
        </button>
      </div>
    );
  }

  if (isGitHub === false) {
    return (
      <div className="flex h-full min-h-0 flex-1 flex-col items-center justify-center px-8">
        <EmptyCopy>This folder is not a GitHub repository.</EmptyCopy>
      </div>
    );
  }

  if (setup.availability && !setup.isReady) {
    const busy = setup.action !== 'idle' && !setup.authCode;
    return (
      <div className="flex h-full min-h-0 flex-1 flex-col items-center justify-center px-8">
        <EmptyCopy>
          {setup.availability.installed
            ? 'Sign in through GitHub CLI to load pull requests.'
            : 'Install GitHub CLI to load pull requests.'}
        </EmptyCopy>
        {setup.error && (
          <p className="mt-2 max-w-sm text-center text-[12px] leading-4 text-droid-red">
            {setup.error}
          </p>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={setup.runPrimaryAction}
          className="mt-4 rounded-xl bg-droid-elevated px-3 py-2 text-[13px] font-medium text-droid-text transition-colors hover:bg-droid-active focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-droid-accent/60 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {setupActionLabel(setup)}
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-1 items-center justify-center px-8">
      <p className="text-[13px] text-droid-text-muted">Loading pull requests…</p>
    </div>
  );
}
