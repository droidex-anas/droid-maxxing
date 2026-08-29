import { accessSync, constants, existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';

import { ShutdownDeadline } from '../shutdownDeadline.js';

export const ACP_STDERR_TAIL_BYTES = 16 * 1024;

export interface AcpProcessSpawnRequest {
  command: string;
  args: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface SpawnedAcpProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly stderrTail: BoundedByteTail;
}

export class AcpProcessSpawnFailure extends Error {
  readonly reason: 'missing_executable' | 'spawn_failed';

  constructor(reason: 'missing_executable' | 'spawn_failed', message: string) {
    super(message);
    this.name = 'AcpProcessSpawnFailure';
    this.reason = reason;
  }
}

export class BoundedByteTail {
  #chunks: Buffer[] = [];
  #size = 0;

  constructor(readonly maxBytes: number) {}

  get size(): number {
    return this.#size;
  }

  push(chunk: Buffer): void {
    if (chunk.length === 0 || this.maxBytes <= 0) {
      return;
    }
    this.#chunks.push(chunk);
    this.#size += chunk.length;
    while (this.#size > this.maxBytes && this.#chunks.length > 0) {
      const extra = this.#size - this.maxBytes;
      const [first, ...rest] = this.#chunks;
      if (!first) {
        this.#chunks = [];
        this.#size = 0;
        return;
      }
      if (first.length <= extra) {
        this.#chunks = rest;
        this.#size -= first.length;
      } else {
        this.#chunks = [first.subarray(extra), ...rest];
        this.#size -= extra;
      }
    }
  }

  snapshot(): Buffer {
    const [first, ...rest] = this.#chunks;
    if (!first) {
      return Buffer.alloc(0);
    }
    if (rest.length === 0) {
      return first;
    }
    return Buffer.concat(this.#chunks, this.#size);
  }
}

export function wrapAcpInvocation(
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): { execPath: string; execArgs: string[] } {
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
    const commandShell = process.env.ComSpec;
    return {
      execPath: commandShell?.trim() ? commandShell : 'cmd.exe',
      execArgs: ['/c', command, ...args],
    };
  }
  return { execPath: command, execArgs: [...args] };
}

export function resolveAcpExecutable(command: string): string | undefined {
  if (command.includes('/') || command.includes('\\')) {
    return isExecutable(command) ? command : undefined;
  }
  return resolveOnPath(command);
}

export function spawnAcpProcess(request: AcpProcessSpawnRequest): SpawnedAcpProcess {
  const resolved = resolveAcpExecutable(request.command);
  if (resolved === undefined) {
    throw new AcpProcessSpawnFailure('missing_executable', 'ACP peer executable was not found');
  }

  const invocation = wrapAcpInvocation(resolved, request.args);
  const child = spawn(invocation.execPath, invocation.execArgs, {
    cwd: request.cwd,
    env: request.env ?? process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
    detached: process.platform !== 'win32',
  });

  const stderrTail = new BoundedByteTail(ACP_STDERR_TAIL_BYTES);
  child.stderr.on('data', (chunk: Buffer) => {
    stderrTail.push(chunk);
  });
  child.stderr.on('error', () => undefined);

  return { child, stderrTail };
}

export function waitForSpawn(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    if (hasExited(child)) {
      reject(new AcpProcessSpawnFailure('spawn_failed', 'ACP peer process failed to start'));
      return;
    }
    const onError = (error: NodeJS.ErrnoException) => {
      child.off('spawn', onSpawn);
      reject(mapSpawnErrno(error));
    };
    const onSpawn = () => {
      child.off('error', onError);
      resolve();
    };
    child.once('error', onError);
    child.once('spawn', onSpawn);
  });
}

export function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

export function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (hasExited(child)) {
    return;
  }
  const pid = child.pid;
  if (pid === undefined) {
    return;
  }
  try {
    if (process.platform === 'win32') {
      child.kill(signal);
      return;
    }
    process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      return;
    }
  }
}

export async function terminateProcessTree(
  child: ChildProcess,
  deadline: ShutdownDeadline,
): Promise<void> {
  if (hasExited(child)) {
    return;
  }

  if (deadline.isExpired()) {
    signalProcessTree(child, 'SIGKILL');
    await waitForProcessExit(child, deadline);
    return;
  }

  signalProcessTree(child, 'SIGTERM');
  const termResult = await waitForProcessExit(child, deadline);
  if (termResult === 'exited' || hasExited(child)) {
    return;
  }
  signalProcessTree(child, 'SIGKILL');
  await waitForProcessExit(child, deadline);
}

export function waitForProcessExit(
  child: ChildProcess,
  deadline: ShutdownDeadline,
): Promise<'exited' | 'deadline'> {
  if (hasExited(child)) {
    return Promise.resolve('exited');
  }
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: 'exited' | 'deadline') => {
      if (settled) {
        return;
      }
      settled = true;
      child.off('exit', onExit);
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      resolve(result);
    };
    const onExit = () => finish('exited');
    child.once('exit', onExit);
    const remainingMs = deadline.remainingMs();
    if (remainingMs <= 0) {
      finish('deadline');
      return;
    }
    timer = setTimeout(() => finish('deadline'), remainingMs);
  });
}

function mapSpawnErrno(error: NodeJS.ErrnoException): AcpProcessSpawnFailure {
  if (error.code === 'ENOENT') {
    return new AcpProcessSpawnFailure('missing_executable', 'ACP peer executable was not found');
  }
  return new AcpProcessSpawnFailure('spawn_failed', 'ACP peer process failed to start');
}

function isExecutable(path: string): boolean {
  if (!existsSync(path)) {
    return false;
  }
  if (process.platform === 'win32') {
    return true;
  }
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveOnPath(command: string): string | undefined {
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  if (process.platform === 'win32') {
    const extensions = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
      .split(';')
      .map((extension) => extension.trim())
      .filter(Boolean);
    for (const dir of dirs) {
      for (const extension of extensions) {
        const candidate = join(dir, command + extension);
        if (existsSync(candidate)) {
          return candidate;
        }
      }
    }
    return undefined;
  }
  for (const dir of dirs) {
    const candidate = join(dir, command);
    if (isExecutable(candidate)) {
      return candidate;
    }
  }
  return undefined;
}
