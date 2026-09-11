// Matches a configured command against a live process's full command line, on
// whole tokens only — `npx -y mcp` must not match `npx -y mcp-other`. Mirrors
// `src/lib/commandLineMatch.ts`; the sidecar builds separately and cannot
// import from the renderer.
export function commandLineContains(commandLine: string, needle: string): boolean {
  let from = 0;
  while (from <= commandLine.length) {
    const at = commandLine.indexOf(needle, from);
    if (at < 0) return false;
    const before = at === 0 || /\s/.test(commandLine[at - 1]);
    const afterIndex = at + needle.length;
    const after = afterIndex === commandLine.length || /\s/.test(commandLine[afterIndex]);
    if (before && after) return true;
    from = at + 1;
  }
  return false;
}
