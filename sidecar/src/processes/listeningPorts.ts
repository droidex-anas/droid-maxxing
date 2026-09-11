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

export async function listListeningPorts(run: CommandRunner): Promise<Map<number, number[]>> {
  if (process.platform === 'win32') return new Map();
  try {
    const stdout = await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn']);
    return parseLsofListeners(stdout);
  } catch {
    // lsof exits 1 when nothing listens; that is an empty result, not a failure.
    return new Map();
  }
}
