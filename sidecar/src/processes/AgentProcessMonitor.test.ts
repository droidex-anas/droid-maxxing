import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AgentProcessMonitor,
  TICK_MS,
  type AgentProcessMonitorDependencies,
} from './AgentProcessMonitor.js';
import type { ProcessRecord } from './processTree.js';

function harness(
  rows: ProcessRecord[],
  ports = new Map<number, number[]>(),
  overrides: Partial<AgentProcessMonitorDependencies> = {},
) {
  const emitted: Array<[string, unknown]> = [];
  const killed: Array<[number, string]> = [];
  let timers: Array<() => void> = [];
  let time = 100_000;
  const monitor = new AgentProcessMonitor({
    listProcesses: async () => rows,
    listListeningPorts: async () => ports,
    kill: (pid, signal) => {
      killed.push([pid, signal]);
      rows = rows.filter((r) => r.pid !== pid);
    },
    emit: (id, processes) => emitted.push([id, processes]),
    // The kill grace poll always fires immediately here; `kill` above drops
    // the pid from the table so the poll sees it gone.
    scheduleKillPoll: (cb) => {
      setImmediate(cb);
      return { cancel() {} };
    },
    schedule: (cb, ms) => {
      // Only the scan tick is held for `tick()`; the kill grace and the 150ms
      // liveness polls inside it fire immediately, and `kill` above drops the
      // pid from the table so a poll sees it gone.
      if (ms !== TICK_MS) {
        setImmediate(cb);
        return { cancel() {} };
      }
      timers.push(cb);
      return {
        cancel() {
          timers = timers.filter((t) => t !== cb);
        },
      };
    },
    now: () => time,
    ...overrides,
  });
  const tick = async () => {
    const pending = timers;
    timers = [];
    for (const cb of pending) cb();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  };
  return {
    monitor,
    emitted,
    killed,
    tick,
    advance: (ms: number) => {
      time += ms;
    },
    setRows: (r: ProcessRecord[]) => {
      rows = r;
    },
  };
}

const rows: ProcessRecord[] = [
  { pid: 600, ppid: 1, startedAt: 0, command: '/usr/local/bin/droid exec' },
  { pid: 700, ppid: 600, startedAt: 0, command: '/bin/zsh -c npm run dev' },
  { pid: 800, ppid: 700, startedAt: 0, command: 'node /w/node_modules/.bin/vite' },
];

test('unobserved recycled providers and stale cleanup cannot take another session’s processes', async () => {
  const h = harness(rows);
  let providerAlive = true;
  h.monitor.track('s1', 600, () => providerAlive);
  h.advance(10_000);
  providerAlive = false;
  h.setRows(rows.map((row) => ({ ...row, startedAt: 50_000 })));
  assert.equal(await h.monitor.adoptDescendantsAsRoots('s1', 600), false);
  await h.monitor.killSession('s1');
  assert.deepEqual(h.killed, []);

  h.monitor.track('s2', 600, () => true);
  await h.monitor.scan();
  h.monitor.untrack(600, 's1');
  assert.equal(h.monitor.hasProcesses('s2'), true);
  assert.equal(h.monitor.snapshotPids()[0]?.appSessionId, 's2');
  h.monitor.dispose();
});

test('second-granular startedAt jitter does not re-emit an unchanged list', async () => {
  const h = harness(rows);
  h.monitor.track('s1', 600, () => true);
  await h.monitor.scan();
  assert.equal(h.emitted.length, 1);

  // Same processes, `ps etime` rounding read them 700ms later.
  h.setRows(rows.map((row) => ({ ...row, startedAt: row.startedAt + 700 })));
  await h.monitor.scan();
  assert.equal(h.emitted.length, 1);

  // A new descendant on a recycled pid, not a replacement provider.
  h.setRows(rows.map((row) => (row.pid === 800 ? { ...row, startedAt: 9000 } : row)));
  await h.monitor.scan();
  assert.equal(h.emitted.length, 2);
  assert.equal(h.monitor.processesFor('s1')[0]?.startedAt, 9000);
});

