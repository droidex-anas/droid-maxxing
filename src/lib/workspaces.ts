import type { SessionSummary } from '../types/bridge';
import type { GitWorktree } from '../types/vcs';

// How many sessions a sidebar section shows before collapsing the rest behind
// a "Show more" control. This is a display default, not a hard cap: every
// loaded session stays available.
export const SIDEBAR_VISIBLE_SESSION_LIMIT = 5;

export interface WorkspaceSection {
  cwd: string;
  name: string;
  sessions: SessionSummary[];
}

export interface WorkspaceSectionOptions {
  limit?: number;
  executionCwds?: ReadonlyMap<string, readonly string[]>;
}

export interface WorkspaceScope {
  cwd: string;
  executionCwds: string[];
}

export function buildWorkspaceScopes(
  discoveries: readonly {
    cwd: string;
    worktrees: readonly Pick<GitWorktree, 'path' | 'bare' | 'isMain'>[];
  }[],
): WorkspaceScope[] {
  const scopes = new Map<string, Set<string>>();
  for (const discovery of discoveries) {
    const linkedPaths = discovery.worktrees.flatMap((worktree) =>
      worktree.bare || !worktree.path ? [] : [worktree.path],
    );
    const mainCwd =
      discovery.worktrees.find((worktree) => worktree.isMain && worktree.path)?.path ??
      discovery.cwd;
    const executionCwds = scopes.get(mainCwd) ?? new Set<string>();
    executionCwds.add(mainCwd);
    for (const path of linkedPaths) executionCwds.add(path);
    scopes.set(mainCwd, executionCwds);
  }
  return [...scopes].map(([cwd, executionCwds]) => ({ cwd, executionCwds: [...executionCwds] }));
}

export async function discoverWorkspaceScopes(
  workspaceCwds: readonly string[],
  loadWorktrees: (cwd: string) => Promise<GitWorktree[]>,
): Promise<WorkspaceScope[]> {
  const discoveries = await Promise.all(
    workspaceCwds.map(async (cwd) => ({ cwd, worktrees: await loadWorktrees(cwd) })),
  );
  return buildWorkspaceScopes(discoveries);
}

export function workspaceName(cwd: string): string {
  const base = cwd.split('/').filter(Boolean).pop();
  return base ?? 'Home';
}

// Sidebar "New chat" workspace context. When a top-level session is active it
// owns the next draft: workspace chats keep that folder, folder-less Chats
// (workspaceKind none / empty cwd) stay folder-less even if draftChat still
// holds a stale path. Draft cwd is only used when nothing is selected.
export function resolveNewChatCwd(
  activeSession: { cwd?: string | null; workspaceKind?: 'folder' | 'none' } | null | undefined,
  draftChat: { cwd?: string | null } | null | undefined,
): string {
  if (activeSession) {
    if (activeSession.workspaceKind === 'none') return '';
    return typeof activeSession.cwd === 'string' ? activeSession.cwd.trim() : '';
  }
  return typeof draftChat?.cwd === 'string' ? draftChat.cwd.trim() : '';
}

export function addWorkspaceCwd(existing: string[], cwd: string): string[] {
  const next = cwd.trim();
  if (!next) return existing;
  return [next, ...existing.filter((item) => item !== next)];
}

function repositoryWorkspaceCwd(cwd: string): string {
  const marker = /[\\/]\.worktrees[\\/]/.exec(cwd);
  return marker ? cwd.slice(0, marker.index) : cwd;
}

export function buildWorkspaceSections(
  workspaceCwds: string[],
  sessions: SessionSummary[],
  options: WorkspaceSectionOptions = {},
): WorkspaceSection[] {
  const seen = new Set<string>();
  const workspaces = workspaceCwds.map(repositoryWorkspaceCwd).filter((cwd) => {
    if (!cwd || seen.has(cwd)) return false;
    seen.add(cwd);
    return true;
  });
  const ownerFor = (sessionCwd: string) => {
    const normalizedSessionCwd = sessionCwd.replace(/\\/g, '/');
    return workspaces
      .flatMap((cwd) =>
        (options.executionCwds?.get(cwd) ?? [cwd]).map((executionCwd) => ({
          cwd,
          executionCwd: executionCwd.replace(/\\/g, '/'),
        })),
      )
      .filter(
        ({ executionCwd }) =>
          normalizedSessionCwd === executionCwd ||
          normalizedSessionCwd.startsWith(`${executionCwd}/`),
      )
      .sort((a, b) => b.executionCwd.length - a.executionCwd.length)[0]?.cwd;
  };

  return workspaces.map((cwd) => ({
    cwd,
    name: workspaceName(cwd),
    sessions: maybeLimit(
      sessions
        .filter((session) => ownerFor(session.cwd) === cwd)
        .sort((a, b) => b.updatedAt - a.updatedAt),
      options.limit,
    ),
  }));
}

function maybeLimit<T>(items: T[], limit?: number): T[] {
  return limit === undefined ? items : items.slice(0, Math.max(0, limit));
}
