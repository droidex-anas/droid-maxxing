import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electronBin = createRequire(import.meta.url)('electron');
const WINDOW_WAIT_MS = 8_000;
const POLL_MS = 100;

function windowsForPid(pid, display) {
  try {
    return execFileSync('xdotool', ['search', '--pid', String(pid)], {
      encoding: 'utf8',
      env: { ...process.env, DISPLAY: display },
    })
      .trim()
      .split('\n')
      .filter(Boolean);
  } catch {
    return [];
  }
}

function stop(child) {
  if (child.exitCode !== null || child.signalCode) return;
  child.kill('SIGTERM');
}

async function main() {
  const display = process.env.DISPLAY;
  if (!display) {
    throw new Error('electron:boot-smoke requires DISPLAY (this VM uses DISPLAY=:1).');
  }
  try {
    execFileSync('xdotool', ['version'], { encoding: 'utf8' });
  } catch {
    throw new Error('electron:boot-smoke requires xdotool to observe the first window.');
  }

  const userData = mkdtempSync(path.join(tmpdir(), 'droidex-boot-smoke-'));
  const stderrChunks = [];
  const child = spawn(
    electronBin,
    [path.join(root, 'electron/main.cjs'), '--no-sandbox', `--user-data-dir=${userData}`],
    {
      cwd: root,
      env: {
        ...process.env,
        DISPLAY: display,
        DROIDEX_USER_DATA_DIR: userData,
        SENTRY_DSN: '',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  );
  child.stderr.on('data', (chunk) => stderrChunks.push(chunk));
  const spawnError = new Promise((_, reject) => {
    child.once('error', reject);
  });

  async function waitForExit() {
    if (child.exitCode !== null || child.signalCode) return;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    const killer = setTimeout(() => child.kill('SIGKILL'), 2_000);
    killer.unref?.();
    await exited;
    clearTimeout(killer);
  }

  const deadline = Date.now() + WINDOW_WAIT_MS;
  try {
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode) {
        throw new Error(
          `Electron exited before a window appeared (code ${String(child.exitCode ?? child.signalCode)}).\n${Buffer.concat(stderrChunks).toString('utf8')}`,
        );
      }
      if (child.pid && windowsForPid(child.pid, display).length > 0) {
        process.stdout.write(`electron:boot-smoke ok pid=${String(child.pid)}\n`);
        return;
      }
      await Promise.race([delay(POLL_MS), spawnError]);
    }
    throw new Error(
      `Electron produced no window within ${String(WINDOW_WAIT_MS)}ms.\n${Buffer.concat(stderrChunks).toString('utf8')}`,
    );
  } finally {
    stop(child);
    await waitForExit();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
