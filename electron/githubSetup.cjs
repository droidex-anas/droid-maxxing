// GitHub CLI installation and browser authentication for the Context panel.
// This module owns the single active setup process and never exposes command
// output or credentials outside Electron.
const { spawn } = require('node:child_process');
const { resolveExecutable, runFile } = require('./executable.cjs');

const DEFAULT_TIMEOUT = 15000;
const COMMON_BREW_PATHS = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'];
const INSTALL_TIMEOUT = 10 * 60 * 1000;
const AUTH_TIMEOUT = 10 * 60 * 1000;
const MAX_AUTH_OUTPUT = 16 * 1024;

let cachedBrewExecutablePromise;
let activeSetup = null;

function resolveBrewExecutable(options = {}) {
  return resolveExecutable({ binaryName: 'brew', commonPaths: COMMON_BREW_PATHS }, options);
}

async function cachedBrewExecutable() {
  cachedBrewExecutablePromise ||= resolveBrewExecutable();
  const executable = await cachedBrewExecutablePromise;
  if (!executable) cachedBrewExecutablePromise = undefined;
  return executable;
}

function scheduleBoundedTermination(
  child,
  { timeoutMs, terminationGraceMs, setTimer, clearTimer, onTimeout },
) {
  let disposed = false;
  let forceKillTimer;
  const timeoutTimer = setTimer(() => {
    if (disposed) return;
    onTimeout();
    child.kill();
    if (disposed) return;
    forceKillTimer = setTimer(() => {
      if (!disposed) child.kill('SIGKILL');
    }, terminationGraceMs);
    forceKillTimer.unref?.();
  }, timeoutMs);
  timeoutTimer.unref?.();

  return () => {
    disposed = true;
    clearTimer(timeoutTimer);
    if (forceKillTimer) clearTimer(forceKillTimer);
  };
}

function runSetupFile(
  file,
  args,
  {
    timeout,
    operation,
    spawnProcess = spawn,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    terminationGraceMs = 5_000,
  },
) {
  return new Promise((resolve) => {
    let child;
    let stopTermination;
    let timedOut = false;
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      stopTermination?.();
      if (operation.child === child) operation.child = null;
      child?.removeAllListeners();
      resolve(result);
    };

    try {
      child = spawnProcess(file, args, { stdio: ['ignore', 'ignore', 'ignore'] });
    } catch {
      finish({ code: 1, timedOut: false });
      return;
    }

    operation.child = child;
    child.once('error', () => finish({ code: 1, timedOut }));
    child.once('close', (code) => finish({ code: typeof code === 'number' ? code : 1, timedOut }));
    stopTermination = scheduleBoundedTermination(child, {
      timeoutMs: timeout,
      terminationGraceMs,
      setTimer,
      clearTimer,
      onTimeout: () => {
        timedOut = true;
      },
    });
    if (operation.cancelled) child.kill();
  });
}

async function install(options = {}) {
  if (activeSetup) {
    return { ok: false, reason: 'busy', message: 'GitHub setup is already running.' };
  }

  const operation = { kind: 'install', cancelled: false, child: null };
  activeSetup = operation;
  const resolveBrew = options.resolveBrew || cachedBrewExecutable;
  const execute = options.execute || runSetupFile;
  const resolveGh = options.resolveGh || (async () => null);

  try {
    const brew = await resolveBrew();
    if (operation.cancelled) {
      return { ok: false, reason: 'cancelled', message: 'GitHub CLI installation was cancelled.' };
    }
    if (!brew) {
      return { ok: false, reason: 'installer_missing', message: 'Homebrew is not installed.' };
    }
    const result = await execute(brew, ['install', 'gh'], {
      timeout: INSTALL_TIMEOUT,
      operation,
    });
    if (operation.cancelled) {
      return { ok: false, reason: 'cancelled', message: 'GitHub CLI installation was cancelled.' };
    }
    if (result.timedOut) {
      return { ok: false, reason: 'timeout', message: 'GitHub CLI installation timed out.' };
    }
    if (result.code !== 0) {
      return {
        ok: false,
        reason: 'install_failed',
        message: 'Homebrew could not install GitHub CLI.',
      };
    }
    options.invalidateGh?.();
    const gh = await resolveGh();
    if (operation.cancelled) {
      return { ok: false, reason: 'cancelled', message: 'GitHub CLI installation was cancelled.' };
    }
    if (!gh) {
      return {
        ok: false,
        reason: 'verification_failed',
        message: 'GitHub CLI was not found after installation.',
      };
    }
    return { ok: true };
  } catch {
    return {
      ok: false,
      reason: 'install_failed',
      message: 'Homebrew could not install GitHub CLI.',
    };
  } finally {
    if (activeSetup === operation) activeSetup = null;
  }
}

function cancelSetup() {
  if (!activeSetup) return;
  activeSetup.cancelled = true;
  activeSetup.child?.kill();
}

function isGithubDeviceUrl(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.hostname === 'github.com' &&
      url.port === '' &&
      url.pathname === '/login/device' &&
      url.search === '' &&
      url.hash === ''
    );
  } catch {
    return false;
  }
}

function githubDeviceCode(value) {
  const match = String(value).match(/one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})\b/i);
  return match ? match[1].toUpperCase() : null;
}

async function verifyGithubAuth(executable, execute = runFile) {
  const result = await execute(executable, ['auth', 'status', '--hostname', 'github.com'], {
    timeout: DEFAULT_TIMEOUT,
  });
  return result.code === 0;
}

