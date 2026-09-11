import { descendantsOf, type ProcessRecord } from './processTree.js';

export interface AgentProcess {
  pid: number;
  name: string;
  command: string;
  startedAt: number;
  ports: number[];
}

export interface AgentProcessMonitorDependencies {
  listProcesses: () => Promise<ProcessRecord[]>;
  listListeningPorts: () => Promise<Map<number, number[]>>;
  kill: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => void;
  emit: (appSessionId: string, processes: AgentProcess[]) => void;
  schedule: (callback: () => void, ms: number) => { cancel(): void };
  now: () => number;
}

export const TICK_MS = 2000;
const PORT_SCAN_EVERY = 3;
const MIN_AGE_MS = 1500;
const KILL_GRACE_MS = 3000;
const WRAPPER = /^(?:\S*\/)?(?:sh|zsh|bash|fish|dash)\s+-l?c\b/;

export function displayNameFor(command: string): string {
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

function sameList(a: AgentProcess[], b: AgentProcess[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((x, i) => {
    const y = b[i];
    return x.pid === y.pid && x.command === y.command && x.ports.join(',') === y.ports.join(',');
  });
}

export class AgentProcessMonitor {
  private readonly roots = new Map<number, string>(); // rootPid -> appSessionId
  private readonly current = new Map<string, AgentProcess[]>();
  private readonly descendants = new Map<string, ProcessRecord[]>();
  private ports = new Map<number, number[]>();
  private ticks = 0;
  private timer: { cancel(): void } | null = null;
  private scanning: Promise<void> | null = null;
  private lastScanFailed = false;

  constructor(private readonly d: AgentProcessMonitorDependencies) {}

  track(appSessionId: string, rootPid: number): void {
    this.roots.set(rootPid, appSessionId);
    this.arm();
  }

  untrack(rootPid: number): void {
    this.roots.delete(rootPid);
    if (this.roots.size === 0) this.disarm();
  }

  processesFor(appSessionId: string): AgentProcess[] {
    return this.current.get(appSessionId) ?? [];
  }

  hasProcesses(appSessionId: string): boolean {
    return (this.descendants.get(appSessionId)?.length ?? 0) > 0;
  }

  snapshotPids(): { appSessionId: string; pid: number; startedAt: number }[] {
    const out: { appSessionId: string; pid: number; startedAt: number }[] = [];
    for (const [appSessionId, rows] of this.descendants) {
      for (const row of rows) out.push({ appSessionId, pid: row.pid, startedAt: row.startedAt });
    }
    return out;
  }

  scan(): Promise<void> {
    if (this.scanning) return this.scanning;
    this.scanning = this.scanOnce().finally(() => {
      this.scanning = null;
    });
    return this.scanning;
  }

  async stop(appSessionId: string, pid: number): Promise<boolean> {
    const rows = this.descendants.get(appSessionId) ?? [];
    const target = rows.find((row) => row.pid === pid);
    if (!target) return false;
    await this.killTree([target, ...descendantsOf(rows, [pid])]);
    await this.scan();
    return true;
  }

  async killSession(appSessionId: string): Promise<void> {
    await this.scan();
    const rows = this.descendants.get(appSessionId) ?? [];
    await this.killTree(rows);
    this.descendants.set(appSessionId, []);
    this.publish(appSessionId, []);
    for (const [pid, id] of this.roots) if (id === appSessionId) this.roots.delete(pid);
    if (this.roots.size === 0) this.disarm();
  }

  async killRecorded(entries: readonly { pid: number; startedAt: number }[]): Promise<void> {
    if (entries.length === 0) return;
    const table = await this.d.listProcesses();
    const alive = new Map(table.map((row) => [row.pid, row]));
    const matches = entries.flatMap((entry) => {
      const row = alive.get(entry.pid);
      // A reused pid has a different start time; leave it alone. `ps etime`
      // only resolves to the second, so allow a small window either way.
      return row && Math.abs(row.startedAt - entry.startedAt) < 2000 ? [row] : [];
    });
    await this.killTree(matches);
  }

  dispose(): void {
    this.disarm();
    this.roots.clear();
  }

  private arm(): void {
    if (this.timer) return;
    this.timer = this.d.schedule(() => {
      this.timer = null;
      void this.scan().finally(() => {
        if (this.roots.size > 0) this.arm();
      });
    }, TICK_MS);
  }

  private disarm(): void {
    this.timer?.cancel();
    this.timer = null;
  }

  private async scanOnce(): Promise<void> {
    if (this.roots.size === 0) return;
    let table: ProcessRecord[];
    try {
      table = await this.d.listProcesses();
    } catch (error) {
      // Keep the previous snapshot untouched; warn once per outage instead
      // of spamming a log line on every 2s tick.
      if (!this.lastScanFailed) {
        this.lastScanFailed = true;
        console.warn('AgentProcessMonitor: scan failed, keeping previous snapshot', error);
      }
      return;
    }
    this.lastScanFailed = false;
    const now = this.d.now();
    const bySession = new Map<string, number[]>();
    for (const [pid, appSessionId] of this.roots) {
      const list = bySession.get(appSessionId) ?? [];
      list.push(pid);
      bySession.set(appSessionId, list);
    }
    let sawNew = false;
    const nextDescendants = new Map<string, ProcessRecord[]>();
    for (const [appSessionId, rootPids] of bySession) {
      const rows = descendantsOf(table, rootPids);
      const known = new Set((this.descendants.get(appSessionId) ?? []).map((row) => row.pid));
      if (rows.some((row) => !known.has(row.pid))) sawNew = true;
      nextDescendants.set(appSessionId, rows);
    }
    for (const appSessionId of this.descendants.keys()) {
      if (!nextDescendants.has(appSessionId)) nextDescendants.set(appSessionId, []);
    }
    this.descendants.clear();
    for (const [id, rows] of nextDescendants) this.descendants.set(id, rows);
    this.ticks += 1;
    if (sawNew || this.ticks % PORT_SCAN_EVERY === 1)
      this.ports = await this.d.listListeningPorts();
    for (const [appSessionId, rows] of nextDescendants) {
      const visible = rows
        .filter((row) => now - row.startedAt >= MIN_AGE_MS && !WRAPPER.test(row.command))
        .map((row) => ({
          pid: row.pid,
          name: displayNameFor(row.command),
          command: row.command,
          startedAt: row.startedAt,
          ports: [...(this.ports.get(row.pid) ?? [])].sort((a, b) => a - b),
        }));
      this.publish(appSessionId, visible);
    }
  }

  private publish(appSessionId: string, processes: AgentProcess[]): void {
    const previous = this.current.get(appSessionId) ?? [];
    if (sameList(previous, processes)) return;
    this.current.set(appSessionId, processes);
    this.d.emit(appSessionId, processes);
  }

  // Deepest first so a parent cannot respawn a child we already signalled.
  private async killTree(rows: readonly ProcessRecord[]): Promise<void> {
    if (rows.length === 0) return;
    const ordered = [...rows].reverse();
    for (const row of ordered) this.signal(row.pid, 'SIGTERM');
    await new Promise<void>((resolve) => {
      this.d.schedule(resolve, KILL_GRACE_MS);
    });
    const table = await this.d.listProcesses();
    const alive = new Set(table.map((row) => row.pid));
    for (const row of ordered) if (alive.has(row.pid)) this.signal(row.pid, 'SIGKILL');
  }

  private signal(pid: number, signal: 'SIGTERM' | 'SIGKILL'): void {
    try {
      this.d.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
}
