import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';

import { ShutdownDeadline } from '../shutdownDeadline.js';
import {
  ACP_STDERR_TAIL_BYTES,
  BoundedByteTail,
  hasExited,
  resolveAcpExecutable,
  spawnAcpProcess,
  terminateProcessTree,
  waitForProcessExit,
  waitForSpawn,
  wrapAcpInvocation,
} from './acpProcess.js';

test('wrapAcpInvocation routes a Windows .cmd shim through cmd.exe without a shell', () => {
  const prev = process.env.ComSpec;
  process.env.ComSpec = 'C\\\\Windows\\\\System32\\\\cmd.exe';
  try {
    assert.deepEqual(wrapAcpInvocation('C\\\\npm\\\\cursor-agent.cmd', ['acp'], 'win32'), {
      execPath: 'C\\\\Windows\\\\System32\\\\cmd.exe',
      execArgs: ['/c', 'C\\\\npm\\\\cursor-agent.cmd', 'acp'],
    });
  } finally {
    if (prev === undefined) delete process.env.ComSpec;
    else process.env.ComSpec = prev;
  }
});

test('wrapAcpInvocation spawns the binary directly on POSIX', () => {
  assert.deepEqual(wrapAcpInvocation('/usr/local/bin/grok', ['agent', 'stdio'], 'linux'), {
    execPath: '/usr/local/bin/grok',
    execArgs: ['agent', 'stdio'],
  });
});

test('resolveAcpExecutable rejects a missing path', () => {
  assert.equal(resolveAcpExecutable('/definitely/not/an/acp-peer-binary'), undefined);
  assert.equal(resolveAcpExecutable(process.execPath), process.execPath);
});

test('BoundedByteTail drops bytes beyond the retained window', () => {
  const tail = new BoundedByteTail(8);
  tail.push(Buffer.from('abcdefghijkl'));
  assert.equal(tail.size, 8);
  assert.equal(tail.snapshot().toString(), 'efghijkl');
  tail.push(Buffer.from('MNOP'));
  assert.equal(tail.size, 8);
  assert.equal(tail.snapshot().toString(), 'ijklMNOP');
});

test('ACP_STDERR_TAIL_BYTES is a finite named cap', () => {
  assert.equal(ACP_STDERR_TAIL_BYTES, 16 * 1024);
});

test('spawnAcpProcess throws missing_executable for a path that does not exist', () => {
  assert.throws(
    () =>
      spawnAcpProcess({
        command: '/definitely/not/an/acp-peer-binary',
        args: [],
      }),
    (error: unknown) =>
      error instanceof Error &&
      error.name === 'AcpProcessSpawnFailure' &&
      'reason' in error &&
      error.reason === 'missing_executable',
  );
});

test('spawnAcpProcess throws when the abort signal is already aborted', () => {
  assert.throws(
    () =>
      spawnAcpProcess({
        command: process.execPath,
        args: ['-e', 'process.exit(0)'],
        signal: AbortSignal.abort(),
      }),
    (error: unknown) =>
      error instanceof Error &&
      error.name === 'AcpProcessSpawnFailure' &&
      'reason' in error &&
      error.reason === 'spawn_failed',
  );
});

test('spawnAcpProcess abort signal SIGKILLs a long-running child', async () => {
  const controller = new AbortController();
  const spawned = spawnAcpProcess({
    command: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1 << 30)'],
    signal: controller.signal,
  });
  await waitForSpawn(spawned.child);
  controller.abort();
  const exited = await waitForProcessExit(spawned.child, ShutdownDeadline.fromDurationMs(2_000));
  assert.equal(exited, 'exited');
  assert.equal(hasExited(spawned.child), true);
});

test('terminateProcessTree with an expired deadline SIGKILLs and does not wait for a grace period', async () => {
  const child = spawn(
    process.execPath,
    ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1 << 30);'],
    { stdio: 'ignore', shell: false, detached: true },
  );
  await waitForSpawn(child);
  const exited = waitForProcessExit(child, ShutdownDeadline.fromDurationMs(5_000));
  const started = performance.now();
  await terminateProcessTree(child, ShutdownDeadline.fromDurationMs(0));
  assert.ok(performance.now() - started < 1_000);
  assert.equal(await exited, 'exited');
  assert.equal(hasExited(child), true);
});
