const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createSidecarSupervisor } = require('./sidecar.cjs');

function fakeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  child.kill = () => {
    child.killed = true;
  };
  return child;
}

function harness(children, extras = {}) {
  const calls = [];
  const scheduled = [];
  let nowMs = 0;
  const supervisor = createSidecarSupervisor({
    entryPath: () => '/app/sidecar.mjs',
    cwd: () => '/app',
    userData: () => '/profiles/droidex',
    stdout: new PassThrough(),
    stderr: extras.stderr || new PassThrough(),
    now: () => nowMs,
    random: () => 0,
    requestHealth: extras.requestHealth || (async () => ({ ok: true })),
    schedule: (callback, delayMs) => {
      const item = { callback, delayMs, cancelled: false };
      scheduled.push(item);
      return () => {
        item.cancelled = true;
      };
    },
    spawnProcess: (command, args, options) => {
      calls.push({ command, args, options });
      const child = children.shift();
      assert.ok(child);
      return child;
    },
    ...('onUnexpectedExit' in extras ? { onUnexpectedExit: extras.onUnexpectedExit } : {}),
    ...('maxRestarts' in extras ? { maxRestarts: extras.maxRestarts } : {}),
    ...('restartWindowMs' in extras ? { restartWindowMs: extras.restartWindowMs } : {}),
    ...('restartBackoffMs' in extras ? { restartBackoffMs: extras.restartBackoffMs } : {}),
    ...('maxRestartBackoffMs' in extras ? { maxRestartBackoffMs: extras.maxRestartBackoffMs } : {}),
  });
  return {
    supervisor,
    calls,
    scheduled,
    advance(ms) {
      nowMs += ms;
      const due = scheduled.filter((item) => !item.cancelled && item.delayMs <= nowMs);
      for (const item of due) {
        item.cancelled = true;
        item.callback();
      }
    },
    flushScheduled() {
      const pending = scheduled.filter((item) => !item.cancelled);
      for (const item of pending) {
        item.cancelled = true;
        item.callback();
      }
    },
  };
}

test('sidecar binds an OS-assigned port and shares one concurrent startup', async () => {
  const child = fakeChild();
  const { supervisor, calls } = harness([child]);
  const first = supervisor.start();
  const second = supervisor.start();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, process.execPath);
  assert.deepEqual(calls[0].args, ['/app/sidecar.mjs']);
  assert.equal(calls[0].options.env.BRIDGE_PORT, '0');
  assert.equal(calls[0].options.env.ELECTRON_RUN_AS_NODE, '1');
  assert.match(calls[0].options.env.BRIDGE_TOKEN, /^[a-f0-9]{64}$/);
  assert.match(calls[0].options.env.BROWSER_ASSET_TOKEN, /^[a-f0-9]{64}$/);
  assert.notEqual(calls[0].options.env.BROWSER_ASSET_TOKEN, calls[0].options.env.BRIDGE_TOKEN);
  assert.equal(calls[0].options.env.DROIDEX_USER_DATA_DIR, '/profiles/droidex');

  child.stdout.write('SIDECAR_READY 43123\n');
  assert.deepEqual(await first, await second);
  assert.equal((await first).port, 43123);
  assert.equal(supervisor.snapshot().lifecycle, 'healthy');
});

test('sidecar startup reports stderr when the child exits before ready', async () => {
  const child = fakeChild();
  const { supervisor } = harness([child, fakeChild()]);
  const pending = supervisor.start();
  child.stderr.write('listen EADDRINUSE\n');
  child.emit('exit', 1, null);
  await assert.rejects(pending, /Sidecar exited before ready/);
});

test('getBridgeInfo never spawns after an intentional stop', async () => {
  const firstChild = fakeChild();
  const { supervisor, calls } = harness([firstChild]);
  const first = supervisor.start();
  firstChild.stdout.write('SIDECAR_READY 43001\n');
  await first;

  supervisor.stop();
  assert.equal(firstChild.killed, true);
  await assert.rejects(supervisor.getBridgeInfo(), /stopped/);
  assert.equal(calls.length, 1);
});

test('stop during startup invalidates the old child before an immediate restart', async () => {
  const firstChild = fakeChild();
  const secondChild = fakeChild();
  const { supervisor, calls } = harness([firstChild, secondChild]);
  const first = supervisor.start();

  supervisor.stop();
  const second = supervisor.start();

  firstChild.stdout.write('SIDECAR_READY 43001\n');
  firstChild.emit('exit', null, 'SIGTERM');
  secondChild.stdout.write('SIDECAR_READY 43002\n');

  await assert.rejects(first, /cancelled/);
  assert.equal((await second).port, 43002);
  assert.equal((await supervisor.getBridgeInfo()).port, 43002);
  assert.equal(calls.length, 2);
});

