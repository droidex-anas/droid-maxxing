import type { AgentProcess } from '../protocol.js';
import { commandLineContains } from './commandLineMatch.js';
import { descendantsOf, sameProcess, type ProcessRecord } from './processTree.js';
import { killProcessTree } from './processTermination.js';
import { sameProcessList, visibleProcesses } from './processPresentation.js';

export interface AgentProcessMonitorDependencies {
  listProcesses: () => Promise<ProcessRecord[]>;
  // Resolves null when the port scan produced nothing usable; the previous
  // snapshot is then kept rather than blanking every port chip.
  listListeningPorts: () => Promise<Map<number, number[]> | null>;
  kill: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => void;
  emit: (appSessionId: string, processes: AgentProcess[]) => void;
  onSnapshotChanged?: () => void;
  schedule: (callback: () => void, ms: number) => { cancel(): void };
  // Referenced twin of `schedule`, used only for the kill grace poll so a
  // shutdown cannot exit the loop before the SIGKILL sweep runs.
  scheduleKillPoll: (callback: () => void, ms: number) => { cancel(): void };
  now: () => number;
}

export const TICK_MS = 2000;
const PORT_SCAN_EVERY = 3;

interface TrackedRoot {
  appSessionId: string;
  adopted: boolean;
  startedAt?: number;
}

function dedupeByPid(rows: readonly ProcessRecord[]): ProcessRecord[] {
  const seen = new Set<number>();
  const out: ProcessRecord[] = [];
  for (const row of rows) {
    if (seen.has(row.pid)) continue;
    seen.add(row.pid);
    out.push(row);
  }
  return out;
}

export class AgentProcessMonitor {
  private readonly roots = new Map<number, TrackedRoot>();
  private readonly closing = new Map<string, Promise<void>>();
  // appSessionId -> command lines the session spawns on the provider's behalf
  // (stdio MCP servers), which belong to no one the user can act on.
  private readonly ignoredCommands = new Map<string, readonly string[]>();
  private readonly current = new Map<string, AgentProcess[]>();
  private readonly published = new Map<string, AgentProcess[]>();
  private readonly descendants = new Map<string, ProcessRecord[]>();
  // pid -> the start time first seen for it, held steady against `ps` jitter.
  private readonly startedAtByPid = new Map<number, number>();
  private ports = new Map<number, number[]>();
  private ticks = 0;
  private timer: { cancel(): void } | null = null;
  private scanning: Promise<void> | null = null;
  private lastScanFailed = false;
  private lastPublishFailed = false;
  private disposed = false;
  private persistedSnapshot = '';
  private snapshotDirty = true;

  constructor(private readonly d: AgentProcessMonitorDependencies) {}

  // Stdio MCP servers are spawned by the provider as its own children, so the
  // walk finds them; they are the agent's plumbing, not the session's work, and
  // a chip row for one would also block idle retirement forever.
  setIgnoredCommands(appSessionId: string, patterns: readonly string[]): void {
    if (patterns.length === 0) this.ignoredCommands.delete(appSessionId);
    else this.ignoredCommands.set(appSessionId, [...patterns]);
  }

  track(appSessionId: string, rootPid: number): void {
    if (this.disposed || this.closing.has(appSessionId)) return;
    if (this.roots.get(rootPid)?.appSessionId === appSessionId) return;
    this.roots.set(rootPid, { appSessionId, adopted: false });
    this.arm();
  }

  // Compaction retires the provider that spawned this session's processes, so
  // re-root its children before it goes: once it exits they are reparented to
  // launchd and nothing can find them from its pid again.
  // Resolves false when the process table could not be read: the caller must
  // then keep the old root tracked, or its children become unkillable orphans.
  async adoptDescendantsAsRoots(
    appSessionId: string,
    rootPid: number,
    isCurrent: () => boolean = () => true,
  ): Promise<boolean> {
    const root = this.roots.get(rootPid);
    if (root?.appSessionId !== appSessionId || this.closing.has(appSessionId)) return false;
    let table: ProcessRecord[];
    try {
      table = await this.d.listProcesses();
    } catch {
      // Nothing to adopt from; the session keeps whatever it already had.
      return false;
    }
    if (this.roots.get(rootPid) !== root || this.closing.has(appSessionId) || !isCurrent())
      return false;
    const parent = table.find((row) => row.pid === rootPid);
    if (
      !parent ||
      (root.startedAt !== undefined && !sameProcess({ startedAt: root.startedAt }, parent))
    )
      return false;
    root.startedAt = parent.startedAt;
    // Direct children only, the walk from each of them is transitive, and a
    // grandchild tracked as well would be listed twice.
    for (const row of table) {
      if (row.ppid !== rootPid) continue;
      this.roots.set(row.pid, { appSessionId, adopted: true, startedAt: row.startedAt });
    }
    this.persistSnapshot();
    return true;
  }

