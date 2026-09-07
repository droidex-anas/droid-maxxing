import { useEffect, useState } from 'react';
import { ChevronRight, Loader2, Upload } from 'lucide-react';
import { GitCommitIcon, GitHubMarkIcon, PrStateIcon } from './GithubIcons';
import { Row } from './primitives';
import { CommitSheet } from './CommitSheet';
import { CreatePrSheet } from './CreatePrSheet';
import { gitPush } from '../../lib/git';
import { toast } from '../../lib/toast';
import { prKind } from '../../lib/github';
import {
  canRenderPrSheet,
  reconcileGitActionSheet,
  type GitActionSheet,
} from '../../lib/gitActionVisibility';
import type { GitBranchList, GitEnvironment, PullRequest } from '../../types/vcs';

// Git actions in the section's row language: "Commit or push" opens the commit
// sheet and carries a trailing ↑N pill as the one-click push while ahead;
// "Create pull request" opens the PR sheet when the branch has none yet.
export function GitActionsBar({
  cwd,
  env,
  branches,
  isGitHub,
  githubReady,
  hasPr,
  pr,
  onOpenPr,
  onChanged,
  onPrCreated,
}: {
  cwd: string;
  env: GitEnvironment | null;
  branches: GitBranchList | null;
  isGitHub: boolean;
  githubReady: boolean;
  hasPr: boolean;
  pr: PullRequest | null;
  onOpenPr: () => void;
  onChanged: () => void;
  onPrCreated?: () => void;
}) {
  const [sheet, setSheet] = useState<GitActionSheet>('none');
  const [pushing, setPushing] = useState(false);

  useEffect(() => {
    setSheet((current) =>
      reconcileGitActionSheet(current, isGitHub, githubReady, hasPr, !!env?.detached),
    );
  }, [isGitHub, githubReady, hasPr, env?.detached]);

  const toggle = (next: GitActionSheet) => {
    setSheet((cur) => (cur === next ? 'none' : next));
  };

  const doPush = async () => {
    if (pushing) return;
    setPushing(true);
    try {
      const res = await gitPush(cwd, { setUpstream: !env?.upstream });
      if (res.ok) toast.success('Pushed to remote');
      else if (res.reason === 'detached') toast.error('Detached HEAD — checkout a branch first');
      else toast.error(res.message ?? 'Push failed');
      onChanged();
    } catch {
      toast.error('Push failed');
    } finally {
      setPushing(false);
    }
  };

  // Only commits ahead of upstream are publishable; a behind-only branch has
  // nothing to push, so the push pill only surfaces for a real ahead count.
  const aheadCount = env?.ahead ?? 0;

  return (
    <div>
      <div
        className={`group flex items-center rounded-lg transition-colors ${
          sheet === 'commit' ? 'bg-droid-elevated' : 'hover:bg-droid-elevated/50'
        }`}
      >
        <button
          type="button"
          onClick={() => {
            toggle('commit');
          }}
          title="Commit or push"
          aria-expanded={sheet === 'commit'}
          className="flex min-w-0 flex-1 items-center gap-2.5 rounded-l-lg px-3 py-2 text-left"
        >
          <span className="flex h-4 w-4 shrink-0 items-center justify-center text-droid-text-muted transition-colors group-hover:text-droid-text-secondary">
            <GitCommitIcon size={16} />
          </span>
          <span className="min-w-0 flex-1 truncate text-[13px] leading-snug text-droid-text">
            Commit or push
          </span>
        </button>
        {aheadCount > 0 && (
          <button
            type="button"
            onClick={() => void doPush()}
            disabled={pushing || !!env?.detached}
            title={
              env?.detached
                ? 'Detached HEAD — checkout a branch first'
                : `Push ${String(aheadCount)} commit${aheadCount === 1 ? '' : 's'}`
            }
            className="mr-1.5 flex shrink-0 items-center gap-1 rounded-md border border-droid-border/70 bg-droid-surface px-1.5 py-0.5 text-[10.5px] font-medium tabular-nums text-droid-text-secondary transition-colors hover:bg-droid-elevated hover:text-droid-text disabled:cursor-not-allowed disabled:opacity-40"
          >
            {pushing ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Upload className="h-3 w-3" />
            )}
            ↑{aheadCount}
          </button>
        )}
      </div>

      {sheet === 'commit' && (
        <div className="pt-1.5">
          <CommitSheet
            cwd={cwd}
            onDone={() => {
              setSheet('none');
              onChanged();
            }}
          />
        </div>
      )}

      {/* The PR row and the create action share one slot, so detection
          resolving swaps the label in place instead of pushing the panel
          down by a row. Only an open (or draft) PR takes the slot — a merged
          or closed detection leaves the create action available. */}
      {githubReady && hasPr && pr ? (
        <Row
          icon={<PrStateIcon kind={prKind(pr)} size={16} />}
          label={`#${String(pr.number)} ${pr.title}`}
          title={`${pr.title} — view checks and comments`}
          onClick={onOpenPr}
          trailing={
            <ChevronRight className="h-3.5 w-3.5 text-droid-text-muted/60 transition-colors group-hover:text-droid-text-secondary" />
          }
        />
      ) : (
        isGitHub &&
        githubReady &&
        !env?.detached && (
          <Row
            icon={<GitHubMarkIcon size={16} />}
            label="Create pull request"
            active={sheet === 'pr'}
            onClick={() => {
              toggle('pr');
            }}
          />
        )
      )}
      {canRenderPrSheet(sheet, isGitHub, githubReady, hasPr, !!env?.detached) && (
        <div className="pt-1.5">
          <CreatePrSheet
            cwd={cwd}
            env={env}
            branches={branches}
            onCreated={onPrCreated}
            onDone={() => {
              setSheet('none');
              onChanged();
            }}
          />
        </div>
      )}
    </div>
  );
}
