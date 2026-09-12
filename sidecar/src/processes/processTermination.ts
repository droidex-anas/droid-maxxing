import { descendantsOf, sameProcess, type ProcessRecord } from './processTree.js';

interface ProcessTerminationDependencies {
  listProcesses(signal?: AbortSignal): Promise<ProcessRecord[]>;
  kill(pid: number, signal: 'SIGTERM' | 'SIGKILL'): void;
  scheduleKillPoll(callback: () => void, ms: number): { cancel(): void };
  now(): number;
}

const KILL_GRACE_MS = 3000;
const KILL_POLL_MS = 150;
const DISCOVERY_TIMEOUT_MS = 500;

export async function killProcessTree(
  rows: readonly ProcessRecord[],
  dependencies: ProcessTerminationDependencies,
  discovery?: {
    discover(table: ProcessRecord[]): ProcessRecord[];
    remember(rows: ProcessRecord[]): void;
  },
): Promise<void> {
  if (rows.length === 0 && !discovery) return;
  const deadline = dependencies.now() + KILL_GRACE_MS;
  let targets = new Map(rows.map((row) => [row.pid, row]));
  const terminated = new Map<number, ProcessRecord>();
  const graceExpired = (poll: number) =>
    dependencies.now() >= deadline || poll >= KILL_GRACE_MS / KILL_POLL_MS;
  const signal = (row: ProcessRecord, value: 'SIGTERM' | 'SIGKILL') => {
    try {
      dependencies.kill(row.pid, value);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
    }
  };

  for (let poll = 0; ; poll += 1) {
    let table: ProcessRecord[];
    try {
      table = await readProcessTable(
        dependencies,
        Math.min(
          DISCOVERY_TIMEOUT_MS,
          Math.max(1, deadline + DISCOVERY_TIMEOUT_MS - dependencies.now()),
        ),
      );
    } catch (error) {
      if (graceExpired(poll)) throw error;
      await new Promise<void>((resolve) => {
        dependencies.scheduleKillPoll(resolve, KILL_POLL_MS);
      });
      continue;
    }
    const byPid = new Map(table.map((row) => [row.pid, row]));
    const alive = [...targets.values()].filter((row) => sameProcess(row, byPid.get(row.pid)));
    // Keep observed descendants even after reparenting, and discover new ones
    // only beneath identities verified in this same process table.
    targets = new Map(
      [
        ...alive,
        ...descendantsOf(
          table,
          alive.map((row) => row.pid),
        ),
      ].map((row) => [row.pid, row]),
    );
    if (discovery) {
      for (const row of discovery.discover(table)) targets.set(row.pid, row);
      discovery.remember([...targets.values()]);
    }
    const survivors = [...targets.values()].reverse();
    if (survivors.length === 0 && (poll === 0 || !discovery)) return;
    if (graceExpired(poll)) {
      for (const row of survivors) signal(row, 'SIGKILL');
      return;
    }
    for (const row of survivors) {
      if (sameProcess(row, terminated.get(row.pid))) continue;
      signal(row, 'SIGTERM');
      terminated.set(row.pid, row);
    }
    await new Promise<void>((resolve) => {
      dependencies.scheduleKillPoll(
        resolve,
        Math.min(KILL_POLL_MS, Math.max(1, deadline - dependencies.now())),
      );
    });
  }
}

async function readProcessTable(
  dependencies: ProcessTerminationDependencies,
  timeoutMs: number,
): Promise<ProcessRecord[]> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      dependencies.listProcesses(controller.signal),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error('Process discovery timed out; provider ownership was retained.'));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}
