import { execFile } from 'node:child_process';

export interface ProcessRecord {
  pid: number;
  ppid: number;
  startedAt: number;
  command: string;
}

export type CommandRunner = (file: string, args: string[]) => Promise<string>;

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function defaultCommandRunner(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error && !stdout) reject(asError(error));
      else resolve(stdout);
    });
  });
}

// `ps -axo pid=,ppid=,etimes=,command=`: three numeric columns then the rest
// of the line is the command with its arguments.
export function parsePsTable(stdout: string, now: number): ProcessRecord[] {
  const rows: ProcessRecord[] = [];
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      startedAt: now - Number(match[3]) * 1000,
      command: match[4].trim(),
    });
  }
  return rows;
}

export function descendantsOf(
  table: readonly ProcessRecord[],
  roots: Iterable<number>,
): ProcessRecord[] {
  const byParent = new Map<number, ProcessRecord[]>();
  for (const row of table) {
    const siblings = byParent.get(row.ppid);
    if (siblings) siblings.push(row);
    else byParent.set(row.ppid, [row]);
  }
  const out: ProcessRecord[] = [];
  const queue = Array.from(roots);
  while (queue.length > 0) {
    const parent = queue[queue.length - 1];
    queue.pop();
    for (const child of byParent.get(parent) ?? []) {
      out.push(child);
      queue.push(child.pid);
    }
  }
  return out;
}

export async function listProcesses(
  run: CommandRunner,
  now: () => number,
): Promise<ProcessRecord[]> {
  if (process.platform === 'win32') return [];
  const stdout = await run('ps', ['-axo', 'pid=,ppid=,etimes=,command=']);
  return parsePsTable(stdout, now());
}
