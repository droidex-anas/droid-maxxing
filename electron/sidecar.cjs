const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const READY_PATTERN = /(?:^|\n)SIDECAR_READY (\d+)(?:\n|$)/;
const DEFAULT_READY_TIMEOUT_MS = 15_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 6_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 2_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 1_500;
const DEFAULT_MAX_RESTARTS = 5;
const DEFAULT_RESTART_WINDOW_MS = 60_000;
const DEFAULT_RESTART_BACKOFF_MS = 250;
const DEFAULT_MAX_RESTART_BACKOFF_MS = 5_000;

function createSidecarSupervisor(options) {
  const spawnProcess = options.spawnProcess || spawn;
  const output = options.stdout || process.stdout;
  const errorOutput = options.stderr || process.stderr;
  const readyTimeoutMs = options.readyTimeoutMs || DEFAULT_READY_TIMEOUT_MS;
  const shutdownTimeoutMs = options.shutdownTimeoutMs || DEFAULT_SHUTDOWN_TIMEOUT_MS;
  const heartbeatIntervalMs = options.heartbeatIntervalMs || DEFAULT_HEARTBEAT_INTERVAL_MS;
  const heartbeatTimeoutMs = options.heartbeatTimeoutMs || DEFAULT_HEARTBEAT_TIMEOUT_MS;
  const maxRestarts = options.maxRestarts || DEFAULT_MAX_RESTARTS;
  const restartWindowMs = options.restartWindowMs || DEFAULT_RESTART_WINDOW_MS;
  const restartBackoffMs = options.restartBackoffMs || DEFAULT_RESTART_BACKOFF_MS;
  const maxRestartBackoffMs = options.maxRestartBackoffMs || DEFAULT_MAX_RESTART_BACKOFF_MS;
  const now = options.now || Date.now;
  const random = options.random || Math.random;
  const requestHealth = options.requestHealth || defaultRequestHealth;
  const schedule =
    options.schedule ||
    ((callback, delayMs) => {
      const timer = setTimeout(callback, delayMs);
      timer.unref?.();
      return () => clearTimeout(timer);
    });

  let child = null;
  let bridgeInfo = null;
  let pendingStart = null;
  let pendingStop = null;
  let activeRun = null;
  let lifecycle = 'stopped';
  let processAlive = false;
  let bridgeResponsive = false;
  let lastHeartbeatAt = null;
  let lastReason = null;
  let restartAt = [];
  let readyWaiters = [];
  let cancelHeartbeat = null;
  let cancelRestart = null;
  const listeners = new Set();

  function snapshot() {
    return {
      lifecycle,
      processAlive,
      bridgeResponsive,
      lastHeartbeatAt,
      restartCount: restartsInWindow().length,
      ...(lastReason ? { reason: lastReason } : {}),
      ...(bridgeInfo ? { port: bridgeInfo.port } : {}),
    };
  }

  function setLifecycle(next, reason) {
    if (lifecycle === next && reason === lastReason) return;
    lifecycle = next;
    lastReason = reason ?? null;
    const current = snapshot();
    for (const listener of listeners) listener(current);
  }

  function subscribe(listener) {
    listeners.add(listener);
    listener(snapshot());
    return () => listeners.delete(listener);
  }

  function restartsInWindow() {
    const cutoff = now() - restartWindowMs;
    restartAt = restartAt.filter((at) => at > cutoff);
    return restartAt;
  }

  function isLiveChild(candidate) {
    return (
      candidate && candidate.exitCode === null && candidate.signalCode === null && !candidate.killed
    );
  }

  function start() {
    if (lifecycle === 'recovery-required') {
      return Promise.reject(new Error('Sidecar recovery is required.'));
    }
    if (pendingStart) return pendingStart;
    if (bridgeInfo && isLiveChild(child)) return Promise.resolve(bridgeInfo);
    cancelRestart?.();
    cancelRestart = null;
    pendingStop = null;
    return spawnSidecar();
  }

  function getBridgeInfo() {
    if (bridgeInfo && isLiveChild(child)) return Promise.resolve(bridgeInfo);
    if (pendingStart) return pendingStart;
    if (lifecycle === 'stopped') return Promise.reject(new Error('Sidecar is stopped.'));
    if (lifecycle === 'recovery-required') {
      return Promise.reject(new Error('Sidecar recovery is required.'));
    }
    return new Promise((resolve, reject) => {
      readyWaiters.push({ resolve, reject });
    });
  }

  function resolveWaiters(info) {
    const waiters = readyWaiters;
    readyWaiters = [];
    for (const waiter of waiters) waiter.resolve(info);
  }

  function rejectWaiters(error) {
    const waiters = readyWaiters;
    readyWaiters = [];
    for (const waiter of waiters) waiter.reject(error);
  }

  function spawnSidecar() {
    if (pendingStart) return pendingStart;
    if (isLiveChild(child) && bridgeInfo) return Promise.resolve(bridgeInfo);

    setLifecycle('starting');
    processAlive = true;
    bridgeResponsive = false;
    const token = crypto.randomBytes(32).toString('hex');
    const assetToken = crypto.randomBytes(32).toString('hex');
    const nextChild = spawnProcess(process.execPath, [options.entryPath()], {
      cwd: options.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        BRIDGE_PORT: process.env.BRIDGE_PORT || '0',
        BRIDGE_TOKEN: token,
        BROWSER_ASSET_TOKEN: assetToken,
        DROIDEX_USER_DATA_DIR: options.userData(),
        BRIDGE_EXIT_ON_STDIN_CLOSE: '1',
      },
    });
    const run = {
      child: nextChild,
      intentionalStop: false,
      concluded: false,
      cancelStartup: null,
      resolveExit: null,
    };
    run.exitPromise = new Promise((resolve) => {
      run.resolveExit = resolve;
    });
    child = nextChild;
    activeRun = run;

    const startPromise = new Promise((resolve, reject) => {
      let stdoutBuffer = '';
      let settled = false;
      const timeout = setTimeout(() => {
        fail(new Error(`Sidecar did not become ready within ${readyTimeoutMs}ms.`));
        nextChild.kill();
      }, readyTimeoutMs);
      timeout.unref?.();

      function fail(error) {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (activeRun === run) bridgeInfo = null;
        reject(error);
      }
      run.cancelStartup = () => fail(new Error('Sidecar startup was cancelled.'));

      nextChild.once('error', (error) => {
        const failure = new Error(`Sidecar failed to start (${error.message}).`);
        fail(failure);
        concludeRun(run, failure);
      });
      nextChild.once('exit', (code, signal) => {
        if (!settled) {
          fail(new Error(`Sidecar exited before ready (${code ?? signal ?? 'unknown'}).`));
        }
        const failure =
          run.intentionalStop || lifecycle === 'stopped'
            ? undefined
            : new Error(`Sidecar exited unexpectedly (${code ?? signal}).`);
        concludeRun(run, failure);
      });
      nextChild.stdout.on('data', (chunk) => {
        const text = String(chunk);
        output.write(text);
        if (settled || activeRun !== run) return;
        stdoutBuffer = `${stdoutBuffer}${text}`.slice(-512);
        const match = stdoutBuffer.match(READY_PATTERN);
        if (!match) return;
        const port = Number(match[1]);
        if (!Number.isInteger(port) || port < 1 || port > 65_535) {
          fail(new Error(`Sidecar reported an invalid port: ${match[1]}.`));
          nextChild.kill();
          return;
        }
        settled = true;
        clearTimeout(timeout);
        bridgeInfo = { port, token };
        bridgeResponsive = true;
        setLifecycle('healthy');
        startHeartbeat();
        resolve(bridgeInfo);
        resolveWaiters(bridgeInfo);
      });
      nextChild.stderr.on('data', (chunk) => {
        const text = String(chunk);
        errorOutput.write(text);
      });
    });
    const wrappedStart = startPromise.finally(() => {
      if (pendingStart === wrappedStart) pendingStart = null;
    });
    pendingStart = wrappedStart;
    return pendingStart;
  }

  function concludeRun(run, failure) {
    if (run.concluded) return;
    run.concluded = true;
    run.resolveExit?.();
    if (activeRun === run) {
      activeRun = null;
      child = null;
      bridgeInfo = null;
      processAlive = false;
      bridgeResponsive = false;
      stopHeartbeat();
    }
    if (!failure || run.intentionalStop || lifecycle === 'stopped') return;
    errorOutput.write(`${failure.message}\n`);
    options.onUnexpectedExit?.(failure);
    scheduleRestart(failure.message);
  }

  function scheduleRestart(reason) {
    const attempts = restartsInWindow();
    if (attempts.length >= maxRestarts) {
      setLifecycle('recovery-required', reason);
      rejectWaiters(new Error('Sidecar recovery is required.'));
      return;
    }
    restartAt.push(now());
    setLifecycle('restarting', reason);
    const delay = restartDelayMs(attempts.length);
    cancelRestart?.();
    cancelRestart = schedule(() => {
      cancelRestart = null;
      if (lifecycle !== 'restarting') return;
      void start().catch((error) => {
        errorOutput.write(`${error.message}\n`);
        // Spawn `error` and process `exit` already scheduled via concludeRun.
        if (cancelRestart) return;
        if (lifecycle === 'restarting' || lifecycle === 'starting') {
          scheduleRestart(error.message);
        }
      });
    }, delay);
  }

  function restartDelayMs(attempt) {
    const exponential = Math.min(restartBackoffMs * 2 ** attempt, maxRestartBackoffMs);
    return exponential + random() * restartBackoffMs;
  }

  function startHeartbeat() {
    stopHeartbeat();
    const poll = () => {
      const info = bridgeInfo;
      const run = activeRun;
      if (!info || !run || lifecycle === 'stopped' || lifecycle === 'recovery-required') return;
      void requestHealth({
        port: info.port,
        token: info.token,
        timeoutMs: heartbeatTimeoutMs,
      }).then(
        () => {
          if (activeRun !== run) return;
          lastHeartbeatAt = now();
          bridgeResponsive = true;
          if (lifecycle === 'degraded' || lifecycle === 'starting') setLifecycle('healthy');
        },
        () => {
          // A missed or slow /health while the child is still alive is
          // degraded, never death. Only the process `exit` handler restarts.
          // The JSON body is unused: busy vs gone is HTTP success vs timeout.
          if (activeRun !== run || !processAlive) return;
          bridgeResponsive = false;
          if (lifecycle === 'healthy' || lifecycle === 'starting') {
            setLifecycle(
              'degraded',
              'Bridge heartbeat timed out while the sidecar process is still running.',
            );
          }
        },
      );
    };
    poll();
    const arm = () => {
      cancelHeartbeat = schedule(() => {
        poll();
        arm();
      }, heartbeatIntervalMs);
    };
    arm();
  }

  function stopHeartbeat() {
    cancelHeartbeat?.();
    cancelHeartbeat = null;
  }

  function stop() {
    if (pendingStop) return pendingStop;
    cancelRestart?.();
    cancelRestart = null;
    stopHeartbeat();
    const current = child;
    const run = activeRun;
    if (run && run.child === current) {
      run.intentionalStop = true;
      run.cancelStartup?.();
      activeRun = null;
    }
    child = null;
    bridgeInfo = null;
    pendingStart = null;
    processAlive = false;
    bridgeResponsive = false;
    setLifecycle('stopped');
    rejectWaiters(new Error('Sidecar is stopped.'));
    if (!current || current.killed) {
      pendingStop = Promise.resolve();
      return pendingStop;
    }
    current.stdin?.end();
    current.kill('SIGTERM');
    let cancelForceKill = null;
    const forcedExit = new Promise((resolve) => {
      // Outer hard guard only: this races the sidecar's own shutdown attempt
      // and must not grant a second cleanup window or send a second deadline.
      cancelForceKill = schedule(() => {
        if (current.exitCode === null && current.signalCode === null) current.kill('SIGKILL');
        resolve();
      }, shutdownTimeoutMs);
    });
    pendingStop = Promise.race([run?.exitPromise ?? Promise.resolve(), forcedExit]).finally(() => {
      cancelForceKill?.();
    });
    return pendingStop;
  }

  return { start, getBridgeInfo, stop, snapshot, subscribe };
}

async function defaultRequestHealth({ port, token, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}/health?token=${token}`, {
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Sidecar health returned ${String(response.status)}.`);
    // Success is HTTP 200. eventLoopDelayMs and other body fields are unused.
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { createSidecarSupervisor, defaultRequestHealth };
