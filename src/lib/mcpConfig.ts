export function parseMcpVariables(value: string): Record<string, string> {
  const pairs: Record<string, string> = {};
  for (const rawLine of value.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) throw new Error(`Expected KEY=VALUE, received “${line}”.`);
    pairs[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return pairs;
}
