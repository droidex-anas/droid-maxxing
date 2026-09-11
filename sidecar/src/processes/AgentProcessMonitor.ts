import type { AgentProcess } from '../protocol.js';
import { commandLineContains } from './commandLineMatch.js';
import { descendantsOf, type ProcessRecord } from './processTree.js';

export interface AgentProcessMonitorDependencies {
  listProcesses: () => Promise<ProcessRecord[]>;
  // Resolves null when the port scan produced nothing usable; the previous
  // snapshot is then kept rather than blanking every port chip.
  listListeningPorts: () => Promise<Map<number, number[]> | null>;
  kill: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => void;
  emit: (appSessionId: string, processes: AgentProcess[]) => void;
  schedule: (callback: () => void, ms: number) => { cancel(): void };
  // Referenced twin of `schedule`, used only for the kill grace poll so a
  // shutdown cannot exit the loop before the SIGKILL sweep runs.
  scheduleKillPoll: (callback: () => void, ms: number) => { cancel(): void };
  now: () => number;
}

export const TICK_MS = 2000;
const PORT_SCAN_EVERY = 3;
const MIN_AGE_MS = 1500;
const KILL_GRACE_MS = 3000;
// Shutdown closes every session, and the sidecar force-exits a few seconds
// later: waiting out the whole grace for a process that already died would
// spend the entire budget on the first session.
const KILL_POLL_MS = 150;
// `ps etime` resolves only to the second, so a start time derived from it can
// read up to a second either side of the real one.
const START_TIME_TOLERANCE_MS = 2000;
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

