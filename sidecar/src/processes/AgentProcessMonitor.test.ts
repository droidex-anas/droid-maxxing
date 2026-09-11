import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentProcessMonitor, displayNameFor } from './AgentProcessMonitor.js';
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
      if (ms === 3000) {
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
      if (ms === 3000) {
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