test('scan hides shell wrappers, emits once per change, and attaches ports', async () => {
  const wrapper = '/bin/bash --login -o pipefail -ec npm run dev';
  const h = harness(
    rows.map((row) => (row.pid === 700 ? { ...row, command: wrapper } : row)),
    new Map([[800, [5173]]]),
  );
  h.monitor.track('s1', 600, () => true);
  await h.monitor.scan();
  assert.equal(h.emitted.length, 1);
  assert.deepEqual(h.emitted[0], [
    's1',
    [
      {
        pid: 800,
        name: 'vite',
        command: 'node /w/node_modules/.bin/vite',
        originCommand: wrapper,
        startedAt: 0,
        ports: [5173],
      },
    ],
  ]);
  await h.monitor.scan();
  assert.equal(h.emitted.length, 1);
  const fishWrapper = '/bin/fish --command=npm run dev';
  h.setRows(rows.map((row) => (row.pid === 700 ? { ...row, command: fishWrapper } : row)));
  await h.monitor.scan();
  assert.deepEqual(
    h.monitor.processesFor('s1').map((row) => row.originCommand),
    [fishWrapper],
  );
});

test('processes younger than MIN_AGE_MS are not shown yet', async () => {
  const young = rows.map((r) => (r.pid === 800 ? { ...r, startedAt: 99_500 } : r));
  const h = harness(young);
  h.monitor.track('s1', 600, () => true);
  await h.monitor.scan();
  // The first publication always goes out so the root reaches the reap
  // journal, but it carries nothing yet.
  assert.deepEqual(h.emitted, [['s1', []]]);
  h.advance(2000);
  await h.monitor.scan();
  assert.equal(h.emitted.length, 2);
});

test('a tracked root with no visible descendants still emits once', async () => {
  const h = harness([{ pid: 600, ppid: 1, startedAt: 90_000, command: 'droid' }], new Map(), {
    scheduleKillPoll: () => {
      throw new Error('an idle provider must not wait for kill grace');
    },
  });
  h.monitor.track('s1', 600, () => true);
  await h.monitor.scan();
  assert.deepEqual(h.emitted, [['s1', []]]);
  // ...and does not repeat it every tick.
  await h.monitor.scan();
  assert.equal(h.emitted.length, 1);
  await h.monitor.killSession('s1');
});

test('stop validates the pid against the session snapshot and tree-kills it', async () => {
  const h = harness(rows);
  h.monitor.track('s1', 600, () => true);
  await h.monitor.scan();
  assert.equal(await h.monitor.stop('s1', 4242), false);
  assert.equal(await h.monitor.stop('s1', 800), true);
  assert.deepEqual(h.killed[0], [800, 'SIGTERM']);
});

test('overlapping session kills wait for the same process cleanup', async () => {
  let releaseTable: (table: ProcessRecord[]) => void = () => {};
  let discoveryStarted: () => void = () => {};
  const pendingTable = new Promise<ProcessRecord[]>((resolve) => {
    releaseTable = resolve;
  });
  const started = new Promise<void>((resolve) => {
    discoveryStarted = resolve;
  });
  let currentRows = rows;
  let firstRead = true;
  const killed: Array<[number, string]> = [];
  const h = harness(rows, new Map(), {
    listProcesses: () => {
      discoveryStarted();
      if (!firstRead) return Promise.resolve(currentRows);
      firstRead = false;
      return pendingTable;
    },
    listListeningPorts: () => {
      throw new Error('shutdown must not wait for lsof');
    },
    kill: (pid, signal) => {
      killed.push([pid, signal]);
      currentRows = currentRows.filter((row) => row.pid !== pid);
    },
  });
  h.monitor.track('s1', 600, () => true);
  const closing = h.monitor.killSession('s1');
  await started;
  let cleanupFinished = false;
  const overlapping = h.monitor.killSession('s1').then(() => {
    cleanupFinished = true;
  });
  try {
    await Promise.resolve();
    assert.equal(cleanupFinished, false, 'provider cleanup must not overtake the kill pass');
  } finally {
    releaseTable(rows);
    await Promise.all([closing, overlapping]);
    h.monitor.dispose();
  }
  assert.equal(cleanupFinished, true);
  assert.deepEqual(killed, [
    [800, 'SIGTERM'],
    [700, 'SIGTERM'],
  ]);
  assert.deepEqual(h.emitted.at(-1), ['s1', []]);
});

