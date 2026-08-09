export function parseMcpVariables(value: string): Record<string, string> {
  const pairs = new Map<string, string>();
  for (const rawLine of value.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) throw new Error(`Expected KEY=VALUE, received “${line}”.`);
    const key = line.slice(0, separator).trim();
    if (!key) throw new Error(`Expected KEY=VALUE, received “${line}”.`);
    if (pairs.has(key)) throw new Error(`Duplicate key “${key}”.`);
    pairs.set(key, line.slice(separator + 1).trim());
  }
  return Object.fromEntries(pairs);
}
