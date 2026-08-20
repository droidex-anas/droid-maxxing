import { comparablePath } from '../../../lib/pathComparison';

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
