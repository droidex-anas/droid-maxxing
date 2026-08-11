import { useRef, useState } from 'react';
import { Check, FolderGit2, FolderPlus } from 'lucide-react';
import { Popover } from './Popover';
import { WorktreeIcon } from '../icons/WorktreeIcon';

// Custom composer-bar glyphs (16x16, currentColor) that replace the stock
// lucide marks for the Local/machine and branch pills.
function LocalGlyph({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <rect x="2.5" y="3.5" width="11" height="8" rx="1.5" />
      <path d="M5 13h6" />
      <path d="M8 11.5V13" />
    </svg>
  );
}

function BranchGlyph({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <circle cx="5" cy="11" r="2" />
      <circle cx="11" cy="5" r="2" />
      <path d="M5 9V5.5A1.5 1.5 0 0 1 6.5 4H9" />
    </svg>
  );
}

import { StartBranchMenu } from './StartBranchMenu';
import { shallowEqual, useStoreDispatch, useStoreSelector } from '../../hooks/useStore';
import { useGitEnvironment } from '../../hooks/useGitEnvironment';
import { pickDirectory } from '../../lib/desktop';
import { worktreeName } from '../../lib/git';
import { resolveMainCheckout } from '../../lib/chatWorkspace';
import { workspaceName } from '../../lib/workspaces';

function Pill({
  icon,
  label,
  title,
  open,
  innerRef,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  title: string;
  open: boolean;
  innerRef: React.RefObject<HTMLButtonElement | null>;
  onClick: () => void;
}) {
  return (
    <button
      ref={innerRef}
      onClick={onClick}
      title={`${title}: ${label}`}
      aria-label={`${title}: ${label}`}
      aria-expanded={open}
      aria-haspopup="dialog"
      className={`group flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-[11px] transition-colors ${
        open
          ? 'bg-droid-bg/60 text-droid-text'
          : 'text-droid-text-secondary hover:bg-droid-bg/40 hover:text-droid-text'
      }`}
    >
      <span className="shrink-0 text-droid-text-muted transition-colors group-hover:text-droid-text-secondary">
        {icon}
      </span>
      <span className="max-w-[150px] truncate text-left">{label}</span>
    </button>
  );
}

