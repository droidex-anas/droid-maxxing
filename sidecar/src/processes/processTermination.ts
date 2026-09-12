import { sameProcess, type ProcessRecord } from './processTree.js';

interface ProcessTerminationDependencies {
  listProcesses(): Promise<ProcessRecord[]>;
  kill(pid: number, signal: 'SIGTERM' | 'SIGKILL'): void;
  scheduleKillPoll(callback: () => void, ms: number): { cancel(): void };
}

const KILL_GRACE_MS = 3000;
const KILL_POLL_MS = 150;

export async function killProcessTree(
  rows: readonly ProcessRecord[],
  dependencies: ProcessTerminationDependencies,
): Promise<void> {
  if (rows.length === 0) return;
  const matching = async (targets: readonly ProcessRecord[]): Promise<ProcessRecord[]> => {
    const table = await dependencies.listProcesses();
    const byPid = new Map(table.map((row) => [row.pid, row]));
    return targets.filter((row) => sameProcess(row, byPid.get(row.pid)));
  };
  const signal = (row: ProcessRecord, value: 'SIGTERM' | 'SIGKILL') => {
    try {
      dependencies.kill(row.pid, value);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
    }
  };

  // Snapshot membership is not identity. Check before TERM as well as KILL,
  // including when a stop arrives between monitor ticks.
  let survivors = await matching([...rows].reverse());
  for (const row of survivors) signal(row, 'SIGTERM');
  for (let waited = 0; survivors.length > 0 && waited < KILL_GRACE_MS; waited += KILL_POLL_MS) {
    await new Promise<void>((resolve) => {
      dependencies.scheduleKillPoll(resolve, KILL_POLL_MS);
    });
    survivors = await matching(survivors);
  }
  for (const row of survivors) signal(row, 'SIGKILL');
}
