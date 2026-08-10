import { createGitWorktree, getGitEnvironment, getGitWorktrees } from './git';
import type { GitActionResult, GitEnvironment, GitWorktree } from '../types/vcs';

export type ChatWorkingDirectoryResult =
  | { ok: true; path: string }
  | { ok: false; reason: string; message?: string };

export function resolveMainCheckout(
  environment: GitEnvironment,
  worktrees: readonly Pick<GitWorktree, 'path' | 'branch' | 'isMain'>[],
): { path: string; branch?: string } | null {
  const main = worktrees.find((worktree) => worktree.isMain && worktree.path);
  if (main?.path) return { path: main.path, ...(main.branch ? { branch: main.branch } : {}) };
  if (environment.isLinkedWorktree || !environment.repoRoot) return null;
  return {
    path: environment.repoRoot,
    ...(environment.branch ? { branch: environment.branch } : {}),
  };
}

export async function prepareChatWorkingDirectory(
  cwd: string,
  options: {
    executionMode: 'worktree' | 'local';
    base?: string;
    name: string;
  },
): Promise<ChatWorkingDirectoryResult> {
  if (!cwd || options.executionMode === 'local') return { ok: true, path: cwd };

  const [env, worktrees] = await Promise.all([getGitEnvironment(cwd), getGitWorktrees(cwd)]);
  if (!env.isRepo) return { ok: true, path: cwd };

  const mainCheckout = resolveMainCheckout(env, worktrees);
  if (!mainCheckout) {
    return {
      ok: false,
      reason: 'worktree_discovery_pending',
      message: 'The repository worktrees are still loading. Try again.',
    };
  }

  const result: GitActionResult = await createGitWorktree(mainCheckout.path, {
    detached: true,
    base: options.base ?? env.branch ?? env.head ?? 'HEAD',
    name: options.name,
  });
  if (!result.ok) {
    return {
      ok: false,
      reason: result.reason ?? 'worktree_create_failed',
      ...(result.message ? { message: result.message } : {}),
    };
  }
  if (!result.path) {
    return {
      ok: false,
      reason: 'worktree_create_failed',
      message: 'Git did not return the new worktree path.',
    };
  }
  return { ok: true, path: result.path };
}
