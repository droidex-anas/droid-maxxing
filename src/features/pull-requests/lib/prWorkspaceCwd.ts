import { comparablePath } from '../../../lib/pathComparison';
import { repositoryRootCwd, uniqueRepositoryWorkspaceCwds } from '../../../lib/workspaces';

export function sanitizePersistedPrWorkspace(
  cwdValue: unknown,
  numberValue: unknown,
): { prWorkspaceCwd?: string; prWorkspaceNumber?: number } {
  const cwd = typeof cwdValue === 'string' ? cwdValue : '';
  if (!cwd) return {};
  const number =
    typeof numberValue === 'number' && Number.isInteger(numberValue) && numberValue > 0
      ? numberValue
      : undefined;
  return { prWorkspaceCwd: cwd, prWorkspaceNumber: number };
}

export function resolvePrWorkspaceNumber(
  currentCwd: string | null,
  currentNumber: number | null,
  requestedCwd?: string | null,
  requestedNumber?: number | null,
): number | null {
  if (requestedNumber !== undefined) return requestedNumber;
  if (requestedCwd !== undefined && requestedCwd !== currentCwd) return null;
  return currentNumber;
}

export function selectionForPrWorkspace(
  boundCwd: string | null,
  effectiveCwd: string | null,
  number: number | null,
): number | null {
  if (!boundCwd || !effectiveCwd) return null;
  return comparablePath(boundCwd) === comparablePath(effectiveCwd) ? number : null;
}

export function resolvePrWorkspaceCwd(input: {
  boundCwd: string | null;
  activeCwd: string | null | undefined;
  workspaceKind?: 'folder' | 'none';
  workspaceCwds: string[];
}): string | null {
  const fallback =
    input.workspaceKind !== 'none' && input.activeCwd
      ? input.activeCwd
      : (input.workspaceCwds[0] ?? null);
  if (!input.boundCwd) return fallback;
  // The bound cwd survives a reload, so a workspace folder that has since been
  // removed must not keep the view pinned to a repository that no longer exists.
  // Known folders compare the way the app compares paths everywhere: Windows
  // separators and drive casing name the same folder.
  const bound = comparablePath(input.boundCwd);
  const stillKnown =
    input.workspaceCwds.some((cwd) => comparablePath(cwd) === bound) ||
    (input.activeCwd != null && comparablePath(input.activeCwd) === bound);
  return stillKnown ? input.boundCwd : fallback;
}

function focusPullRequestCwd(input: {
  active: { cwd?: string | null; workspaceKind?: 'folder' | 'none' } | null | undefined;
  draftCwd?: string | null;
}): string | null {
  if (input.active) {
    if (input.active.workspaceKind === 'folder' && input.active.cwd) return input.active.cwd;
    return null;
  }
  const draft = input.draftCwd?.trim();
  return draft || null;
}

export function resolvePrInboxContext(input: {
  active: { cwd?: string | null; workspaceKind?: 'folder' | 'none' } | null | undefined;
  draftCwd?: string | null;
  workspaceCwds: readonly string[];
  boundCwd: string | null;
  boundNumber: number | null;
}): {
  listingCwds: string[];
  currentCwd: string | null;
  boundCwd: string | null;
  selectedNumber: number | null;
} {
  const focusCwd = focusPullRequestCwd(input);
  const listingCwds = uniqueRepositoryWorkspaceCwds([
    ...(focusCwd ? [focusCwd] : []),
    ...input.workspaceCwds,
  ]);
  const currentCwd = repositoryRootCwd(focusCwd) ?? listingCwds[0] ?? null;
  const selectedRoot = repositoryRootCwd(input.boundCwd);
  const boundCwd =
    selectedRoot && listingCwds.some((cwd) => comparablePath(cwd) === comparablePath(selectedRoot))
      ? selectedRoot
      : currentCwd;
  return {
    listingCwds,
    currentCwd,
    boundCwd,
    selectedNumber: selectionForPrWorkspace(selectedRoot, boundCwd, input.boundNumber),
  };
}