  untrack(rootPid: number): void {
    const appSessionId = this.roots.get(rootPid)?.appSessionId;
    this.roots.delete(rootPid);
    if (appSessionId !== undefined) this.dropIfRootless(appSessionId);
    this.persistSnapshot();
    if (!this.hasWork()) this.disarm();
  }

  // Called once a root is gone: if it was the session's last one, drop its
  // snapshot so processesFor/hasProcesses stop reporting stale processes, and
  // clear the renderer if it was showing something.
  private dropIfRootless(appSessionId: string): void {
    if ([...this.roots.values()].some((root) => root.appSessionId === appSessionId)) return;
    this.ignoredCommands.delete(appSessionId);
    this.descendants.delete(appSessionId);
    this.publish(appSessionId, []);
  }

  processesFor(appSessionId: string): AgentProcess[] {
    return this.current.get(appSessionId) ?? [];
  }

  snapshot(): Record<string, AgentProcess[]> {
    return Object.fromEntries(this.current);
  }

  // Deliberately the visible list, not the raw descendants: a process the
  // user cannot see (a shell wrapper, an MCP stdio server, an infant) must
  // never be the reason a session refuses to retire.
  hasProcesses(appSessionId: string): boolean {
    return this.processesFor(appSessionId).length > 0;
  }

