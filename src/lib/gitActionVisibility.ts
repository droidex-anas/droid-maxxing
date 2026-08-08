export type GitActionSheet = 'none' | 'commit' | 'pr';

export function canRenderPrSheet(
  sheet: GitActionSheet,
  isGitHub: boolean,
  githubReady: boolean,
  hasPr: boolean,
  detached: boolean,
): boolean {
  return sheet === 'pr' && isGitHub && githubReady && !hasPr && !detached;
}