test('intentional shutdown is not reported as a crash', async () => {
  const child = fakeChild();
  const stderr = new PassThrough();
  let diagnostics = '';
  stderr.on('data', (chunk) => {
    diagnostics += String(chunk);
  });
  const supervisor = createSidecarSupervisor({
    entryPath: () => '/app/sidecar.mjs',
    cwd: () => '/app',
    userData: () => '/profiles/droidex',
    stdout: new PassThrough(),
    stderr,
    requestHealth: async () => ({ ok: true }),
    spawnProcess: () => child,
  });
  const started = supervisor.start();
  child.stdout.write('SIDECAR_READY 43001\n');
  await started;

  const stopped = supervisor.stop();
  child.emit('exit', null, 'SIGTERM');
  await stopped;

  assert.equal(diagnostics, '');
  assert.equal(supervisor.snapshot().lifecycle, 'stopped');
});

test('stop resolves only after the sidecar process exits', async () => {
  const child = fakeChild();
  const { supervisor } = harness([child]);
  const started = supervisor.start();
  child.stdout.write('SIDECAR_READY 43001\n');
  await started;

  let stopped = false;
  const stop = supervisor.stop().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  assert.equal(stopped, false);

  child.emit('exit', 0, null);
  await stop;
  assert.equal(stopped, true);
});

test('unexpected sidecar exits are forwarded to diagnostics', async () => {
  const child = fakeChild();
  const crashes = [];
  const { supervisor } = harness([child, fakeChild()], {
    onUnexpectedExit: (error) => crashes.push(error.message),
  });
  const started = supervisor.start();
  child.stdout.write('SIDECAR_READY 43001\n');
  await started;

  child.emit('exit', 1, null);

  assert.deepEqual(crashes, ['Sidecar exited unexpectedly (1).']);
  assert.equal(supervisor.snapshot().lifecycle, 'restarting');
});

test('a missed heartbeat degrades without declaring the process dead', async () => {
  const child = fakeChild();
  let shouldFail = false;
  const { supervisor, flushScheduled } = harness([child], {
    requestHealth: async () => {
      if (shouldFail) throw new Error('busy');
      return { ok: true };
    },
  });
  child.stdout.write('SIDECAR_READY 43001\n');
  await supervisor.start();
  assert.equal(supervisor.snapshot().lifecycle, 'healthy');

  shouldFail = true;
  flushScheduled();
  await Promise.resolve();
  await Promise.resolve();

  const health = supervisor.snapshot();
  assert.equal(health.lifecycle, 'degraded');
  assert.equal(health.processAlive, true);
  assert.equal(health.bridgeResponsive, false);
});

test('bridge-info waits for the supervisor restart and does not spawn a second sidecar', async () => {
  const firstChild = fakeChild();
  const secondChild = fakeChild();
  const { supervisor, calls, flushScheduled } = harness([firstChild, secondChild]);
  firstChild.stdout.write('SIDECAR_READY 43001\n');
  await supervisor.start();
  assert.equal(calls.length, 1);

  firstChild.emit('exit', 1, null);
  const waiting = supervisor.getBridgeInfo();
  assert.equal(calls.length, 1);

  flushScheduled();
  secondChild.stdout.write('SIDECAR_READY 43002\n');
  assert.equal((await waiting).port, 43002);
  assert.equal(calls.length, 2);
  assert.equal(supervisor.snapshot().lifecycle, 'healthy');
});

test('restart storms stay bounded and land in recovery-required', async () => {
  const kids = Array.from({ length: 8 }, () => fakeChild());
  const { supervisor, calls, flushScheduled } = harness([...kids], { maxRestarts: 5 });
  kids[0].stdout.write('SIDECAR_READY 43001\n');
  await supervisor.start();

  for (let index = 0; index < 5; index += 1) {
    kids[index].emit('exit', 1, null);
    const waiting = supervisor.getBridgeInfo();
    flushScheduled();
    kids[index + 1].stdout.write(`SIDECAR_READY ${43002 + index}\n`);
    await waiting;
  }
  kids[5].emit('exit', 1, null);

  assert.equal(supervisor.snapshot().lifecycle, 'recovery-required');
  assert.equal(calls.length, 6);
  await assert.rejects(supervisor.getBridgeInfo(), /recovery is required/);
  await assert.rejects(supervisor.start(), /recovery is required/);
});

test('intentional shutdown never restarts', async () => {
  const child = fakeChild();
  const { supervisor, calls, scheduled } = harness([child, fakeChild()]);
  child.stdout.write('SIDECAR_READY 43001\n');
  await supervisor.start();
  const stopping = supervisor.stop();
  child.emit('exit', 1, null);
  await stopping;
  assert.equal(supervisor.snapshot().lifecycle, 'stopped');
  assert.equal(scheduled.filter((item) => !item.cancelled).length, 0);
  assert.equal(calls.length, 1);
});
