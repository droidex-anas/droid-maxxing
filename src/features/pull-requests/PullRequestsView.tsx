import { shallowEqual, useStoreDispatch, useStoreSelector } from '../../hooks/useStore';
import { useGitEnvironment } from '../../hooks/useGitEnvironment';
import { useGithubSetup } from '../../hooks/useGithubSetup';
import type { PullRequest } from '../../types/vcs';
import { PrDetail } from './components/PrDetail';
import { PrInbox } from './components/PrInbox';
import { PrWorkspaceEmpty } from './components/PrWorkspaceEmpty';
import { usePullRequestList } from './hooks/usePullRequestList';
import { prChatSeed } from './lib/prChatSeed';
import { droidReviewSeed } from './lib/prReview';
import { resolvePrWorkspaceCwd } from './lib/prWorkspaceCwd';

function WorkspaceDetail({
  cwd,
  number,
  prs,
  viewerLogin,
  onOpenChat,
  onReviewWithDroid,
}: {
  cwd: string;
  number: number | null;
  prs: PullRequest[];
  viewerLogin: string | null;
  onOpenChat: (pr: PullRequest) => void;
  onReviewWithDroid: (pr: PullRequest) => void;
}) {
  if (number == null) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center px-8">
        <p className="text-[13px] text-droid-text-muted">Select a pull request</p>
      </div>
    );
  }
  const selected = prs.find((item) => item.number === number) ?? null;
  return (
    <PrDetail
      cwd={cwd}
      number={number}
      pr={selected}
      viewerLogin={viewerLogin}
      onOpenChat={onOpenChat}
      onReviewWithDroid={onReviewWithDroid}
    />
  );
}

export function PullRequestsView() {
  const dispatch = useStoreDispatch();
  const state = useStoreSelector(
    (current) => ({
      activeAppSessionId: current.activeAppSessionId,
      prWorkspaceCwd: current.prWorkspaceCwd,
      prWorkspaceNumber: current.prWorkspaceNumber,
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
  const git = useGitEnvironment(cwd ?? '', 'worktree');
  const setup = useGithubSetup(Boolean(cwd), cwd ?? 'none');
  const canList = Boolean(cwd && git.env?.isGitHub && setup.isReady);
  const list = usePullRequestList(cwd, canList);

  if (!canList || !cwd) {
    return (
      <div data-testid="pull-requests-workspace" className="flex h-full min-h-0">
        <PrWorkspaceEmpty
          cwd={cwd}
          gitLoaded={git.hasSnapshot}
          isGitHub={Boolean(git.env?.isGitHub)}
          setup={setup}
        />
      </div>
    );
  }

  return (
    <div data-testid="pull-requests-workspace" className="flex h-full min-h-0">
      <div className="flex h-full min-h-0 w-[360px] shrink-0 flex-col">
        <PrInbox
          prs={list.prs}
          viewerLogin={list.viewerLogin}
          selectedNumber={state.prWorkspaceNumber}
          loading={list.loading || !list.loaded}
          error={list.error}
          onSelect={(number) => {
            dispatch({ type: 'OPEN_PULL_REQUESTS', number });
          }}
          onRetry={list.refresh}
        />
      </div>
      <WorkspaceDetail
        cwd={cwd}
        number={state.prWorkspaceNumber}
        prs={list.prs}
        viewerLogin={list.viewerLogin}
        onOpenChat={(pr) => {
          // Start a fresh local draft in this checkout before seeding it. This
          // prevents an active chat from another workspace from owning the PR
          // prompt; sending stays the user's decision.
          dispatch({ type: 'START_CHAT', cwd, executionMode: 'local' });
          dispatch({ type: 'SEED_COMPOSER', text: prChatSeed(pr) });
        }}
        onReviewWithDroid={(pr) => {
          // A local review starts as its own chat in this checkout, opened with
          // the review skill and the pull request already typed in.
          dispatch({ type: 'CLOSE_PULL_REQUESTS' });
          dispatch({ type: 'START_CHAT', cwd, executionMode: 'local' });
          dispatch({ type: 'SEED_COMPOSER', text: droidReviewSeed(pr) });
        }}
      />
    </div>
  );
}
