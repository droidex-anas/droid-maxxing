import { createGitWorktree, getGitEnvironment, getGitWorktrees } from './git';
import type { GitActionResult } from '../types/vcs';

export async function prepareChatWorkingDirectory(
  cwd: string,
  options: {
    executionMode: 'worktree' | 'local';
    base?: string;
    name: string;
  },
): Promise<GitActionResult> {
  if (!cwd || options.executionMode === 'local') return { ok: true, path: cwd };

  const [env, worktrees] = await Promise.all([getGitEnvironment(cwd), getGitWorktrees(cwd)]);
  if (!env.isRepo) return { ok: true, path: cwd };

  const repositoryCwd = worktrees.find((worktree) => worktree.isMain)?.path ?? env.repoRoot ?? cwd;
  return createGitWorktree(repositoryCwd, {
    detached: true,
    base: options.base ?? env.branch ?? env.head ?? 'HEAD',
    name: options.name,
  });
}
