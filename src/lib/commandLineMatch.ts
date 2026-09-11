// Matches the command an agent typed against a live process's full command
// line, on whole tokens only — `npm run dev` must not match `npm run dev:api`.
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