  snapshotPids(): { appSessionId: string; pid: number; startedAt: number }[] {
    const out: { appSessionId: string; pid: number; startedAt: number }[] = [];
    const seen = new Set<number>();
    // Roots first, so `killRecorded` (which signals deepest-last) reaps a
    // parent only after the children it owns. Without them a sidecar that was
    // killed outright leaves the previous run's `droid` processes forever.
    for (const [pid, { appSessionId, startedAt }] of this.roots) {
      if (startedAt === undefined) continue;
      seen.add(pid);
      out.push({ appSessionId, pid, startedAt });
    }
    for (const [appSessionId, rows] of this.descendants) {
      for (const row of rows) {
        if (seen.has(row.pid)) continue;
        seen.add(row.pid);
        out.push({ appSessionId, pid: row.pid, startedAt: row.startedAt });
      }
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
    await killProcessTree([target, ...descendantsOf(rows, [pid])], this.d);
    await this.scan();
    return true;
  }

  killSession(appSessionId: string): Promise<void> {
    const pending = this.closing.get(appSessionId);
    if (pending) return pending;
    const closing = Promise.resolve().then(async () => {
      try {
        await this.scan();
        await killProcessTree(this.descendants.get(appSessionId) ?? [], this.d);
        for (const [pid, root] of this.roots) {
          if (root.appSessionId === appSessionId) this.roots.delete(pid);
        }
        this.dropIfRootless(appSessionId);
        this.persistSnapshot();
      } finally {
        this.closing.delete(appSessionId);
        if (!this.hasWork()) this.disarm();
      }
    });
    this.closing.set(appSessionId, closing);
    return closing;
  }

  async killRecorded(entries: readonly { pid: number; startedAt: number }[]): Promise<void> {
    if (entries.length === 0) return;
    let table: ProcessRecord[];
    try {
      table = await this.d.listProcesses();
    } catch {
      // Can't verify start times against a live process table; leave
      // everything alone rather than risk killing a reused pid.
      return;
    }
    const alive = new Map(table.map((row) => [row.pid, row]));
    const matches = entries.flatMap((entry) => {
      const row = alive.get(entry.pid);
      // A reused pid has a different start time; leave it alone. `ps etime`
      // only resolves to the second, so allow a small window either way.
      return row && sameProcess(entry, row) ? [row] : [];
    });
    await killProcessTree(matches, this.d);
  }

  dispose(): void {
    this.disposed = true;
    this.disarm();
    this.roots.clear();
    this.ignoredCommands.clear();
    this.current.clear();
    this.published.clear();
    this.descendants.clear();
    this.startedAtByPid.clear();
    this.snapshotDirty = false;
  }

  private hasWork(): boolean {
    return (
      !this.disposed &&
      (this.roots.size > 0 ||
        this.snapshotDirty ||
        [...this.current].some(([id, rows]) => {
          const published = this.published.get(id);
          return published === undefined || !sameProcessList(published, rows);
        }))
    );
  }

  private arm(): void {
    if (this.disposed || this.timer) return;
    this.timer = this.d.schedule(() => {
      this.timer = null;
      void this.scan().finally(() => {
        if (this.hasWork()) this.arm();
      });
    }, TICK_MS);
  }

  private disarm(): void {
    this.timer?.cancel();
    this.timer = null;
  }

  // Groups tracked roots by session and computes each session's descendant
  // list, carrying forward an empty list for any session `scanOnce` already
  // knows about but that has no live descendants this tick.
  private computeDescendants(table: ProcessRecord[]): {
    computed: Map<string, ProcessRecord[]>;
    sawNew: boolean;
  } {
    const bySession = new Map<string, number[]>();
    for (const [pid, { appSessionId }] of this.roots) {
      const list = bySession.get(appSessionId) ?? [];
      list.push(pid);
      bySession.set(appSessionId, list);
    }
    let sawNew = false;
    const byPid = new Map(table.map((row) => [row.pid, row]));
    const computed = new Map<string, ProcessRecord[]>();
    for (const [appSessionId, rootPids] of bySession) {
      const adopted = rootPids.flatMap((pid) => {
        const row = this.roots.get(pid)?.adopted ? byPid.get(pid) : undefined;
        return row ? [row] : [];
      });
      // During the compaction adopt window the retiring provider is still a
      // root while its children are roots too, so the walk reaches each of
      // them from both — first occurrence wins.
      const rows = this.withoutIgnored(
        appSessionId,
        dedupeByPid([...adopted, ...descendantsOf(table, rootPids)]),
        table,
      );
      const known = new Set((this.descendants.get(appSessionId) ?? []).map((row) => row.pid));
      if (rows.some((row) => !known.has(row.pid))) sawNew = true;
      computed.set(appSessionId, rows);
    }
    for (const appSessionId of this.current.keys()) {
      if (!computed.has(appSessionId)) computed.set(appSessionId, []);
    }
    return { computed, sawNew };
  }

  // An ignored process takes its whole subtree with it: an MCP server's own
  // children are its implementation detail, not the session's work.
  private withoutIgnored(
    appSessionId: string,
    rows: ProcessRecord[],
    table: readonly ProcessRecord[],
  ): ProcessRecord[] {
    const patterns = this.ignoredCommands.get(appSessionId);
    if (!patterns || patterns.length === 0) return rows;
    const hidden = new Set(
      rows
        .filter((row) => patterns.some((pattern) => commandLineContains(row.command, pattern)))
        .map((row) => row.pid),
    );
    if (hidden.size === 0) return rows;
    for (const row of descendantsOf(table, hidden)) hidden.add(row.pid);
    return rows.filter((row) => !hidden.has(row.pid));
  }

  // A process that has not changed must compare equal between scans, or
  // `publish` re-emits the whole list every tick and the chip's elapsed column
  // ticks backwards. Reuse the first start time seen for a pid while later
  // readings stay inside the `ps` rounding window; a reading outside it is a
  // different process on a recycled pid, so take the new value.
  private stableStartTimes(table: ProcessRecord[]): ProcessRecord[] {
    const seen = new Set<number>();
    const stable = table.map((row) => {
      seen.add(row.pid);
      const remembered = this.startedAtByPid.get(row.pid);
      if (remembered === row.startedAt) return row;
      if (remembered !== undefined && sameProcess({ startedAt: remembered }, row)) {
        return { ...row, startedAt: remembered };
      }
      this.startedAtByPid.set(row.pid, row.startedAt);
      return row;
    });
    for (const pid of this.startedAtByPid.keys()) {
      if (!seen.has(pid)) this.startedAtByPid.delete(pid);
    }
    return stable;
  }

  private async scanOnce(): Promise<void> {
    // Populated only once everything below has succeeded and been committed;
    // the publish loop runs after this try/catch (see below) so a throwing
    // `emit` can never be mistaken for a scan failure.
    let toPublish: Map<string, ProcessRecord[]> | null = null;
    let now = 0;
    try {
      const observedRoots = new Map(this.roots);
      const rootsUnchanged = () =>
        observedRoots.size === this.roots.size &&
        [...observedRoots].every(([pid, root]) => this.roots.get(pid) === root);
      const rawTable = observedRoots.size > 0 ? await this.d.listProcesses() : [];
      if (this.disposed || !rootsUnchanged()) return;
      const table = this.stableStartTimes(rawTable);
      now = this.d.now();
      const { sawNew } = this.computeDescendants(table);
      const nextTick = this.ticks + 1;
      // Fetch ports before committing anything, so a rejection here leaves
      // the previous snapshot (descendants/ports/current) untouched.
      let nextPorts = this.ports;
      if (observedRoots.size === 0) nextPorts = new Map();
      else if (sawNew || nextTick % PORT_SCAN_EVERY === 1)
        nextPorts = (await this.d.listListeningPorts()) ?? this.ports;
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Disposal can occur during port discovery.
      if (this.disposed || !rootsUnchanged()) return;

      this.pruneDeadRoots(table, observedRoots);
      const { computed } = this.computeDescendants(table);
      this.ticks = nextTick;
      this.ports = nextPorts;
      this.descendants.clear();
      for (const [id, rows] of computed) this.descendants.set(id, rows);
      this.lastScanFailed = false;
      toPublish = computed;
    } catch (error) {
      // Keep the previous snapshot untouched; warn once per outage instead
      // of spamming a log line on every 2s tick.
      if (!this.lastScanFailed) {
        this.lastScanFailed = true;
        console.warn('AgentProcessMonitor: scan failed, keeping previous snapshot', error);
      }
    }
    if (!toPublish) return;
    this.persistSnapshot();
    for (const [appSessionId, rows] of toPublish) {
      this.publish(appSessionId, visibleProcesses(rows, now, this.ports));
    }
  }

  private publish(appSessionId: string, processes: AgentProcess[]): void {
    const previous = this.published.get(appSessionId);
    this.current.set(appSessionId, processes);
    if (previous === undefined || !sameProcessList(previous, processes)) {
      try {
        this.d.emit(appSessionId, processes);
      } catch (error) {
        // Keep the authoritative snapshot; only delivery is retried.
        if (!this.lastPublishFailed) {
          this.lastPublishFailed = true;
          console.warn('AgentProcessMonitor: emit failed, will retry next scan', error);
        }
        this.arm();
        return;
      }
      this.published.set(appSessionId, processes);
      this.lastPublishFailed = false;
    }
    if (
      processes.length === 0 &&
      ![...this.roots.values()].some((root) => root.appSessionId === appSessionId)
    ) {
      this.current.delete(appSessionId);
      this.published.delete(appSessionId);
    }
  }

  private persistSnapshot(): void {
    const snapshot = JSON.stringify(this.snapshotPids());
    this.snapshotDirty = snapshot !== this.persistedSnapshot;
    if (!this.snapshotDirty) return;
    try {
      this.d.onSnapshotChanged?.();
      this.persistedSnapshot = snapshot;
      this.snapshotDirty = false;
    } catch (error) {
      console.warn('AgentProcessMonitor: could not persist process snapshot, will retry', error);
      this.arm();
    }
  }

  // Provider roots can exit unexpectedly too. Never attach a reused PID.
  private pruneDeadRoots(
    table: readonly ProcessRecord[],
    observedRoots: ReadonlyMap<number, TrackedRoot>,
  ): void {
    const byPid = new Map(table.map((row) => [row.pid, row] as const));
    const orphaned = new Set<string>();
    for (const [pid, root] of observedRoots) {
      if (this.roots.get(pid) !== root) continue;
      const live = byPid.get(pid);
      if (
        live !== undefined &&
        (root.startedAt === undefined || sameProcess({ startedAt: root.startedAt }, live))
      ) {
        root.startedAt ??= live.startedAt;
        continue;
      }
      this.roots.delete(pid);
      orphaned.add(root.appSessionId);
    }
    // Same cleanup `untrack` does: a session whose last root just died must
    // stop reporting the processes that root used to own.
    for (const appSessionId of orphaned) this.dropIfRootless(appSessionId);
  }
}