test('hung discovery is aborted within the shutdown budget and retains ownership for retry', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100_000 });
  let hung = false;
  const reads: AbortSignal[] = [];
  let currentRows = rows;
  const h = harness(rows, new Map(), {
    now: Date.now,
    listProcesses: (signal) => {
      if (hung) {
        if (signal) reads.push(signal);
        return new Promise(() => {});
      }
      return Promise.resolve(currentRows);
    },
    scheduleKillPoll: (callback, ms) => {
      const timer = setTimeout(callback, ms);
      return { cancel: () => clearTimeout(timer) };
    },
    kill: (pid) => {
      currentRows = currentRows.filter((row) => row.pid !== pid);
    },
  });
  h.monitor.track('s1', 600, () => true);
  await h.monitor.scan();
  const owned = h.monitor.snapshotPids();
  hung = true;
  const closing = assert.rejects(h.monitor.killSession('s1'), /discovery timed out/);
  for (let elapsed = 0; elapsed <= 3500; elapsed += 50) {
    await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(50);
  }
  await closing;
  assert.ok(reads.length > 1);
  assert.ok(reads.every((signal) => signal.aborted));
  assert.deepEqual(h.monitor.snapshotPids(), owned);
  hung = false;
  const retry = h.monitor.killSession('s1');
  for (let elapsed = 0; elapsed <= 3500; elapsed += 50) {
    await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(50);
  }
  await retry;
  assert.deepEqual(
    currentRows.map((row) => row.pid),
    [600],
  );
  assert.deepEqual(h.monitor.snapshotPids(), []);
  h.monitor.dispose();
});

test('the grace sweep discovers new descendants and counts process-read time', async () => {
  let now = 100_000;
  let currentRows = [
    ...rows,
    { pid: 610, ppid: 1, startedAt: 0, command: 'droid unused-provider' },
  ];
  const killed: Array<[number, string]> = [];
  const h = harness(rows, new Map(), {
    now: () => now,
    listProcesses: async () => {
      now += 400;
      return currentRows;
    },
    scheduleKillPoll: (callback, ms) => {
      now += ms;
      setImmediate(callback);
      return { cancel() {} };
    },
    kill: (pid, signal) => {
      killed.push([pid, signal]);
      if (pid === 800 && signal === 'SIGTERM') {
        currentRows = [
          ...currentRows,
          { pid: 900, ppid: 800, startedAt: now, command: 'node late-child.js' },
          { pid: 901, ppid: 600, startedAt: now, command: 'node late-sibling.js' },
        ];
      }
    },
  });
  h.monitor.track('s1', 600, () => true);
  h.monitor.track('s1', 610, () => true, 'provisional');
  await h.monitor.killSession('s1');
  assert.ok(now - 100_000 <= 3500, 'ps time is part of the grace budget');
  assert.deepEqual(
    killed
      .filter(([, signal]) => signal === 'SIGKILL')
      .map(([pid]) => pid)
      .sort(),
    [610, 700, 800, 900, 901],
  );
  assert.ok(killed.some(([pid, signal]) => pid === 900 && signal === 'SIGTERM'));
  h.monitor.dispose();
});

test('killRecorded only touches pids whose start time still matches', async () => {
  const h = harness(rows);
  await h.monitor.killRecorded([
    { pid: 800, startedAt: 0 },
    { pid: 700, startedAt: 12345 },
  ]);
  assert.deepEqual(
    h.killed.map(([pid]) => pid),
    [800],
  );
});

test('scan leaves the previous snapshot untouched when listProcesses rejects, and resumes after', async () => {
  let shouldFail = true;
  const emitted: Array<[string, unknown]> = [];
  const monitor = new AgentProcessMonitor({
    listProcesses: async () => {
      if (shouldFail) {
        shouldFail = false;
        throw new Error('ps failed');
      }
      return rows;
    },
    listListeningPorts: async () => new Map(),
    kill: () => {},
    emit: (id, processes) => emitted.push([id, processes]),
    schedule: () => ({ cancel() {} }),
    scheduleKillPoll: (cb) => {
      setImmediate(cb);
      return { cancel() {} };
    },
    now: () => 100_000,
  });
  monitor.track('s1', 600, () => true);

  // First scan fails; must not throw, must not emit, must not produce an
  // unhandled rejection.
  await assert.doesNotReject(() => monitor.scan());
  assert.equal(emitted.length, 0);

  // A later successful scan resumes normally.
  await monitor.scan();
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0][0], 's1');
});

test('a rejecting listListeningPorts leaves the previous snapshot untouched and scan() resolves', async () => {
  let currentRows = rows;
  let failPorts = false;
  const emitted: Array<[string, unknown]> = [];
  const monitor = new AgentProcessMonitor({
    listProcesses: async () => currentRows,
    listListeningPorts: async () => {
      if (failPorts) {
        failPorts = false;
        throw new Error('lsof failed');
      }
      return new Map([[800, [5173]]]);
    },
    kill: () => {},
    emit: (id, processes) => emitted.push([id, processes]),
    schedule: () => ({ cancel() {} }),
    scheduleKillPoll: (cb) => {
      setImmediate(cb);
      return { cancel() {} };
    },
    now: () => 100_000,
  });
  monitor.track('s1', 600, () => true);

  // Tick 1 always refreshes ports; this one succeeds.
  await monitor.scan();
  assert.equal(emitted.length, 1);
  const snapshotBefore = monitor.processesFor('s1');
  assert.equal(monitor.hasProcesses('s1'), true);

  // A new descendant forces the next scan to refresh ports too, and that
  // fetch rejects. scanOnce must not throw, and must not commit anything.
  currentRows = [...rows, { pid: 900, ppid: 800, startedAt: 100_000, command: 'node child.js' }];
  failPorts = true;
  await assert.doesNotReject(() => monitor.scan());
  assert.deepEqual(monitor.processesFor('s1'), snapshotBefore);
  assert.equal(monitor.hasProcesses('s1'), true);
  assert.equal(emitted.length, 1, 'no emit from the failed scan');

  // A later successful scan resumes without throwing.
  await assert.doesNotReject(() => monitor.scan());
});

