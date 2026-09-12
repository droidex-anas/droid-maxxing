import type { AgentProcess } from '../protocol.js';
import type { ProcessRecord } from './processTree.js';

const MIN_AGE_MS = 1500;
const WRAPPER = /^(?:\S*\/)?(?:sh|zsh|bash|fish|dash)\s+-l?c\b/;

function displayNameFor(command: string): string {
  const words = command.split(/\s+/).filter(Boolean);
  let index = 0;
  const base = (word: string) => word.split('/').pop() ?? word;
  // Interpreters name the script, not themselves.
  if (
    /^(?:node|bun|deno|python\d*|ruby|perl)$/.test(base(words[0] ?? '')) &&
    words[1] &&
    !words[1].startsWith('-')
  ) {
    index = 1;
  }
  const head = base(words[index] ?? command);
  const next = words[index + 1];
  return next && !next.startsWith('-') && !next.includes('/') ? `${head} ${next}` : head;
}

export function sameProcessList(a: AgentProcess[], b: AgentProcess[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((x, i) => {
    const y = b[i];
    return (
      x.pid === y.pid &&
      x.command === y.command &&
      x.originCommand === y.originCommand &&
      x.startedAt === y.startedAt &&
      x.ports.join(',') === y.ports.join(',')
    );
  });
}

export function visibleProcesses(
  rows: readonly ProcessRecord[],
  now: number,
  ports: ReadonlyMap<number, number[]>,
): AgentProcess[] {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  return rows
    .filter((row) => now - row.startedAt >= MIN_AGE_MS && !WRAPPER.test(row.command))
    .map((row) => {
      let parent = byPid.get(row.ppid);
      let originCommand: string | undefined;
      const seen = new Set([row.pid]);
      while (parent && !seen.has(parent.pid)) {
        seen.add(parent.pid);
        if (WRAPPER.test(parent.command)) originCommand = parent.command;
        parent = byPid.get(parent.ppid);
      }
      return {
        pid: row.pid,
        name: displayNameFor(row.command),
        command: row.command,
        ...(originCommand ? { originCommand } : {}),
        startedAt: row.startedAt,
        ports: [...(ports.get(row.pid) ?? [])].sort((a, b) => a - b),
      };
    });
}
