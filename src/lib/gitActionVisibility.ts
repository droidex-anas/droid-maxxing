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

export function reconcileGitActionSheet(
  sheet: GitActionSheet,
  isGitHub: boolean,
  githubReady: boolean,
  hasPr: boolean,
  detached: boolean,
): GitActionSheet {
  if (sheet !== 'pr') return sheet;
  return canRenderPrSheet(sheet, isGitHub, githubReady, hasPr, detached) ? sheet : 'none';
}
