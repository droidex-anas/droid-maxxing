import type { GithubSetupController } from '../hooks/useGithubSetup';

export function githubContextIntegration(isGitHub: boolean, setup: GithubSetupController) {
  return {
    pullRequestEnabled: isGitHub && setup.isReady,
    environmentProps: {
      githubAvailability: setup.availability,
      githubAction: setup.action,
      githubError: setup.error,
      githubManualGuideOpened: setup.manualGuideOpened,
      githubAuthCode: setup.authCode,
      githubAuthPopoverOpen: setup.isAuthPopoverOpen,
      githubReady: setup.isReady,
      onGithubSetupAction: setup.runPrimaryAction,
      onShowGithubAuthPrompt: setup.showAuthPrompt,
      onCloseGithubAuthPrompt: setup.closeAuthPrompt,
      onCancelGithubAuthentication: setup.cancelAuthentication,
    },
  };
}
