import { useState } from 'react';

import { GithubAuthPromptContent } from '../../../components/environment/GithubSetupCard';
import { useStoreDispatch } from '../../../hooks/useStore';
import type { GithubSetupController } from '../../../hooks/useGithubSetup';
import { pickDirectory } from '../../../lib/desktop';
import { isGithubAuthCodeCopied } from '../../../lib/github';

function setupActionLabel(setup: GithubSetupController): string {
  if (setup.action === 'installing') return 'Installing…';
  if (setup.action === 'authenticating') return 'Waiting for GitHub…';
  if (setup.availability?.installed) return 'Sign in to GitHub';
  if (setup.availability?.installMethod === 'manual' && setup.manualGuideOpened) {
    return 'Check installation';
  }
  return 'Install GitHub CLI';
}

function setupEmptyCopy(setup: GithubSetupController): string {
  if (setup.authCode) return 'GitHub is waiting for the one-time code shown here.';
  if (setup.availability?.installed) return 'Sign in through GitHub CLI to load pull requests.';
  return 'Install GitHub CLI to load pull requests.';
}

function EmptyCopy({ children }: { children: string }) {
  return (
    <p className="max-w-sm text-center text-[13px] leading-5 text-droid-text-muted">{children}</p>
  );
}

export function PrGithubSetupEmpty({ setup }: { setup: GithubSetupController }) {
  const [copiedCode, setCopiedCode] = useState<string | null>(null);
  const [copyFailedCode, setCopyFailedCode] = useState<string | null>(null);
  const busy = setup.action !== 'idle' && !setup.authCode;
  const canCancel =
    setup.action === 'authenticating' ||
    (setup.action === 'installing' && setup.availability?.installMethod !== 'manual');
  const copied = isGithubAuthCodeCopied(setup.authCode, copiedCode);
  const copyFailed = isGithubAuthCodeCopied(setup.authCode, copyFailedCode);

  const copyCode = async () => {
    if (!setup.authCode) return;
    setCopyFailedCode(null);
    try {
      await navigator.clipboard.writeText(setup.authCode);
      setCopiedCode(setup.authCode);
    } catch {
      setCopiedCode(null);
      setCopyFailedCode(setup.authCode);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col items-center justify-center px-8">
      <EmptyCopy>{setupEmptyCopy(setup)}</EmptyCopy>
      {setup.error && (
        <p
          aria-live="polite"
          className="mt-2 max-w-sm text-center text-[12px] leading-4 text-droid-red"
        >
          {setup.error}
        </p>
      )}
      {setup.authCode ? (
        <div className="mt-4 w-full max-w-sm">
          <GithubAuthPromptContent
            code={setup.authCode}
            copied={copied}
            copyFailed={copyFailed}
            onCopy={() => void copyCode()}
            onCancel={() => {
              setup.closeAuthPrompt();
              setup.cancelAuthentication();
            }}
          />
        </div>
      ) : (
        <div className="mt-4 flex items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={setup.runPrimaryAction}
            className="rounded-xl bg-droid-elevated px-3 py-2 text-[13px] font-medium text-droid-text transition-colors hover:bg-droid-active focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-droid-accent/60 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {setupActionLabel(setup)}
          </button>
          {canCancel && (
            <button
              type="button"
              onClick={setup.cancelAuthentication}
              className="rounded-xl px-3 py-2 text-[13px] font-medium text-droid-text-muted transition-colors hover:bg-droid-elevated hover:text-droid-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-droid-accent/60"
            >
              {setup.action === 'installing' ? 'Cancel installation' : 'Cancel sign-in'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// The view owns the GitHub setup controller, because the same readiness gates
// the pull request list: a second controller here would sign in without ever
// unblocking it.
export function PrWorkspaceEmpty({
  cwd,
  gitLoaded,
  isGitHub,
  setup,
}: {
  cwd: string | null;
  gitLoaded: boolean;
  isGitHub: boolean;
  setup: GithubSetupController;
}) {
  const dispatch = useStoreDispatch();

  const openWorkspace = async () => {
    const nextCwd = await pickDirectory();
    if (!nextCwd) return;
    dispatch({ type: 'ADD_WORKSPACE', cwd: nextCwd });
    // The previously selected number belongs to the old repository, so the new
    // workspace opens with nothing selected.
    dispatch({ type: 'OPEN_PULL_REQUESTS', cwd: nextCwd, number: null });
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

  // Until the git environment has loaded, a folder that is not a repository is
  // indistinguishable from one still being read, and GitHub setup would be
  // offered for a folder that can never use it.
  if (gitLoaded && !isGitHub) {
    return (
      <div className="flex h-full min-h-0 flex-1 flex-col items-center justify-center px-8">
        <EmptyCopy>This folder is not a GitHub repository.</EmptyCopy>
      </div>
    );
  }

  if (isGitHub && setup.availability && !setup.isReady) {
    return <PrGithubSetupEmpty setup={setup} />;
  }

  return (
    <div className="flex h-full min-h-0 flex-1 items-center justify-center px-8">
      <p className="text-[13px] text-droid-text-muted">Loading pull requests…</p>
    </div>
  );
}
