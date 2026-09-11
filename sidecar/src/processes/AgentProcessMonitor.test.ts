import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentProcessMonitor, TICK_MS, displayNameFor } from './AgentProcessMonitor.js';
import type { ProcessRecord } from './processTree.js';

function harness(rows: ProcessRecord[], ports = new Map<number, number[]>()) {
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

test('displayNameFor uses the leaf basename and a non-flag first argument', () => {
  assert.equal(displayNameFor('node /w/node_modules/.bin/vite'), 'vite');
  assert.equal(displayNameFor('/usr/bin/python3 -m http.server'), 'python3');
  assert.equal(displayNameFor('/w/node_modules/.bin/next dev'), 'next dev');
});

test('second-granular startedAt jitter does not re-emit an unchanged list', async () => {
  const h = harness(rows);
  h.monitor.track('s1', 600);
  await h.monitor.scan();
  assert.equal(h.emitted.length, 1);

  // Same processes, `ps etime` rounding read them 700ms later.
  h.setRows(rows.map((row) => ({ ...row, startedAt: row.startedAt + 700 })));
  await h.monitor.scan();
  assert.equal(h.emitted.length, 1);

  // Outside the rounding window: a different process on a recycled pid.
  h.setRows(rows.map((row) => ({ ...row, startedAt: row.startedAt + 9000 })));
  await h.monitor.scan();
  assert.equal(h.emitted.length, 2);
});

test('scan hides shell wrappers, emits once per change, and attaches ports', async () => {
  const h = harness(rows, new Map([[800, [5173]]]));
  h.monitor.track('s1', 600);
  await h.monitor.scan();
  assert.equal(h.emitted.length, 1);
  assert.deepEqual(h.emitted[0], [
    's1',
    [
      {
        pid: 800,
        name: 'vite',
        command: 'node /w/node_modules/.bin/vite',
        startedAt: 0,
        ports: [5173],
      },
    ],
  ]);
  await h.monitor.scan();
  assert.equal(h.emitted.length, 1);
});

test('processes younger than MIN_AGE_MS are not shown yet', async () => {
  const young = rows.map((r) => (r.pid === 800 ? { ...r, startedAt: 99_500 } : r));
  const h = harness(young);
  h.monitor.track('s1', 600);
  await h.monitor.scan();
  assert.equal(h.emitted.length, 0);
  h.advance(2000);
  await h.monitor.scan();
  assert.equal(h.emitted.length, 1);
});

test('stop validates the pid against the session snapshot and tree-kills it', async () => {
  const h = harness(rows);
  h.monitor.track('s1', 600);
  await h.monitor.scan();
  assert.equal(await h.monitor.stop('s1', 4242), false);
  assert.equal(await h.monitor.stop('s1', 800), true);
  assert.deepEqual(h.killed[0], [800, 'SIGTERM']);
});

test('killSession kills every descendant deepest first and emits an empty list', async () => {
  const h = harness(rows);
  h.monitor.track('s1', 600);
  await h.monitor.scan();
  await h.monitor.killSession('s1');
  assert.deepEqual(
    h.killed.map(([pid]) => pid),
    [800, 700],
  );
  assert.deepEqual(h.emitted.at(-1), ['s1', []]);
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
    now: () => 100_000,
  });
  monitor.track('s1', 600);

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
    now: () => 100_000,
  });
  monitor.track('s1', 600);

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

test('sameList treats a changed startedAt (pid reuse) as a change and re-emits', async () => {
  const h = harness(rows);
  h.monitor.track('s1', 600);
  await h.monitor.scan();
  assert.equal(h.emitted.length, 1);

  h.setRows(rows.map((r) => (r.pid === 800 ? { ...r, startedAt: 50_000 } : r)));
  await h.monitor.scan();

  assert.equal(h.emitted.length, 2);
  assert.equal((h.emitted[1][1] as { startedAt: number }[])[0].startedAt, 50_000);
});

test("untrack of a session's last root publishes an empty list and clears its snapshot", async () => {
  const h = harness(rows);
  h.monitor.track('s1', 600);
  await h.monitor.scan();
  assert.equal(h.emitted.length, 1);
  assert.equal(h.monitor.hasProcesses('s1'), true);

  h.monitor.untrack(600);

  assert.equal(h.monitor.hasProcesses('s1'), false);
  assert.deepEqual(h.monitor.processesFor('s1'), []);
  assert.deepEqual(h.emitted.at(-1), ['s1', []]);
});