function sameList(a: AgentProcess[], b: AgentProcess[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((x, i) => {
    const y = b[i];
    return (
      x.pid === y.pid &&
      x.command === y.command &&
      x.startedAt === y.startedAt &&
      x.ports.join(',') === y.ports.join(',')
    );
  });
}

export class AgentProcessMonitor {
  private readonly roots = new Map<number, string>(); // rootPid -> appSessionId
  // Roots inherited from a provider that is about to exit (compaction). Unlike
  // a provider root, the process itself is one of the session's, so it belongs
  // in the published list rather than only its children.
  private readonly adoptedRoots = new Set<number>();
  // Start time each adopted root had when it was adopted, so a recycled pid
  // is recognised as a different process rather than re-attached.
  private readonly adoptedStartedAt = new Map<number, number>();
  // appSessionId -> command lines the session spawns on the provider's behalf
  // (stdio MCP servers), which belong to no one the user can act on.
  private readonly ignoredCommands = new Map<string, readonly string[]>();
  private readonly current = new Map<string, AgentProcess[]>();
  private readonly descendants = new Map<string, ProcessRecord[]>();
  private rootStartedAt = new Map<number, number>(); // rootPid -> startedAt, last scan
  // pid -> the start time first seen for it, held steady against `ps` jitter.
  private readonly startedAtByPid = new Map<number, number>();
  private ports = new Map<number, number[]>();
  private ticks = 0;
  private timer: { cancel(): void } | null = null;
  private scanning: Promise<void> | null = null;
  private lastScanFailed = false;
  private lastPublishFailed = false;

  constructor(private readonly d: AgentProcessMonitorDependencies) {}

  // Stdio MCP servers are spawned by the provider as its own children, so the
  // walk finds them; they are the agent's plumbing, not the session's work, and
  // a chip row for one would also block idle retirement forever.
  setIgnoredCommands(appSessionId: string, patterns: readonly string[]): void {
    if (patterns.length === 0) this.ignoredCommands.delete(appSessionId);
    else this.ignoredCommands.set(appSessionId, [...patterns]);
  }

  track(appSessionId: string, rootPid: number): void {
    this.roots.set(rootPid, appSessionId);
    this.arm();
  }

  // Compaction retires the provider that spawned this session's processes, so
  // re-root its children before it goes: once it exits they are reparented to
  // launchd and nothing can find them from its pid again.
  // Resolves false when the process table could not be read: the caller must
  // then keep the old root tracked, or its children become unkillable orphans.
  async adoptDescendantsAsRoots(appSessionId: string, rootPid: number): Promise<boolean> {
    let table: ProcessRecord[];
    try {
      table = await this.d.listProcesses();
    } catch {
      // Nothing to adopt from; the session keeps whatever it already had.
      return false;
    }
    // Direct children only — the walk from each of them is transitive, and a
    // grandchild tracked as well would be listed twice.
    for (const row of table) {
      if (row.ppid !== rootPid) continue;
      this.adoptedRoots.add(row.pid);
      this.adoptedStartedAt.set(row.pid, row.startedAt);
      this.track(appSessionId, row.pid);
    }
    return true;
  }

  untrack(rootPid: number): void {
    const appSessionId = this.roots.get(rootPid);
    this.roots.delete(rootPid);
    this.adoptedRoots.delete(rootPid);
    this.adoptedStartedAt.delete(rootPid);
    if (appSessionId !== undefined) this.dropIfRootless(appSessionId);
    if (this.roots.size === 0) this.disarm();
  }

  // Called once a root is gone: if it was the session's last one, drop its
  // snapshot so processesFor/hasProcesses stop reporting stale processes, and
  // clear the renderer if it was showing something.
  private dropIfRootless(appSessionId: string): void {
    if ([...this.roots.values()].includes(appSessionId)) return;
    this.ignoredCommands.delete(appSessionId);
    this.descendants.delete(appSessionId);
    const previous = this.current.get(appSessionId);
    this.current.delete(appSessionId);
    if (previous && previous.length > 0) this.d.emit(appSessionId, []);
  }

  processesFor(appSessionId: string): AgentProcess[] {
    return this.current.get(appSessionId) ?? [];
  }

  // Deliberately the published list, not the raw descendants: a process the
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
    for (const [pid, appSessionId] of this.roots) {
      const startedAt = this.rootStartedAt.get(pid);
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
    // Same cleanup `untrack` does when a session loses its last root: the
    // session is gone, so nothing should keep reporting an empty list for it.
    for (const [pid, id] of this.roots) {
      if (id !== appSessionId) continue;
      this.roots.delete(pid);
      this.adoptedRoots.delete(pid);
    }
    this.ignoredCommands.delete(appSessionId);
    this.descendants.delete(appSessionId);
    this.current.delete(appSessionId);
    if (this.roots.size === 0) this.disarm();
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
      return row && Math.abs(row.startedAt - entry.startedAt) < START_TIME_TOLERANCE_MS
        ? [row]
        : [];
    });
    await this.killTree(matches);
  }

  dispose(): void {
    this.disarm();
    this.roots.clear();
    this.adoptedRoots.clear();
    this.adoptedStartedAt.clear();
    this.ignoredCommands.clear();
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

  // Groups tracked roots by session and computes each session's descendant
  // list, carrying forward an empty list for any session `scanOnce` already
  // knows about but that has no live descendants this tick.
  private computeDescendants(table: ProcessRecord[]): {
    computed: Map<string, ProcessRecord[]>;
    sawNew: boolean;
  } {
    const bySession = new Map<string, number[]>();
    for (const [pid, appSessionId] of this.roots) {
      const list = bySession.get(appSessionId) ?? [];
      list.push(pid);
      bySession.set(appSessionId, list);
    }
    let sawNew = false;
    const byPid = new Map(table.map((row) => [row.pid, row]));
    const computed = new Map<string, ProcessRecord[]>();
    for (const [appSessionId, rootPids] of bySession) {
      const adopted = rootPids.flatMap((pid) => {
        const row = this.adoptedRoots.has(pid) ? byPid.get(pid) : undefined;
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
    for (const appSessionId of this.descendants.keys()) {
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
      if (
        remembered !== undefined &&
        Math.abs(remembered - row.startedAt) < START_TIME_TOLERANCE_MS
      ) {
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

  private visibleProcesses(rows: readonly ProcessRecord[], now: number): AgentProcess[] {
    return rows
      .filter((row) => now - row.startedAt >= MIN_AGE_MS && !WRAPPER.test(row.command))
      .map((row) => ({
        pid: row.pid,
        name: displayNameFor(row.command),
        command: row.command,
        startedAt: row.startedAt,
        ports: [...(this.ports.get(row.pid) ?? [])].sort((a, b) => a - b),
      }));
  }

  private async scanOnce(): Promise<void> {
    if (this.roots.size === 0) return;
    // Populated only once everything below has succeeded and been committed;
    // the publish loop runs after this try/catch (see below) so a throwing
    // `emit` can never be mistaken for a scan failure.
    let toPublish: Map<string, ProcessRecord[]> | null = null;
    let now = 0;
    try {
      const table = this.stableStartTimes(await this.d.listProcesses());
      now = this.d.now();
      this.pruneDeadAdoptedRoots(table);
      const { computed, sawNew } = this.computeDescendants(table);
      const nextTick = this.ticks + 1;
      // Fetch ports before committing anything, so a rejection here leaves
      // the previous snapshot (descendants/ports/current) untouched.
      const nextPorts =
        sawNew || nextTick % PORT_SCAN_EVERY === 1
          ? ((await this.d.listListeningPorts()) ?? this.ports)
          : this.ports;

      // `untrack()` can run synchronously between any of the awaits above
      // (it isn't gated by `scanning`) and already cleared/republished for
      // any session that lost its last root. Drop those sessions from what
      // we're about to commit so we never resurrect a stale snapshot or
      // re-emit a list `untrack` already cleared.
      const liveSessions = new Set(this.roots.values());
      for (const appSessionId of [...computed.keys()]) {
        if (!liveSessions.has(appSessionId)) computed.delete(appSessionId);
      }

      this.ticks = nextTick;
      this.ports = nextPorts;
      this.rootStartedAt = new Map(
        table.flatMap((row) =>
          this.roots.has(row.pid) ? [[row.pid, row.startedAt] as const] : [],
        ),
      );
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
    for (const [appSessionId, rows] of toPublish) {
      this.publish(appSessionId, this.visibleProcesses(rows, now));
    }
  }

  private publish(appSessionId: string, processes: AgentProcess[]): void {
    const previous = this.current.get(appSessionId);
    // The first publication always emits, even when it is empty: it is what
    // writes a freshly tracked root into the crash-reap journal.
    if (previous !== undefined && sameList(previous, processes)) return;
    // Commit before emitting: the consumer reads `processesFor`/`hasProcesses`
    // from inside the callback and must see the list it is being handed.
    this.current.set(appSessionId, processes);
    try {
      this.d.emit(appSessionId, processes);
    } catch (error) {
      // Roll back so the next scan sees a diff again and retries the emit
      // instead of silently dropping the update.
      if (previous === undefined) this.current.delete(appSessionId);
      else this.current.set(appSessionId, previous);
      if (!this.lastPublishFailed) {
        this.lastPublishFailed = true;
        console.warn('AgentProcessMonitor: emit failed, will retry next scan', error);
      }
      return;
    }
    this.lastPublishFailed = false;
  }

  // An adopted root is a process whose lifetime we don't own. Drop it once it
  // exits, or a recycled pid would later re-attach a stranger to this session.
  private pruneDeadAdoptedRoots(table: readonly ProcessRecord[]): void {
    if (this.adoptedRoots.size === 0) return;
    const byPid = new Map(table.map((row) => [row.pid, row] as const));
    const orphaned = new Set<string>();
    for (const pid of this.adoptedRoots) {
      // pid alone is not identity: a recycled pid would re-attach a stranger
      // to this session, so the live row must still be the process we adopted.
      const live = byPid.get(pid);
      const adoptedAt = this.adoptedStartedAt.get(pid);
      if (
        live !== undefined &&
        (adoptedAt === undefined || Math.abs(live.startedAt - adoptedAt) < START_TIME_TOLERANCE_MS)
      ) {
        continue;
      }
      this.adoptedRoots.delete(pid);
      this.adoptedStartedAt.delete(pid);
      const appSessionId = this.roots.get(pid);
      this.roots.delete(pid);
      if (appSessionId !== undefined) orphaned.add(appSessionId);
    }
    // Same cleanup `untrack` does: a session whose last root just died must
    // stop reporting the processes that root used to own.
    for (const appSessionId of orphaned) this.dropIfRootless(appSessionId);
  }

  // Deepest first so a parent cannot respawn a child we already signalled.
  // Returns as soon as every target is gone; the grace is a cap, not a sleep,
  // because shutdown pays this for every session inside a few seconds.
  private async killTree(rows: readonly ProcessRecord[]): Promise<void> {
    if (rows.length === 0) return;
    const ordered = [...rows].reverse();
    for (const row of ordered) this.signal(row.pid, 'SIGTERM');
    let survivors: ProcessRecord[] = [];
    for (let waited = 0; waited < KILL_GRACE_MS; waited += KILL_POLL_MS) {
      await new Promise<void>((resolve) => {
        this.d.scheduleKillPoll(resolve, KILL_POLL_MS);
      });
      let table: ProcessRecord[];
      try {
        table = await this.d.listProcesses();
      } catch {
        // Can't confirm who's still alive; skip the SIGKILL sweep rather than
        // risk signalling a pid that's since been reused. The next scan will
        // pick up any survivor.
        return;
      }
      const byPid = new Map(table.map((row) => [row.pid, row] as const));
      // Same identity check every other kill path makes: a pid recycled during
      // the grace window must not be SIGKILLed as if it were our target.
      survivors = ordered.filter((row) => {
        const live = byPid.get(row.pid);
        return (
          live !== undefined && Math.abs(live.startedAt - row.startedAt) < START_TIME_TOLERANCE_MS
        );
      });
      if (survivors.length === 0) return;
    }
    for (const row of survivors) this.signal(row.pid, 'SIGKILL');
  }

  private signal(pid: number, signal: 'SIGTERM' | 'SIGKILL'): void {
    try {
      this.d.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
}
