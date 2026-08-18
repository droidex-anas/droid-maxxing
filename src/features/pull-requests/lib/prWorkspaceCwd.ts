export function resolvePrWorkspaceCwd(input: {
  boundCwd: string | null;
  activeCwd: string | null | undefined;
  workspaceKind?: 'folder' | 'none';
  workspaceCwds: string[];
}): string | null {
  if (input.boundCwd) return input.boundCwd;
  if (input.workspaceKind !== 'none' && input.activeCwd) return input.activeCwd;
  return input.workspaceCwds[0] ?? null;
}