test("untrack of a session's last root publishes an empty list and clears its snapshot", async () => {
  const h = harness(rows);
  h.monitor.track('s1', 600, () => true);
  await h.monitor.scan();
  assert.equal(h.emitted.length, 1);
  assert.equal(h.monitor.hasProcesses('s1'), true);

  h.monitor.untrack(600, 's1');

  assert.equal(h.monitor.hasProcesses('s1'), false);
  assert.deepEqual(h.monitor.processesFor('s1'), []);
  assert.deepEqual(h.emitted.at(-1), ['s1', []]);
});

test('stop reports a failed identity check during grace without sending SIGKILL', async () => {
  let calls = 0;
  const killed: Array<[number, string]> = [];
  let timers: Array<() => void> = [];
  const monitor = new AgentProcessMonitor({
    listProcesses: async () => {
      calls += 1;
      if (calls <= 2) return rows; // Initial scan and identity check before SIGTERM.
      throw new Error('ps failed'); // the post-grace SIGKILL survivor check
    },
    listListeningPorts: async () => new Map(),
    kill: (pid, signal) => killed.push([pid, signal]),
    emit: () => {},
    // The kill grace poll always fires immediately here; `kill` above drops
    // the pid from the table so the poll sees it gone.
    scheduleKillPoll: (cb) => {
      setImmediate(cb);
      return { cancel() {} };
    },
    schedule: (cb, ms) => {
      if (ms !== TICK_MS) {
        setImmediate(cb);
        return { cancel() {} };
      }
      timers.push(cb);
      return {
        cancel() {
          timers = timers.filter((t) => t !== cb);
        },
      };
    },
    now: () => 100_000,
  });
  monitor.track('s1', 600, () => true);
  await monitor.scan();

  await assert.rejects(monitor.stop('s1', 800), /ps failed/);
  assert.deepEqual(killed, [[800, 'SIGTERM']]);
});

test("an emit that throws for one session doesn't block another session's publish, and is retried", async () => {
  const sessionARows: ProcessRecord[] = [
    { pid: 600, ppid: 1, startedAt: 0, command: '/usr/local/bin/droid exec' },
    { pid: 700, ppid: 600, startedAt: 0, command: 'node app-a.js' },
  ];
  const sessionBRows: ProcessRecord[] = [
    { pid: 610, ppid: 1, startedAt: 0, command: '/usr/local/bin/droid exec' },
    { pid: 710, ppid: 610, startedAt: 0, command: 'node app-b.js' },
  ];
  const emitted: Array<[string, unknown]> = [];
  let failEmitFor: string | null = 's1';
  const monitor = new AgentProcessMonitor({
    listProcesses: async () => [...sessionARows, ...sessionBRows],
    listListeningPorts: async () => new Map(),
    kill: () => {},
    emit: (id, processes) => {
      if (id === failEmitFor) throw new Error('emit failed');
      emitted.push([id, processes]);
    },
    schedule: () => ({ cancel() {} }),
    scheduleKillPoll: (cb) => {
      setImmediate(cb);
      return { cancel() {} };
    },
    now: () => 100_000,
  });
  monitor.track('s1', 600, () => true);
  monitor.track('s2', 610, () => true);

  await monitor.scan();

  // Delivery failed, but retirement must still see the authoritative processes.
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0][0], 's2');
  assert.equal(monitor.processesFor('s1').length, 1);

  // s2's emit succeeded in the same tick, despite s1's throwing first.
  assert.equal(monitor.processesFor('s2').length, 1);

  failEmitFor = null;
  await monitor.scan();

  assert.equal(emitted.length, 2);
  assert.equal(emitted[1][0], 's1');
  assert.equal(monitor.processesFor('s1').length, 1);
});

