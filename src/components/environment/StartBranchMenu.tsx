import { useMemo, useState, type RefObject } from 'react';
import { Check, ChevronLeft, GitBranch, Loader2, Plus, Search } from 'lucide-react';
import { Popover } from './Popover';
import { checkoutGitBranch, createGitBranch, stripRemotePrefix } from '../../lib/git';
import { useGitFetchOnOpen } from '../../hooks/useGitFetchOnOpen';
import { useBusyAction } from '../../hooks/useBusyAction';
import { toast } from '../../lib/toast';
import type { GitBranchList, GitEnvironment, GitWorktree } from '../../types/vcs';

export function StartBranchMenu({
  open,
  onClose,
  anchorRef,
  cwd,
  env,
  branches,
  worktrees,
  uncommittedFiles,
  base,
  executionMode,
  onStartIn,
  onRefresh,
}: {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLButtonElement | null>;
  cwd: string;
  env: GitEnvironment | null;
  branches: GitBranchList | null;
  worktrees: GitWorktree[];
  uncommittedFiles: number;
  base: string;
  executionMode: 'worktree' | 'local';
  onStartIn: (path: string, branch?: string, executionMode?: 'worktree' | 'local') => void;
  onRefresh: () => void;
}) {
  const [query, setQuery] = useState('');
  const [pending, setPending] = useState<{ branch: string; remote: boolean } | null>(null);
  const [creatingNew, setCreatingNew] = useState(false);
  const [newName, setNewName] = useState('');
  const { busy, run } = useBusyAction();
  const fetching = useGitFetchOnOpen(open, cwd, onRefresh, env?.repoRoot ?? undefined);

  const repoRoot = worktrees.find((worktree) => worktree.isMain)?.path ?? env?.repoRoot ?? cwd;
  const current = env?.branch ?? null;
  const selected = executionMode === 'worktree' ? base : current;

  const reset = () => {
    setPending(null);
    setCreatingNew(false);
    setNewName('');
    setQuery('');
  };
  const close = () => {
    reset();
    onClose();
  };

  const { locals, remotes } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const locals = (branches?.local ?? [])
      .filter((b) => !q || b.name.toLowerCase().includes(q))
      .sort((a, b) => {
        if (a.name === selected) return -1;
        if (b.name === selected) return 1;
        return b.committerDate - a.committerDate;
      });
    // Keep remote entries visible even when a local branch shares the short
    // name — the user may want to create a worktree from a different remote's
    // version (e.g. upstream/foo vs origin/foo).
    const remotes = (branches?.remote ?? []).filter((r) => !q || r.name.toLowerCase().includes(q));
    return { locals, remotes };
  }, [branches, query, selected]);

  const worktreeFor = (branch: string) =>
    worktrees.find((w) => w.branch === branch && w.path && !w.bare);

  const pickBranch = (branch: string, remote: boolean) => {
    if (executionMode === 'worktree') {
      onStartIn(repoRoot, branch, 'worktree');
      close();
      return;
    }

    // Match worktrees by the local short name: a remote entry like origin/foo
    // must resolve to a worktree whose branch is `foo`, not the prefixed ref.
    const localName = remote ? stripRemotePrefix(branch, env?.remotes) : branch;
    const wt = worktreeFor(localName);
    if (wt?.path) {
      // A remote pick reuses the branch's existing local worktree, which may
      // trail the remote ref; say so instead of silently substituting it.
      if (remote && branch !== localName) {
        toast.info(`Opened existing worktree on ${localName}; pull there to sync with ${branch}`);
      }
      onStartIn(wt.path, localName, 'local');
      close();
      return;
    }
    if (!remote && branch === current) {
      onStartIn(cwd, branch, 'local');
      close();
      return;
    }
    setPending({ branch, remote });
  };

  const checkoutLocally = () =>
    run(async () => {
      if (!pending) return;
      try {
        const res = await checkoutGitBranch(cwd, { ref: pending.branch });
        if (res.ok) {
          // Start where the checkout actually happened. checkoutGitBranch runs in
          // `cwd`, so a linked worktree (cwd !== repoRoot) must start in that
          // worktree, not the main repo root which is still on its own branch.
          // Only a remote ref carries a remote prefix to strip; a local branch
          // like `feature/foo` must be recorded verbatim, not collapsed to `foo`.
          onStartIn(
            cwd,
            pending.remote ? stripRemotePrefix(pending.branch, env?.remotes) : pending.branch,
            'local',
          );
          onRefresh();
          close();
        } else if (res.reason === 'dirty') {
          toast.error('Commit or stash your changes before checking out locally');
        } else {
          toast.error(res.message ?? 'Could not checkout');
        }
      } catch {
        toast.error('Could not checkout');
      }
    });

  const createNewBranch = () =>
    run(async () => {
      const branch = newName.trim();
      if (!branch) return;
      try {
        const res = await createGitBranch(cwd, { name: branch, base, checkout: true });
        if (res.ok) {
          toast.success(`Checked out ${branch}`);
          onStartIn(cwd, branch, 'local');
          onRefresh();
          close();
        } else {
          toast.error(res.message ?? 'Could not create branch');
        }
      } catch {
        toast.error('Could not create branch');
      }
    });

  let popoverLabel = 'Choose local branch';
  if (executionMode === 'worktree') popoverLabel = 'Choose worktree base';
  if (pending) popoverLabel = `Checkout ${pending.branch}`;
  let selectedDescription = 'No uncommitted changes';
  if (executionMode === 'worktree') selectedDescription = 'Selected base';
  else if (uncommittedFiles > 0) {
    selectedDescription = `Uncommitted: ${String(uncommittedFiles)} file${uncommittedFiles === 1 ? '' : 's'}`;
  }

  return (
    <Popover
      open={open}
      onClose={close}
      anchorRef={anchorRef}
      label={popoverLabel}
      align="left"
      width={320}
    >
      {pending ? (
        <div className="p-2.5">
          <button
            onClick={() => {
              setPending(null);
            }}
            className="mb-2 flex items-center gap-1 text-[11.5px] text-droid-text-muted hover:text-droid-text"
          >
            <ChevronLeft className="h-3.5 w-3.5" /> Branches
          </button>
          <div className="mb-1 text-[12.5px] text-droid-text">
            Checkout <span className="font-medium">{pending.branch}</span> locally?
          </div>
          <div className="mb-2 text-[11px] text-droid-text-muted">
            {uncommittedFiles > 0
              ? `Your current checkout has ${String(uncommittedFiles)} uncommitted file${uncommittedFiles === 1 ? '' : 's'}.`
              : 'This changes the branch in your current checkout.'}
          </div>
          <button
            onClick={() => void checkoutLocally()}
            disabled={busy}
            className="ml-auto flex items-center gap-1 rounded-md bg-droid-accent/15 px-2.5 py-1 text-[11.5px] font-medium text-droid-accent hover:bg-droid-accent/25 disabled:opacity-40"
          >
            {busy && <Loader2 className="h-3 w-3 animate-spin" />}
            Checkout locally
          </button>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2 border-b border-droid-border/70 px-2.5 py-2">
            <Search className="h-3.5 w-3.5 shrink-0 text-droid-text-muted" />
            <input
              autoFocus
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
              }}
              placeholder="Search branches"
              className="w-full bg-transparent text-[12px] text-droid-text placeholder:text-droid-text-muted/70 focus:outline-none"
            />
            {fetching && (
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-droid-accent" />
            )}
          </div>
          <div className="max-h-[280px] overflow-y-auto py-1">
            <div className="px-2.5 pb-1 pt-1.5 text-[10px] font-medium uppercase tracking-wider text-droid-text-muted">
              Branches
            </div>
            {locals.map((b) => (
              <button
                key={b.name}
                onClick={() => {
                  pickBranch(b.name, false);
                }}
                aria-pressed={b.name === selected}
                className="flex w-full items-center gap-2.5 px-2.5 py-1.5 text-left transition-colors hover:bg-droid-elevated/60"
              >
                <GitBranch className="h-3.5 w-3.5 shrink-0 text-droid-text-muted" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px] text-droid-text">{b.name}</span>
                  {b.name === selected ? (
                    <span className="block truncate text-[10.5px] text-droid-text-muted">
                      {selectedDescription}
                    </span>
                  ) : (
                    b.subject && (
                      <span className="block truncate text-[10.5px] text-droid-text-muted">
                        {b.subject}
                      </span>
                    )
                  )}
                </span>
                {b.name === selected && (
                  <Check
                    className="h-3.5 w-3.5 shrink-0"
                    style={{ color: 'var(--droid-accent)' }}
                    strokeWidth={3}
                  />
                )}
              </button>
            ))}

            {remotes.length > 0 && (
              <div className="px-2.5 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wider text-droid-text-muted">
                Remote
              </div>
            )}
            {remotes.map((r) => (
              <button
                key={r.name}
                onClick={() => {
                  pickBranch(r.name, true);
                }}
                aria-pressed={r.name === selected}
                className="flex w-full items-center gap-2.5 px-2.5 py-1.5 text-left transition-colors hover:bg-droid-elevated/60"
              >
                <GitBranch className="h-3.5 w-3.5 shrink-0 text-droid-text-muted" />
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-droid-text-secondary">
                  {r.name}
                </span>
                {r.name === selected && (
                  <Check
                    className="h-3.5 w-3.5 shrink-0"
                    style={{ color: 'var(--droid-accent)' }}
                    strokeWidth={3}
                  />
                )}
              </button>
            ))}

            {locals.length === 0 && remotes.length === 0 && (
              <div className="px-2.5 py-2 text-[12px] text-droid-text-muted">No branches match</div>
            )}
          </div>

          {executionMode === 'local' && (
            <div className="border-t border-droid-border/70 p-1.5">
              {creatingNew ? (
                <div className="space-y-1.5">
                  <input
                    autoFocus
                    value={newName}
                    onChange={(e) => {
                      setNewName(e.target.value);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void createNewBranch();
                    }}
                    placeholder="new-branch-name"
                    className="w-full rounded-md bg-droid-bg/60 px-2 py-1 text-[12px] text-droid-text placeholder:text-droid-text-muted/70 focus:outline-none"
                  />
                  <div className="px-0.5 text-[10.5px] text-droid-text-muted">
                    Branches off <span className="text-droid-text-secondary">{base}</span>
                  </div>
                  <div className="flex items-center justify-end gap-1.5">
                    <button
                      onClick={() => {
                        setCreatingNew(false);
                      }}
                      className="rounded-md px-2 py-1 text-[11px] text-droid-text-muted hover:text-droid-text"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={() => void createNewBranch()}
                      disabled={!newName.trim() || busy}
                      className="flex items-center gap-1 rounded-md bg-droid-accent/15 px-2 py-1 text-[11px] font-medium text-droid-accent disabled:opacity-40"
                    >
                      {busy && <Loader2 className="h-3 w-3 animate-spin" />}
                      Create & start
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => {
                    setCreatingNew(true);
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12.5px] text-droid-text transition-colors hover:bg-droid-elevated/60"
                >
                  <Plus className="h-3.5 w-3.5 shrink-0 text-droid-text-muted" />
                  Create and checkout new branch…
                </button>
              )}
            </div>
          )}
        </>
      )}
    </Popover>
  );
}