test('stop resolves true and sends only SIGTERM when the post-grace listProcesses call fails', async () => {
  let calls = 0;
  const killed: Array<[number, string]> = [];
  let timers: Array<() => void> = [];
  const monitor = new AgentProcessMonitor({
    listProcesses: async () => {
      calls += 1;
      if (calls === 1) return rows; // the scan() inside stop() needs a snapshot to validate against
      throw new Error('ps failed'); // the post-grace SIGKILL survivor check
    },
    listListeningPorts: async () => new Map(),
    kill: (pid, signal) => killed.push([pid, signal]),
    emit: () => {},
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
  monitor.track('s1', 600);
  await monitor.scan();

  const result = await monitor.stop('s1', 800);

  assert.equal(result, true);
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
    now: () => 100_000,
  });
  monitor.track('s1', 600);
  monitor.track('s2', 610);

  await monitor.scan();

  // s1's emit threw: nothing recorded for it, and its `current` must be left
  // unchanged (still empty) so the next scan sees a diff and retries.
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0][0], 's2');
  assert.deepEqual(monitor.processesFor('s1'), []);

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
    now: () => 100_000,
  });
  monitor.track('s1', 600);

  // Tick 1 resolves ports immediately and establishes a non-empty snapshot.
  await monitor.scan();
  assert.equal(monitor.hasProcesses('s1'), true);

  // Tick 2: a new descendant forces a port refresh, which we hold open.
  currentRows = [...rows, { pid: 900, ppid: 800, startedAt: 100_000, command: 'node child.js' }];
  const scanPromise = monitor.scan();
  await new Promise((r) => setImmediate(r));

  // The session's only root goes away while the ports fetch is still
  // pending — untrack() clears its state and emits the empty list now.
  monitor.untrack(600);
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
    now: () => 100_000,
  });

  await assert.doesNotReject(() => monitor.killRecorded([{ pid: 800, startedAt: 0 }]));
  assert.deepEqual(killed, []);
});

test('hasProcesses ignores descendants the user can never see', async () => {
  const hidden: ProcessRecord[] = [
    { pid: 600, ppid: 1, startedAt: 0, command: '/usr/local/bin/droid exec' },
    { pid: 700, ppid: 600, startedAt: 0, command: '/bin/zsh -c npm run dev' },
    { pid: 900, ppid: 600, startedAt: 99_500, command: 'node infant.js' },
  ];
  const h = harness(hidden);
  h.monitor.track('s1', 600);
  await h.monitor.scan();

  // A shell wrapper and a process too young to publish: nothing the user
  // could stop, so nothing that may hold the session open.
  assert.deepEqual(h.monitor.processesFor('s1'), []);
  assert.equal(h.monitor.hasProcesses('s1'), false);
});

test('snapshotPids journals the tracked roots as well as their descendants', async () => {
  const h = harness(rows);
  h.monitor.track('s1', 600);
  await h.monitor.scan();

  assert.deepEqual(h.monitor.snapshotPids(), [
    { appSessionId: 's1', pid: 600, startedAt: 0 },
    { appSessionId: 's1', pid: 700, startedAt: 0 },
    { appSessionId: 's1', pid: 800, startedAt: 0 },
  ]);
});

test('adopted roots survive the root that spawned them and still belong to the session', async () => {
  const h = harness(rows);
  h.monitor.track('s1', 600);
  await h.monitor.scan();

  // What compaction does: re-root the old provider's children, then drop it.
  await h.monitor.adoptDescendantsAsRoots('s1', 600);
  h.monitor.untrack(600);
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
    schedule: (cb, ms) => {
      if (ms !== TICK_MS) setImmediate(cb);
      return { cancel() {} };
    },
    now: () => 100_000,
  });
  monitor.track('s1', 600);
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
  h.monitor.track('s1', 600);
  await h.monitor.adoptDescendantsAsRoots('s1', 600);
  await h.monitor.scan();

  assert.deepEqual(
    h.monitor.processesFor('s1').map((entry) => entry.pid),
    [800, 900],
  );
});

test("pruning a session's last adopted root publishes an empty list", async () => {
  const h = harness(compactionRows);
  h.monitor.track('s1', 600);
  await h.monitor.adoptDescendantsAsRoots('s1', 600);
  h.monitor.untrack(600);
  await h.monitor.scan();
  assert.equal(h.monitor.hasProcesses('s1'), true);

  // Both adopted roots exit; nothing is left to attribute to the session.
  h.setRows([]);
  await h.monitor.scan();

  assert.equal(h.monitor.hasProcesses('s1'), false);
  assert.deepEqual(h.monitor.processesFor('s1'), []);
  assert.deepEqual(h.emitted.at(-1), ['s1', []]);
});