test('untrack during the in-flight ports scan drops the stale snapshot instead of re-emitting it', async () => {
  let currentRows: ProcessRecord[] = rows;
  let portsCallCount = 0;
  let resolvePorts: (map: Map<number, number[]>) => void = () => {};
  const emitted: Array<[string, unknown]> = [];
  const monitor = new AgentProcessMonitor({
    listProcesses: async () => currentRows,
    listListeningPorts: () => {
      portsCallCount += 1;
      if (portsCallCount === 1) return Promise.resolve(new Map([[800, [5173]]]));
      return new Promise<Map<number, number[]>>((resolve) => {
        resolvePorts = resolve;
      });
    },
    kill: () => {},
    emit: (id, processes) => emitted.push([id, processes]),
    schedule: () => ({ cancel() {} }),
    scheduleKillPoll: (cb) => {
      setImmediate(cb);
      return { cancel() {} };
    },
    now: () => 100_000,
  });
  monitor.track('s1', 600, () => true);

  // Tick 1 resolves ports immediately and establishes a non-empty snapshot.
  await monitor.scan();
  assert.equal(monitor.hasProcesses('s1'), true);

  // Tick 2: a new descendant forces a port refresh, which we hold open.
  currentRows = [...rows, { pid: 900, ppid: 800, startedAt: 100_000, command: 'node child.js' }];
  const scanPromise = monitor.scan();
  await new Promise((r) => setImmediate(r));

  // The session's only root goes away while the ports fetch is still
  // pending — untrack() clears its state and emits the empty list now.
  monitor.untrack(600, 's1');
  assert.deepEqual(emitted.at(-1), ['s1', []]);

  resolvePorts(new Map([[800, [5173]]]));
  await scanPromise;

  // The scan must not resurrect the stale snapshot it computed before the
  // untrack, nor re-emit it.
  assert.equal(monitor.hasProcesses('s1'), false);
  assert.deepEqual(monitor.processesFor('s1'), []);
  assert.deepEqual(emitted.at(-1), ['s1', []]);
});

test('killRecorded resolves without killing anything when listProcesses rejects', async () => {
  const killed: Array<[number, string]> = [];
  const monitor = new AgentProcessMonitor({
    listProcesses: async () => {
      throw new Error('ps failed');
    },
    listListeningPorts: async () => new Map(),
    kill: (pid, signal) => killed.push([pid, signal]),
    emit: () => {},
    schedule: () => ({ cancel() {} }),
    scheduleKillPoll: (cb) => {
      setImmediate(cb);
      return { cancel() {} };
    },
    now: () => 100_000,
  });

  await assert.doesNotReject(() => monitor.killRecorded([{ pid: 800, startedAt: 0 }]));
  assert.deepEqual(killed, []);
});

test('a root added during port discovery survives the stale scan', async () => {
  let releasePorts: (ports: Map<number, number[]>) => void = () => {};
  let portsStarted: () => void = () => {};
  const pendingPorts = new Promise<Map<number, number[]>>((resolve) => {
    releasePorts = resolve;
  });
  const started = new Promise<void>((resolve) => {
    portsStarted = resolve;
  });
  const h = harness(rows, new Map(), {
    listListeningPorts: () => {
      portsStarted();
      return pendingPorts;
    },
  });
  h.monitor.track('s1', 600, () => true);
  const scan = h.monitor.scan();
  await started;
  h.monitor.track('s2', 610, () => true);
  releasePorts(new Map());
  await scan;
  assert.deepEqual(h.emitted, []);

  h.setRows([
    ...rows,
    { pid: 610, ppid: 1, startedAt: 0, command: 'droid' },
    { pid: 810, ppid: 610, startedAt: 0, command: 'node server.js' },
  ]);
  await h.monitor.scan();
  assert.deepEqual(
    h.monitor.processesFor('s2').map((entry) => entry.pid),
    [810],
  );
  h.monitor.dispose();
});

test('a replaced root cannot inherit an in-flight process table', async () => {
  let releaseTable: (table: ProcessRecord[]) => void = () => {};
  let table = new Promise<ProcessRecord[]>((resolve) => {
    releaseTable = resolve;
  });
  const h = harness(rows, new Map(), { listProcesses: () => table });
  h.monitor.track('s1', 600, () => true);
  const scan = h.monitor.scan();
  h.monitor.untrack(600, 's1');
  h.monitor.track('s2', 600, () => true);
  releaseTable(rows);
  await scan;
  assert.deepEqual(h.monitor.processesFor('s2'), []);
  assert.deepEqual(h.emitted, [['s1', []]]);

  table = Promise.resolve([
    { pid: 600, ppid: 1, startedAt: 50_000, command: 'droid' },
    { pid: 810, ppid: 600, startedAt: 50_000, command: 'node server.js' },
  ]);
  await h.monitor.scan();
  assert.deepEqual(
    h.monitor.processesFor('s2').map((entry) => entry.pid),
    [810],
  );
  h.monitor.dispose();
});

