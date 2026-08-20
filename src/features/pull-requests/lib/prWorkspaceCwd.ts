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
  const stillKnown =
    input.workspaceCwds.includes(input.boundCwd) || input.boundCwd === input.activeCwd;
  return stillKnown ? input.boundCwd : fallback;
}
