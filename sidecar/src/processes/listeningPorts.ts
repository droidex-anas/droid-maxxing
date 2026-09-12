import type { CommandRunner } from './processTree.js';

// `lsof -F pn` prints one field per line: `p<pid>` starts a process block and
// each `n<addr>` names a socket; only `:port` at the end matters here.
export function parseLsofListeners(stdout: string): Map<number, number[]> {
  const ports = new Map<number, number[]>();
  let pid = 0;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('p')) {
      pid = Number(line.slice(1));
      continue;
    }
    if (!line.startsWith('n') || pid === 0) continue;
    const match = /:(\d+)$/.exec(line);
    if (!match) continue;
    const port = Number(match[1]);
    const list = ports.get(pid) ?? [];
    if (!list.includes(port)) list.push(port);
    ports.set(pid, list);
  }
  return ports;
}

// Resolves null when `lsof` produced nothing usable (missing binary, denied,
// killed). The caller must then keep the ports it already has: committing an
// empty map would blank every port chip until the next port scan.
export async function listListeningPorts(
  run: CommandRunner,
): Promise<Map<number, number[]> | null> {
  if (process.platform === 'win32') return new Map();
  try {
    // Exit 1 with output means "warned but listed"; exit 1 with no output
    // means nothing is listening — both are results, not failures.
    const stdout = await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn']);
    return parseLsofListeners(stdout);
  } catch {
    return null;
  }
}