test('hasProcesses ignores descendants the user can never see', async () => {
  const hidden: ProcessRecord[] = [
    { pid: 600, ppid: 1, startedAt: 0, command: '/usr/local/bin/droid exec' },
    { pid: 700, ppid: 600, startedAt: 0, command: '/bin/zsh -c npm run dev' },
    { pid: 900, ppid: 600, startedAt: 99_500, command: 'node infant.js' },
  ];
  const h = harness(hidden);
  h.monitor.track('s1', 600, () => true);
  await h.monitor.scan();

  // A shell wrapper and a process too young to publish: nothing the user
  // could stop, so nothing that may hold the session open.
  assert.deepEqual(h.monitor.processesFor('s1'), []);
  assert.equal(h.monitor.hasProcesses('s1'), false);
});

test('snapshotPids journals the tracked roots as well as their descendants', async () => {
  const h = harness(rows);
  h.monitor.track('s1', 600, () => true);
  await h.monitor.scan();

  assert.deepEqual(h.monitor.snapshotPids(), [
    { appSessionId: 's1', pid: 600, startedAt: 0 },
    { appSessionId: 's1', pid: 700, startedAt: 0 },
    { appSessionId: 's1', pid: 800, startedAt: 0 },
  ]);
});

test('adopted roots survive the root that spawned them and still belong to the session', async () => {
  const h = harness(rows);
  h.monitor.track('s1', 600, () => true);
  await h.monitor.scan();

  // What compaction does: re-root the old provider's children, then drop it.
  await h.monitor.adoptDescendantsAsRoots('s1', 600);
  h.monitor.untrack(600, 's1');
  h.setRows(
    rows
      .filter((row) => row.pid !== 600)
      .map((row) => (row.ppid === 600 ? { ...row, ppid: 1 } : row)),
  );
  await h.monitor.scan();

  assert.deepEqual(
    h.monitor.processesFor('s1').map((entry) => entry.pid),
    [800],
  );
  assert.equal(h.monitor.hasProcesses('s1'), true);

  await h.monitor.killSession('s1');
  assert.deepEqual(
    h.killed.map(([pid]) => pid),
    [800, 700],
  );
});

test('killTree SIGKILLs only what is still alive when the grace expires', async () => {
  const killed: Array<[number, string]> = [];
  const monitor = new AgentProcessMonitor({
    listProcesses: async () => rows, // nothing ever dies
    listListeningPorts: async () => new Map(),
    kill: (pid, signal) => killed.push([pid, signal]),
    emit: () => {},
    // The kill grace poll always fires immediately here; `kill` above drops
    // the pid from the table so the poll sees it gone.
    scheduleKillPoll: (cb) => {
      setImmediate(cb);
      return { cancel() {} };
    },
    schedule: (cb, ms) => {
      if (ms !== TICK_MS) setImmediate(cb);
      return { cancel() {} };
    },
    now: () => 100_000,
  });
  monitor.track('s1', 600, () => true);
  await monitor.scan();

  await monitor.killSession('s1');

  assert.deepEqual(killed, [
    [800, 'SIGTERM'],
    [700, 'SIGTERM'],
    [800, 'SIGKILL'],
    [700, 'SIGKILL'],
  ]);
});

// The adopt window: the retiring provider is still tracked while its children
// already are, so every descendant is reachable from two roots.
const compactionRows: ProcessRecord[] = [
  { pid: 600, ppid: 1, startedAt: 0, command: '/usr/local/bin/droid exec' },
  { pid: 800, ppid: 600, startedAt: 0, command: 'node /w/node_modules/.bin/vite' },
  { pid: 900, ppid: 600, startedAt: 0, command: 'node /w/node_modules/.bin/tsc --watch' },
];

test('a pid reachable from two roots is published once', async () => {
  const h = harness(compactionRows);
  h.monitor.track('s1', 600, () => true);
  await h.monitor.adoptDescendantsAsRoots('s1', 600);
  await h.monitor.scan();

  assert.deepEqual(
    h.monitor.processesFor('s1').map((entry) => entry.pid),
    [800, 900],
  );
});

