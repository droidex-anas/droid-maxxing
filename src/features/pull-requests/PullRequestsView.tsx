import { useMemo } from 'react';

import { shallowEqual, useStoreDispatch, useStoreSelector } from '../../hooks/useStore';
import { useGithubSetup } from '../../hooks/useGithubSetup';
import { PrDetail } from './components/PrDetail';
import { PrInbox } from './components/PrInbox';
import { PrWorkspaceEmpty } from './components/PrWorkspaceEmpty';
import { usePullRequestList } from './hooks/usePullRequestList';
import { prBacklogId } from './lib/prBacklog';
import { prChatSeed } from './lib/prChatSeed';
import type { InboxPullRequest } from './lib/prInbox';
import { selectedInboxPullRequest } from './lib/prInbox';
import { droidReviewSeed } from './lib/prReview';
import { resolvePrInboxContext } from './lib/prWorkspaceCwd';

function WorkspaceDetail({
  cwd,
  number,
  prs,
  viewerLogin,
  onOpenChat,
  onReviewWithDroid,
}: {
  cwd: string | null;
  number: number | null;
  prs: InboxPullRequest[];
  viewerLogin: string | null;
  onOpenChat: (pr: InboxPullRequest) => void;
  onReviewWithDroid: (pr: InboxPullRequest) => void;
}) {
  if (cwd == null || number == null) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center px-8">
        <p className="text-[13px] text-droid-text-muted">Select a pull request</p>
      </div>
    );
  }
  const selected = selectedInboxPullRequest(prs, cwd, number);
  return (
    <PrDetail
      cwd={cwd}
      number={number}
      pr={selected}
      viewerLogin={viewerLogin}
      onOpenChat={(item) => {
        onOpenChat({
          ...item,
          cwd,
          repoName: selected?.repoName ?? '',
        });
      }}
      onReviewWithDroid={(item) => {
        onReviewWithDroid({
          ...item,
          cwd,
          repoName: selected?.repoName ?? '',
        });
      }}
    />
  );
}

export function PullRequestsView() {
  const dispatch = useStoreDispatch();
  const state = useStoreSelector(
    (current) => ({
      activeAppSessionId: current.activeAppSessionId,
      draftChat: current.draftChat,
      prBacklogIds: current.prBacklogIds,
      prWorkspaceCwd: current.prWorkspaceCwd,
      prWorkspaceNumber: current.prWorkspaceNumber,
      sessions: current.sessions,
      workspaceCwds: current.workspaceCwds,
    }),
    shallowEqual,
  );
  const active = state.activeAppSessionId ? state.sessions[state.activeAppSessionId] : null;
  const inbox = useMemo(
    () =>
      resolvePrInboxContext({
        active,
        draftCwd: state.draftChat?.cwd,
        workspaceCwds: state.workspaceCwds,
        boundCwd: state.prWorkspaceCwd,
        boundNumber: state.prWorkspaceNumber,
      }),
    [
      active,
      state.draftChat?.cwd,
      state.prWorkspaceCwd,
      state.prWorkspaceNumber,
      state.workspaceCwds,
    ],
  );
  const setup = useGithubSetup(inbox.listingCwds.length > 0, 'pr-inbox');
  const canList = inbox.listingCwds.length > 0 && setup.isReady;
  const list = usePullRequestList(inbox.listingCwds, canList);
  const backlogIds = useMemo(() => new Set(state.prBacklogIds), [state.prBacklogIds]);

  if (!canList) {
    return (
      <div data-testid="pull-requests-workspace" className="flex h-full min-h-0">
        <PrWorkspaceEmpty
          cwd={inbox.listingCwds[0] ?? null}
          gitLoaded={true}
          isGitHub={true}
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
          currentCwd={inbox.currentCwd}
          selectedCwd={inbox.boundCwd}
          selectedNumber={inbox.selectedNumber}
          loading={list.loading || !list.loaded}
          error={list.error}
          repoErrors={list.repoErrors}
          backlogIds={backlogIds}
          onSelect={(pr) => {
            dispatch({ type: 'OPEN_PULL_REQUESTS', cwd: pr.cwd, number: pr.number });
          }}
          onRetry={list.refresh}
          onToggleBacklog={(pr) => {
            const id = prBacklogId(pr);
            dispatch({
              type: backlogIds.has(id) ? 'RESTORE_PR_FROM_BACKLOG' : 'MOVE_PR_TO_BACKLOG',
              id,
            });
          }}
        />
      </div>
      <WorkspaceDetail
        cwd={inbox.boundCwd}
        number={inbox.selectedNumber}
        prs={list.prs}
        viewerLogin={list.viewerLogin}
        onOpenChat={(pr) => {
          // Start a fresh local draft in this checkout before seeding it. This
          // prevents an active chat from another workspace from owning the PR
          // prompt; sending stays the user's decision.
          dispatch({ type: 'START_CHAT', cwd: pr.cwd, executionMode: 'local' });
          dispatch({ type: 'SEED_COMPOSER', text: prChatSeed(pr), replace: true });
        }}
        onReviewWithDroid={(pr) => {
          // A local review starts as its own chat in this checkout, opened with
          // the review skill and the pull request already typed in.
          dispatch({ type: 'CLOSE_PULL_REQUESTS' });
          dispatch({ type: 'START_CHAT', cwd: pr.cwd, executionMode: 'local' });
          dispatch({ type: 'SEED_COMPOSER', text: droidReviewSeed(pr), replace: true });
        }}
      />
    </div>
  );
}