// The composer's "Start in" controls: pick the repository, choose an isolated
// worktree or the local checkout, and select the starting ref.
export function StartInBar() {
  const dispatch = useStoreDispatch();
  const state = useStoreSelector(
    (current) => ({
      draftChat: current.draftChat,
      workspaceCwds: current.workspaceCwds,
    }),
    shallowEqual,
  );
  const draft = state.draftChat;
  const cwd = draft?.cwd ?? '';
  // 'uncommitted' so the branch-switch warning counts only working-tree changes
  // that a checkout would carry over — not committed work, which stays put.
  const { env, branches, worktrees, diffStat, refresh } = useGitEnvironment(cwd, 'uncommitted');

  const [repoOpen, setRepoOpen] = useState(false);
  const [locOpen, setLocOpen] = useState(false);
  const [branchOpen, setBranchOpen] = useState(false);
  const repoRef = useRef<HTMLButtonElement>(null);
  const locRef = useRef<HTMLButtonElement>(null);
  const branchRef = useRef<HTMLButtonElement>(null);

  if (!draft || !cwd) return null;

  const mainCheckout = env ? resolveMainCheckout(env, worktrees) : null;
  const repoRoot = mainCheckout?.path ?? env?.repoRoot ?? cwd;
  const isRepo = !!env?.isRepo;
  const base = draft.branch ?? env?.branch ?? env?.head ?? env?.defaultBranch ?? 'main';
  const localWorktrees = worktrees.filter((w) => !w.bare && w.path);
  // Match on the resolved worktree root, not the raw draft cwd, so a chat whose
  // cwd is a subdirectory of a worktree still maps to that worktree.
  const currentWtPath = env?.worktreePath ?? cwd;
  const currentWt = localWorktrees.find((w) => w.path === currentWtPath && w.path !== repoRoot);
  const createsWorktree = draft.executionMode === 'worktree';
  const onLocal = !createsWorktree && !currentWt && !!mainCheckout;
  let workLocationLabel = 'Local';
  if (createsWorktree) workLocationLabel = 'New worktree';
  else if (currentWt) workLocationLabel = worktreeName(currentWt);

  const startIn = (
    path: string,
    branch?: string,
    executionMode: 'worktree' | 'local' = 'worktree',
  ) => {
    dispatch({ type: 'START_CHAT', cwd: path, executionMode, branch });
  };

  const openFolder = async () => {
    setRepoOpen(false);
    const dir = await pickDirectory();
    if (dir) {
      dispatch({ type: 'ADD_WORKSPACE', cwd: dir });
      startIn(dir);
    }
  };

  return (
    <div className="flex min-w-0 items-center gap-4 overflow-hidden">
      <Pill
        icon={<FolderGit2 className="h-3.5 w-3.5" />}
        label={workspaceName(repoRoot)}
        title="Project"
        open={repoOpen}
        innerRef={repoRef}
        onClick={() => {
          setLocOpen(false);
          setBranchOpen(false);
          setRepoOpen((v) => !v);
        }}
      />
      <Popover
        open={repoOpen}
        onClose={() => {
          setRepoOpen(false);
        }}
        anchorRef={repoRef}
        label="Projects"
        align="left"
        width={264}
      >
        <div className="max-h-[260px] overflow-y-auto py-1">
          {state.workspaceCwds.map((path) => (
            <button
              key={path}
              onClick={() => {
                startIn(path);
                setRepoOpen(false);
              }}
              aria-pressed={path === repoRoot}
              className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-droid-elevated/60"
            >
              <FolderGit2 className="h-3.5 w-3.5 shrink-0 text-droid-text-muted" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12.5px] text-droid-text">
                  {workspaceName(path)}
                </span>
                <span className="block truncate text-[10.5px] text-droid-text-muted">{path}</span>
              </span>
              {path === repoRoot && (
                <Check
                  className="h-3.5 w-3.5 shrink-0"
                  style={{ color: 'var(--droid-accent)' }}
                  strokeWidth={3}
                />
              )}
            </button>
          ))}
        </div>
        <div className="border-t border-droid-border/70 p-1.5">
          <button
            onClick={() => {
              void openFolder();
            }}
            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12.5px] text-droid-text transition-colors hover:bg-droid-elevated/60"
          >
            <FolderPlus className="h-3.5 w-3.5 shrink-0 text-droid-text-muted" />
            Open folder…
          </button>
        </div>
      </Popover>

      {isRepo && (
        <>
          <Pill
            icon={
              createsWorktree ? (
                <WorktreeIcon className="h-3.5 w-3.5" />
              ) : (
                <LocalGlyph className="h-3.5 w-3.5" />
              )
            }
            label={workLocationLabel}
            title="Work in"
            open={locOpen}
            innerRef={locRef}
            onClick={() => {
              setRepoOpen(false);
              setBranchOpen(false);
              setLocOpen((v) => !v);
            }}
          />
          <Popover
            open={locOpen}
            onClose={() => {
              setLocOpen(false);
            }}
            anchorRef={locRef}
            label="Worktrees"
            align="left"
            width={280}
          >
            <div className="max-h-[260px] overflow-y-auto py-1">
              <button
                onClick={() => {
                  startIn(repoRoot, draft.branch ?? env.branch ?? undefined, 'worktree');
                  setLocOpen(false);
                }}
                aria-pressed={createsWorktree}
                className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-droid-elevated/60"
              >
                <WorktreeIcon className="h-3.5 w-3.5 shrink-0 text-droid-text-muted" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px] text-droid-text">New worktree</span>
                  <span className="block truncate text-[10.5px] text-droid-text-muted">
                    Isolated checkout for this chat
                  </span>
                </span>
                {createsWorktree && (
                  <Check
                    className="h-3.5 w-3.5 shrink-0"
                    style={{ color: 'var(--droid-accent)' }}
                    strokeWidth={3}
                  />
                )}
              </button>
              <button
                onClick={() => {
                  if (mainCheckout) startIn(mainCheckout.path, mainCheckout.branch, 'local');
                  setLocOpen(false);
                }}
                disabled={!mainCheckout}
                aria-pressed={onLocal}
                className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors enabled:hover:bg-droid-elevated/60 disabled:opacity-50"
              >
                <LocalGlyph className="h-3.5 w-3.5 shrink-0 text-droid-text-muted" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px] text-droid-text">Work locally</span>
                  <span className="block truncate text-[10.5px] text-droid-text-muted">
                    {mainCheckout
                      ? `${mainCheckout.branch ?? 'detached'} · main checkout`
                      : 'Loading main checkout…'}
                  </span>
                </span>
                {onLocal && (
                  <Check
                    className="h-3.5 w-3.5 shrink-0"
                    style={{ color: 'var(--droid-accent)' }}
                    strokeWidth={3}
                  />
                )}
              </button>
              {localWorktrees
                .filter((w) => w.path !== repoRoot)
                .map((w) => (
                  <button
                    key={w.path}
                    onClick={() => {
                      if (w.path) startIn(w.path, w.branch ?? undefined, 'local');
                      setLocOpen(false);
                    }}
                    aria-pressed={currentWtPath === w.path}
                    className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-droid-elevated/60"
                  >
                    <WorktreeIcon className="h-3.5 w-3.5 shrink-0 text-droid-text-muted" />
                    <span className="min-w-0 flex-1 truncate text-[12.5px] text-droid-text-secondary">
                      {worktreeName(w)}
                    </span>
                    {currentWtPath === w.path && (
                      <Check
                        className="h-3.5 w-3.5 shrink-0"
                        style={{ color: 'var(--droid-accent)' }}
                        strokeWidth={3}
                      />
                    )}
                  </button>
                ))}
            </div>
          </Popover>

          <Pill
            icon={<BranchGlyph className="h-3.5 w-3.5" />}
            label={draft.branch ?? env.branch ?? 'detached'}
            title="Branch"
            open={branchOpen}
            innerRef={branchRef}
            onClick={() => {
              setRepoOpen(false);
              setLocOpen(false);
              setBranchOpen((v) => !v);
            }}
          />
          <StartBranchMenu
            open={branchOpen}
            onClose={() => {
              setBranchOpen(false);
            }}
            anchorRef={branchRef}
            cwd={cwd}
            env={env}
            branches={branches}
            worktrees={worktrees}
            uncommittedFiles={diffStat?.files ?? 0}
            base={base}
            executionMode={draft.executionMode}
            onStartIn={startIn}
            onRefresh={refresh}
          />
        </>
      )}
    </div>
  );
}