test("pruning a session's last adopted root publishes an empty list", async () => {
  const emitted: Array<[string, unknown]> = [];
  let currentRows = compactionRows;
  const monitor = new AgentProcessMonitor({
    listProcesses: async () => currentRows,
    listListeningPorts: async () => new Map(),
    kill: () => {},
    emit: (id, processes) => {
      // Verify that the state is committed before the emit fires.
      if (id === 's1' && Array.isArray(processes) && processes.length === 0) {
        assert.equal(monitor.hasProcesses(id), false);
      }
      emitted.push([id, processes]);
    },
    schedule: () => ({ cancel() {} }),
    scheduleKillPoll: (cb) => {
      setImmediate(cb);
      return { cancel() {} };
    },
    now: () => 100_000,
  });

  monitor.track('s1', 600, () => true);
  await monitor.adoptDescendantsAsRoots('s1', 600);
  monitor.untrack(600, 's1');
  await monitor.scan();
  assert.equal(monitor.hasProcesses('s1'), true);

  // Both adopted roots exit; nothing is left to attribute to the session.
  currentRows = [];
  await monitor.scan();

  assert.equal(monitor.hasProcesses('s1'), false);
  assert.deepEqual(monitor.processesFor('s1'), []);
  assert.deepEqual(emitted.at(-1), ['s1', []]);
});

test('an adopted root whose pid is recycled is dropped, not re-attached', async () => {
  const h = harness(compactionRows);
  h.monitor.track('s1', 600, () => true);
  await h.monitor.adoptDescendantsAsRoots('s1', 600);
  h.monitor.untrack(600, 's1');
  await h.monitor.scan();
  assert.deepEqual(
    h.monitor.processesFor('s1').map((entry) => entry.pid),
    [800, 900],
  );

  // pid 800 exited and the OS handed the number to a stranger.
  h.setRows([
    { pid: 800, ppid: 1, startedAt: 50_000, command: '/usr/bin/someone-elses-daemon' },
    { pid: 900, ppid: 1, startedAt: 0, command: 'node /w/node_modules/.bin/tsc --watch' },
  ]);
  await h.monitor.scan();

  assert.deepEqual(
    h.monitor.processesFor('s1').map((entry) => entry.pid),
    [900],
  );
});

test('the SIGKILL sweep skips a pid that was recycled during the grace window', async () => {
  const killed: Array<[number, string]> = [];
  let table: ProcessRecord[] = [...rows];
  const monitor = new AgentProcessMonitor({
    listProcesses: async () => table,
    listListeningPorts: async () => new Map(),
    kill: (pid, signal) => killed.push([pid, signal]),
    emit: () => {},
    scheduleKillPoll: (cb) => {
      // The grace window: 800 died and its pid now belongs to someone else.
      table = [
        rows[0],
        rows[1],
        { pid: 800, ppid: 1, startedAt: 90_000, command: '/usr/bin/someone-elses-daemon' },
      ];
      setImmediate(cb);
      return { cancel() {} };
    },
    schedule: (cb, ms) => {
      if (ms !== TICK_MS) setImmediate(cb);
      return { cancel() {} };
    },
    now: () => 100_000,
  });
  monitor.track('s1', 600, () => true);
  await monitor.scan();

  await monitor.killSession('s1');

  assert.deepEqual(killed, [
    [800, 'SIGTERM'],
    [700, 'SIGTERM'],
    [700, 'SIGKILL'],
  ]);
});

test('adoptDescendantsAsRoots reports failure when the process table is unreadable', async () => {
  const monitor = new AgentProcessMonitor({
    listProcesses: () => Promise.reject(new Error('ps: cannot fork')),
    listListeningPorts: async () => new Map(),
    kill: () => {},
    emit: () => {},
    schedule: () => ({ cancel() {} }),
    scheduleKillPoll: () => ({ cancel() {} }),
    now: () => 100_000,
  });
  monitor.track('s1', 600, () => true);
  assert.equal(await monitor.adoptDescendantsAsRoots('s1', 600), false);
});

// `droid` spawns the stdio MCP servers from `.factory/mcp.json` as its own
// children, so the walk finds them under the session's root.
const mcpRows: ProcessRecord[] = [
  { pid: 600, ppid: 1, startedAt: 0, command: '/usr/local/bin/droid exec' },
  { pid: 700, ppid: 600, startedAt: 0, command: 'npx -y some-mcp --stdio' },
  { pid: 710, ppid: 700, startedAt: 0, command: 'node /w/some-mcp/dist/server.js' },
  { pid: 800, ppid: 600, startedAt: 0, command: 'node /w/node_modules/.bin/vite' },
  { pid: 810, ppid: 600, startedAt: 0, command: 'npx -y some-mcp-two' },
];