function runAuthenticationProcess(executable, operation, options = {}) {
  const spawnProcess = options.spawnProcess || spawn;
  const verifyAuth = options.verifyAuth || (() => verifyGithubAuth(executable));
  const scheduleTimeout = options.setTimer || setTimeout;
  const cancelTimeout = options.clearTimer || clearTimeout;
  const timeoutMs = options.authTimeoutMs || AUTH_TIMEOUT;
  const terminationGraceMs = options.terminationGraceMs ?? 5_000;

  return new Promise((resolve) => {
    let child;
    let output = '';
    let sawDeviceUrl = false;
    let deviceCode = null;
    let rejectedUrl = false;
    let timedOut = false;
    let settled = false;
    let stopTermination;

    const cleanup = () => {
      stopTermination?.();
      child?.stdout?.removeListener('data', onOutput);
      child?.stderr?.removeListener('data', onOutput);
      child?.removeListener('error', onError);
      child?.removeListener('close', onClose);
      if (operation.child === child) operation.child = null;
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const failBrowser = (message) => {
      child?.kill();
      finish({ ok: false, reason: 'browser_failed', message });
    };
    const inspectOutput = (text) => {
      if (settled || rejectedUrl) return;
      if (!deviceCode) {
        deviceCode = githubDeviceCode(text);
        if (deviceCode) {
          try {
            options.onDeviceCode?.(deviceCode);
          } catch {
            // Renderer replacement must not interrupt the CLI-owned auth flow.
          }
        }
      }
      if (sawDeviceUrl) return;
      const match = text.match(/https?:\/\/[^\s"'<>]+/i);
      if (!match) return;
      const url = match[0];
      if (!isGithubDeviceUrl(url)) {
        rejectedUrl = true;
        failBrowser('GitHub CLI did not provide a trusted sign-in page.');
        return;
      }
      sawDeviceUrl = true;
    };
    const onOutput = (chunk) => {
      if (settled || rejectedUrl) return;
      output = `${output}${String(chunk)}`.slice(-MAX_AUTH_OUTPUT);
      const lastLineBreak = Math.max(output.lastIndexOf('\n'), output.lastIndexOf('\r'));
      if (lastLineBreak < 0) return;
      const complete = output.slice(0, lastLineBreak + 1);
      output = output.slice(lastLineBreak + 1);
      inspectOutput(complete);
    };
    const onError = () => {
      finish({ ok: false, reason: 'auth_failed', message: 'GitHub sign-in could not start.' });
    };
    const onClose = async (code) => {
      if (settled) return;
      if (!sawDeviceUrl && !rejectedUrl && output) inspectOutput(output);
      if (settled) return;
      if (operation.cancelled) {
        finish({ ok: false, reason: 'cancelled', message: 'GitHub sign-in was cancelled.' });
        return;
      }
      if (timedOut) {
        finish({ ok: false, reason: 'timeout', message: 'GitHub sign-in timed out.' });
        return;
      }
      if (code !== 0) {
        finish({ ok: false, reason: 'auth_failed', message: 'GitHub sign-in did not finish.' });
        return;
      }
      if (!sawDeviceUrl) {
        finish({
          ok: false,
          reason: 'browser_failed',
          message: 'GitHub CLI did not provide a trusted sign-in page.',
        });
        return;
      }
      const authenticated = await verifyAuth();
      if (operation.cancelled) {
        finish({ ok: false, reason: 'cancelled', message: 'GitHub sign-in was cancelled.' });
        return;
      }
      if (timedOut) {
        finish({ ok: false, reason: 'timeout', message: 'GitHub sign-in timed out.' });
        return;
      }
      if (!authenticated) {
        finish({
          ok: false,
          reason: 'auth_failed',
          message: 'GitHub CLI could not verify the signed-in account.',
        });
        return;
      }
      finish({ ok: true });
    };

    try {
      child = spawnProcess(
        executable,
        [
          'auth',
          'login',
          '--hostname',
          'github.com',
          '--git-protocol',
          'https',
          '--web',
          '--clipboard',
          '--skip-ssh-key',
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch {
      finish({ ok: false, reason: 'auth_failed', message: 'GitHub sign-in could not start.' });
      return;
    }

    operation.child = child;
    child.stdout.on('data', onOutput);
    child.stderr.on('data', onOutput);
    child.once('error', onError);
    child.once('close', onClose);
    stopTermination = scheduleBoundedTermination(child, {
      timeoutMs,
      terminationGraceMs,
      setTimer: scheduleTimeout,
      clearTimer: cancelTimeout,
      onTimeout: () => {
        timedOut = true;
      },
    });
    if (operation.cancelled) child.kill();
  });
}

async function authenticate(options = {}) {
  if (activeSetup) {
    return { ok: false, reason: 'busy', message: 'GitHub setup is already running.' };
  }

  const operation = { kind: 'authenticate', cancelled: false, child: null };
  activeSetup = operation;
  const resolveGh = options.resolveGh || (async () => null);
  try {
    const executable = await resolveGh();
    if (operation.cancelled) {
      return { ok: false, reason: 'cancelled', message: 'GitHub sign-in was cancelled.' };
    }
    if (!executable) {
      return { ok: false, reason: 'auth_failed', message: 'GitHub CLI is not installed.' };
    }
    return await runAuthenticationProcess(executable, operation, options);
  } finally {
    if (activeSetup === operation) activeSetup = null;
  }
}

module.exports = {
  authenticate,
  cancelSetup,
  install,
  isGithubDeviceUrl,
  runSetupFile,
  resolveBrewExecutable,
};