test('an ignored command hides its whole subtree and nothing else', async () => {
  const h = harness(mcpRows);
  h.monitor.setIgnoredCommands('s1', ['npx -y some-mcp']);
  h.monitor.track('s1', 600, () => true);
  await h.monitor.scan();

  assert.deepEqual(
    h.monitor.processesFor('s1').map((entry) => entry.pid),
    [800, 810],
  );
  assert.equal(h.monitor.hasProcesses('s1'), true);
});

test('a session whose only descendants are ignored has no processes', async () => {
  const h = harness(mcpRows.filter((row) => row.pid !== 800 && row.pid !== 810));
  h.monitor.setIgnoredCommands('s1', ['npx -y some-mcp']);
  h.monitor.track('s1', 600, () => true);
  await h.monitor.scan();

  assert.deepEqual(h.monitor.processesFor('s1'), []);
  assert.equal(h.monitor.hasProcesses('s1'), false);
});

test('a recycled provider root cannot attach or kill a stranger’s descendants', async () => {
  const h = harness(rows);
  h.monitor.track('s1', 600, () => true);
  await h.monitor.scan();
  h.setRows([
    { pid: 600, ppid: 1, startedAt: 50_000, command: 'unrelated-service' },
    { pid: 801, ppid: 600, startedAt: 50_000, command: 'unrelated-worker' },
  ]);
  await h.monitor.scan();
  assert.deepEqual(h.monitor.processesFor('s1'), []);
  await h.monitor.killSession('s1');
  assert.deepEqual(h.killed, []);
});

test('stop validates identity before SIGTERM when a snapshot PID was reused', async () => {
  const h = harness(rows);
  h.monitor.track('s1', 600, () => true);
  await h.monitor.scan();
  h.setRows([rows[0], { pid: 800, ppid: 1, startedAt: 50_000, command: 'unrelated-service' }]);
  await h.monitor.stop('s1', 800);
  assert.deepEqual(h.killed, []);
});

test('an adoption pending across session close cannot restore its roots', async () => {
  let resolveAdoption: (table: ProcessRecord[]) => void = () => {};
  let holdAdoption = false;
  const h = harness(rows, new Map(), {
    listProcesses: () => {
      if (!holdAdoption) return Promise.resolve(rows);
      holdAdoption = false;
      return new Promise((resolve) => {
        resolveAdoption = resolve;
      });
    },
  });
  h.monitor.track('s1', 600, () => true);
  await h.monitor.scan();
  holdAdoption = true;
  const adopting = h.monitor.adoptDescendantsAsRoots('s1', 600);
  await h.monitor.killSession('s1');
  resolveAdoption(rows);
  assert.equal(await adopting, false);
  await h.monitor.scan();
  assert.deepEqual(h.monitor.snapshotPids(), []);
  assert.deepEqual(h.monitor.processesFor('s1'), []);
});

test('journal changes include hidden roots and descendants and retry without UI changes', async () => {
  let writes = 0;
  let fail = false;
  const h = harness([rows[0]], new Map(), {
    onSnapshotChanged: () => {
      writes++;
      if (fail) throw new Error('journal unavailable');
    },
  });
  h.monitor.track('s1', 600, () => true);
  await h.monitor.scan();
  assert.equal(writes, 1);
  assert.equal(h.emitted.length, 1);
  fail = true;
  h.setRows([rows[0], rows[1]]);
  await h.monitor.scan();
  assert.equal(writes, 2);
  assert.equal(h.emitted.length, 1);
  fail = false;
  await h.monitor.scan();
  assert.equal(writes, 3);
  assert.deepEqual(
    h.monitor.snapshotPids().map((entry) => entry.pid),
    [600, 700],
  );
  await h.monitor.scan();
  assert.equal(writes, 3);
});

test('the last root’s failed empty publication retries without restoring stale work', async () => {
  let fail = false;
  const delivered: number[] = [];
  const h = harness(rows, new Map(), {
    emit: (_id, processes) => {
      if (fail) throw new Error('bridge unavailable');
      delivered.push(processes.length);
    },
  });
  h.monitor.track('s1', 600, () => true);
  await h.monitor.scan();
  fail = true;
  h.monitor.untrack(600, 's1');
  assert.equal(h.monitor.hasProcesses('s1'), false);
  fail = false;
  await h.tick();
  assert.deepEqual(delivered, [1, 0]);
});

test('closing a session with no tracked processes skips host discovery', async () => {
  const h = harness([], new Map(), {
    listProcesses: async () => assert.fail('there are no provider processes to discover'),
    listListeningPorts: async () => assert.fail('there are no processes to attach ports to'),
  });
  await h.monitor.killSession('empty');
  assert.deepEqual(h.killed, []);
  assert.deepEqual(h.emitted, [['empty', []]]);
});
