const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const {
  available,
  authenticate,
  cancelSetup,
  install,
  isGithubDeviceUrl,
  listPrs,
  mergePr,
  prDiff,
  prSelector,
  resolveBrewExecutable,
  resolveGhExecutable,
  viewPr,
} = require('./github.cjs');
const { runSetupFile } = require('./githubSetup.cjs');

const ghResult = (overrides = {}) => ({
  code: 0,
  stdout: '',
  stderr: '',
  spawnFailed: false,
  ...overrides,
});

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => {
    if (child.killed) return true;
    child.killed = true;
    queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
    return true;
  };
  return child;
}

test('resolves Homebrew gh under a Finder-style PATH', async () => {
  const probes = [];
  const executable = await resolveGhExecutable({
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', SHELL: '/bin/zsh' },
    access: async (candidate) => {
      if (candidate !== '/opt/homebrew/bin/gh') {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      }
    },
    runFile: async (file, args) => {
      probes.push([file, args]);
      return ghResult({ stdout: 'gh version 2.78.0' });
    },
  });

  assert.equal(executable, '/opt/homebrew/bin/gh');
  assert.deepEqual(probes, [['/opt/homebrew/bin/gh', ['--version']]]);
});

test('prefers PATH and validates the executable before common locations', async () => {
  const candidates = [];
  const executable = await resolveGhExecutable({
    env: { PATH: '/custom/bin:/usr/bin', SHELL: '/bin/zsh' },
    access: async (candidate) => {
      candidates.push(candidate);
      if (candidate !== '/custom/bin/gh') throw new Error('unexpected candidate');
    },
    runFile: async () => ghResult({ stdout: 'gh version 2.78.0' }),
  });

  assert.equal(executable, '/custom/bin/gh');
  assert.deepEqual(candidates, ['/custom/bin/gh']);
});

test('uses the fixed login-shell lookup last and returns null when it is invalid', async () => {
  const shellCalls = [];
  const executable = await resolveGhExecutable({
    env: { PATH: '/usr/bin:/bin', SHELL: '/bin/zsh' },
    access: async () => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    },
    runFile: async (file, args) => {
      shellCalls.push([file, args]);
      return ghResult({ stdout: '/custom/login/bin/gh\n' });
    },
  });

  assert.equal(executable, null);
  assert.deepEqual(shellCalls, [['/bin/zsh', ['-lc', 'command -v gh']]]);
});

test('discovers gh from the configured login shell after common paths fail', async () => {
  const executable = await resolveGhExecutable({
    env: { PATH: '/usr/bin:/bin', SHELL: '/bin/zsh' },
    access: async (candidate) => {
      if (candidate !== '/custom/login/bin/gh') throw new Error('missing');
    },
    runFile: async (file, args) => {
      if (file === '/bin/zsh') {
        assert.deepEqual(args, ['-lc', 'command -v gh']);
        return ghResult({ stdout: '/custom/login/bin/gh\n' });
      }
      return ghResult({ stdout: 'gh version 2.78.0' });
    },
  });

  assert.equal(executable, '/custom/login/bin/gh');
});

test('discovers gh through the macOS login shell when Finder omits SHELL', async () => {
  const executable = await resolveGhExecutable({
    platform: 'darwin',
    env: { PATH: '/usr/bin:/bin' },
    access: async (candidate) => {
      if (candidate !== '/custom/login/bin/gh') throw new Error('missing');
    },
    runFile: async (file, args) => {
      if (file === '/bin/zsh') {
        assert.deepEqual(args, ['-lc', 'command -v gh']);
        return ghResult({ stdout: '/custom/login/bin/gh\n' });
      }
      return ghResult({ stdout: 'gh version 2.78.0' });
    },
  });

  assert.equal(executable, '/custom/login/bin/gh');
});

test('ignores login-shell banner lines when discovering gh', async () => {
  const executable = await resolveGhExecutable({
    env: { PATH: '/usr/bin:/bin', SHELL: '/bin/zsh' },
    access: async (candidate) => {
      if (candidate !== '/custom/login/bin/gh') throw new Error('missing');
    },
    runFile: async (file) => {
      if (file === '/bin/zsh') {
        return ghResult({ stdout: 'Welcome to this shell\n/custom/login/bin/gh\n' });
      }
      return ghResult({ stdout: 'gh version 2.78.0' });
    },
  });

  assert.equal(executable, '/custom/login/bin/gh');
});

test('availability reports the supported recovery path when gh is missing', async () => {
  const homebrew = await available({
    runGh: async () => ghResult({ code: 1, spawnFailed: true }),
    resolveBrew: async () => '/opt/homebrew/bin/brew',
  });
  assert.deepEqual(homebrew, {
    installed: false,
    authenticated: false,
    installMethod: 'homebrew',
  });

  const manual = await available({
    runGh: async () => ghResult({ code: 1, spawnFailed: true }),
    resolveBrew: async () => null,
  });
  assert.deepEqual(manual, {
    installed: false,
    authenticated: false,
    installMethod: 'manual',
  });
});

test('resolves Apple Silicon Homebrew under a Finder-style PATH', async () => {
  const executable = await resolveBrewExecutable({
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', SHELL: '/bin/zsh' },
    access: async (candidate) => {
      if (candidate !== '/opt/homebrew/bin/brew') throw new Error('missing');
    },
    runFile: async (file, args) => {
      assert.equal(file, '/opt/homebrew/bin/brew');
      assert.deepEqual(args, ['--version']);
      return ghResult({ stdout: 'Homebrew 4.6.0' });
    },
  });

  assert.equal(executable, '/opt/homebrew/bin/brew');
});

test('resolves Intel Homebrew after the Apple Silicon location is absent', async () => {
  const executable = await resolveBrewExecutable({
    env: { PATH: '/usr/bin:/bin', SHELL: '/bin/zsh' },
    access: async (candidate) => {
      if (candidate !== '/usr/local/bin/brew') throw new Error('missing');
    },
    runFile: async () => ghResult({ stdout: 'Homebrew 4.6.0' }),
  });

  assert.equal(executable, '/usr/local/bin/brew');
});

test('installs gh with a fixed Homebrew argument vector and verifies gh', async () => {
  const calls = [];
  const result = await install({
    resolveBrew: async () => '/opt/homebrew/bin/brew',
    execute: async (file, args) => {
      calls.push([file, args]);
      return { code: 0, timedOut: false };
    },
    resolveGh: async () => '/opt/homebrew/bin/gh',
  });

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls, [['/opt/homebrew/bin/brew', ['install', 'gh']]]);
});

test('installation reports a missing supported package manager', async () => {
  const result = await install({ resolveBrew: async () => null });

  assert.deepEqual(result, {
    ok: false,
    reason: 'installer_missing',
    message: 'Homebrew is not installed.',
  });
});

test('cancelling during Homebrew discovery never starts installation', async () => {
  let finishDiscovery;
  let installationStarted = false;
  const pending = install({
    resolveBrew: async () =>
      new Promise((resolve) => {
        finishDiscovery = resolve;
      }),
    execute: async () => {
      installationStarted = true;
      return { code: 0, timedOut: false };
    },
  });
  await Promise.resolve();

  cancelSetup();
  finishDiscovery('/opt/homebrew/bin/brew');

  assert.deepEqual(await pending, {
    ok: false,
    reason: 'cancelled',
    message: 'GitHub CLI installation was cancelled.',
  });
  assert.equal(installationStarted, false);
});

test('installation verifies gh even when Homebrew exits successfully', async () => {
  const result = await install({
    resolveBrew: async () => '/opt/homebrew/bin/brew',
    execute: async () => ({ code: 0, timedOut: false }),
    resolveGh: async () => null,
  });

  assert.deepEqual(result, {
    ok: false,
    reason: 'verification_failed',
    message: 'GitHub CLI was not found after installation.',
  });
});

test('cancelling during post-install verification cannot report success', async () => {
  let verificationStarted;
  const started = new Promise((resolve) => {
    verificationStarted = resolve;
  });
  let finishVerification;
  const pending = install({
    resolveBrew: async () => '/opt/homebrew/bin/brew',
    execute: async () => ({ code: 0, timedOut: false }),
    resolveGh: async () => {
      verificationStarted();
      return new Promise((resolve) => {
        finishVerification = resolve;
      });
    },
  });
  await started;

  cancelSetup();
  finishVerification('/opt/homebrew/bin/gh');

  assert.deepEqual(await pending, {
    ok: false,
    reason: 'cancelled',
    message: 'GitHub CLI installation was cancelled.',
  });
});

test('installation reports Homebrew failure and timeout without raw output', async () => {
  const failed = await install({
    resolveBrew: async () => '/opt/homebrew/bin/brew',
    execute: async () => ({ code: 1, timedOut: false, stderr: 'private package details' }),
  });
  assert.deepEqual(failed, {
    ok: false,
    reason: 'install_failed',
    message: 'Homebrew could not install GitHub CLI.',
  });

  const timedOut = await install({
    resolveBrew: async () => '/opt/homebrew/bin/brew',
    execute: async () => ({ code: 1, timedOut: true }),
  });
  assert.deepEqual(timedOut, {
    ok: false,
    reason: 'timeout',
    message: 'GitHub CLI installation timed out.',
  });
});

test('timed-out installation stays active until the child exits and escalates termination', async () => {
  const child = new EventEmitter();
  const killSignals = [];
  const timers = [];
  child.kill = (signal) => {
    killSignals.push(signal ?? 'SIGTERM');
    return true;
  };
  const operation = { child: null };
  let settled = false;

  const pending = runSetupFile('/opt/homebrew/bin/brew', ['install', 'gh'], {
    timeout: 100,
    terminationGraceMs: 25,
    operation,
    spawnProcess: () => child,
    setTimer: (callback, timeoutMs) => {
      const timer = { callback, timeoutMs, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimer: () => undefined,
  }).then((result) => {
    settled = true;
    return result;
  });

  assert.equal(operation.child, child);
  assert.equal(timers[0].timeoutMs, 100);
  timers[0].callback();
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(operation.child, child);
  assert.deepEqual(killSignals, ['SIGTERM']);

  assert.equal(timers[1].timeoutMs, 25);
  timers[1].callback();
  assert.deepEqual(killSignals, ['SIGTERM', 'SIGKILL']);
  child.emit('close', null, 'SIGKILL');

  assert.deepEqual(await pending, { code: 1, timedOut: true });
  assert.equal(operation.child, null);
});

test('cancelling installation escalates when Homebrew ignores SIGTERM', async () => {
  const child = new EventEmitter();
  const killSignals = [];
  const timers = [];
  child.kill = (signal) => {
    const normalizedSignal = signal ?? 'SIGTERM';
    killSignals.push(normalizedSignal);
    if (normalizedSignal === 'SIGKILL') {
      queueMicrotask(() => child.emit('close', null, normalizedSignal));
    }
    return true;
  };
  const pending = install({
    resolveBrew: async () => '/opt/homebrew/bin/brew',
    execute: (file, args, options) =>
      runSetupFile(file, args, {
        ...options,
        terminationGraceMs: 25,
        spawnProcess: () => child,
        setTimer: (callback, timeoutMs) => {
          const timer = { callback, timeoutMs, unref() {} };
          timers.push(timer);
          return timer;
        },
        clearTimer: () => undefined,
      }),
    resolveGh: async () => '/opt/homebrew/bin/gh',
  });
  await Promise.resolve();

  cancelSetup();
  assert.deepEqual(killSignals, ['SIGTERM']);
  assert.equal(timers[1].timeoutMs, 25);
  timers[1].callback();

  assert.deepEqual(killSignals, ['SIGTERM', 'SIGKILL']);
  assert.deepEqual(await pending, {
    ok: false,
    reason: 'cancelled',
    message: 'GitHub CLI installation was cancelled.',
  });
});

test('only one GitHub setup operation runs at a time', async () => {
  let finishInstall;
  const first = install({
    resolveBrew: async () => '/opt/homebrew/bin/brew',
    execute: async () =>
      new Promise((resolve) => {
        finishInstall = () => resolve({ code: 0, timedOut: false });
      }),
    resolveGh: async () => '/opt/homebrew/bin/gh',
  });
  await Promise.resolve();

  const second = await install({ resolveBrew: async () => '/opt/homebrew/bin/brew' });
  assert.deepEqual(second, {
    ok: false,
    reason: 'busy',
    message: 'GitHub setup is already running.',
  });

  finishInstall();
  assert.deepEqual(await first, { ok: true });
});

test('accepts only the exact GitHub device-login URL', () => {
  assert.equal(isGithubDeviceUrl('https://github.com/login/device'), true);
  assert.equal(isGithubDeviceUrl('https://github.com/login/device/extra'), false);
  assert.equal(isGithubDeviceUrl('https://github.com.evil.test/login/device'), false);
  assert.equal(isGithubDeviceUrl('http://github.com/login/device'), false);
  assert.equal(isGithubDeviceUrl('not a URL'), false);
});

test('browser authentication lets gh open its emitted device URL exactly once', async () => {
  const deviceCodes = [];
  const child = fakeChild();
  const pending = authenticate({
    resolveGh: async () => '/opt/homebrew/bin/gh',
    spawnProcess: (file, args, options) => {
      assert.equal(file, '/opt/homebrew/bin/gh');
      assert.deepEqual(args, [
        'auth',
        'login',
        '--hostname',
        'github.com',
        '--git-protocol',
        'https',
        '--web',
        '--clipboard',
        '--skip-ssh-key',
      ]);
      assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
      queueMicrotask(() => {
        child.stderr.write('First copy your one-time code: ABCD-7HJK\n');
        child.stderr.write('Open this URL to continue: https://github.com/login/');
        child.stderr.write('device\n');
        child.emit('close', 0, null);
      });
      return child;
    },
    onDeviceCode: (code) => deviceCodes.push(code),
    verifyAuth: async () => true,
  });

  assert.deepEqual(await pending, { ok: true });
  assert.deepEqual(deviceCodes, ['ABCD-7HJK']);
});

test('browser authentication never exposes malformed device codes', async () => {
  const deviceCodes = [];
  const child = fakeChild();
  const result = await authenticate({
    resolveGh: async () => '/opt/homebrew/bin/gh',
    spawnProcess: () => {
      queueMicrotask(() => {
        child.stderr.write('First copy your one-time code: not-a-code\n');
        child.stderr.write('https://github.com/login/device\n');
        child.emit('close', 0, null);
      });
      return child;
    },
    onDeviceCode: (code) => deviceCodes.push(code),
    verifyAuth: async () => true,
  });

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(deviceCodes, []);
});

test('browser authentication rejects a non-GitHub verification URL', async () => {
  const child = fakeChild();
  const result = await authenticate({
    resolveGh: async () => '/opt/homebrew/bin/gh',
    spawnProcess: () => {
      queueMicrotask(() => {
        child.stderr.write('Open this URL: https://github.com.evil.test/login/device\n');
        child.emit('close', 0, null);
      });
      return child;
    },
    verifyAuth: async () => true,
  });

  assert.deepEqual(result, {
    ok: false,
    reason: 'browser_failed',
    message: 'GitHub CLI did not provide a trusted sign-in page.',
  });
});

test('browser URL rejection stays owned until bounded termination closes the child', async () => {
  const child = fakeChild();
  const killSignals = [];
  const timers = [];
  child.kill = (signal) => {
    const normalizedSignal = signal ?? 'SIGTERM';
    killSignals.push(normalizedSignal);
    if (normalizedSignal === 'SIGKILL') {
      queueMicrotask(() => child.emit('close', null, normalizedSignal));
    }
    return true;
  };
  let settled = false;
  const pending = authenticate({
    resolveGh: async () => '/opt/homebrew/bin/gh',
    spawnProcess: () => child,
    verifyAuth: async () => true,
    authTimeoutMs: 1_000,
    terminationGraceMs: 25,
    setTimer: (callback, timeoutMs) => {
      const timer = { callback, timeoutMs, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimer: () => undefined,
  }).then((result) => {
    settled = true;
    return result;
  });
  await Promise.resolve();

  child.stderr.write('Open this URL: https://github.com.evil.test/login/device\n');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(settled, false);
  assert.deepEqual(killSignals, ['SIGTERM']);
  assert.equal(timers[1].timeoutMs, 25);
  timers[1].callback();

  assert.deepEqual(killSignals, ['SIGTERM', 'SIGKILL']);
  assert.deepEqual(await pending, {
    ok: false,
    reason: 'browser_failed',
    message: 'GitHub CLI did not provide a trusted sign-in page.',
  });
});

test('browser authentication requires final gh auth verification', async () => {
  const child = fakeChild();
  const result = await authenticate({
    resolveGh: async () => '/opt/homebrew/bin/gh',
    spawnProcess: () => {
      queueMicrotask(() => {
        child.stderr.write('https://github.com/login/device\n');
        child.emit('close', 0, null);
      });
      return child;
    },
    verifyAuth: async () => false,
  });

  assert.deepEqual(result, {
    ok: false,
    reason: 'auth_failed',
    message: 'GitHub CLI could not verify the signed-in account.',
  });
});

test('browser authentication handles verification rejection and releases the setup lock', async () => {
  const child = fakeChild();
  const result = await authenticate({
    resolveGh: async () => '/opt/homebrew/bin/gh',
    spawnProcess: () => {
      queueMicrotask(() => {
        child.stderr.write('https://github.com/login/device\n');
        child.emit('close', 0, null);
      });
      return child;
    },
    verifyAuth: async () => {
      throw new Error('verification failed');
    },
  });

  assert.deepEqual(result, {
    ok: false,
    reason: 'auth_failed',
    message: 'GitHub CLI could not verify the signed-in account.',
  });
  assert.notEqual((await authenticate({ resolveGh: async () => null })).reason, 'busy');
});

test('browser authentication times out and terminates its child', async () => {
  const child = fakeChild();
  const result = await authenticate({
    resolveGh: async () => '/opt/homebrew/bin/gh',
    spawnProcess: () => {
      setImmediate(() => child.emit('close', 1, null));
      return child;
    },
    verifyAuth: async () => true,
    authTimeoutMs: 25,
    setTimer: (callback, timeoutMs) => {
      assert.ok(timeoutMs === 25 || timeoutMs === 5_000);
      if (timeoutMs === 25) queueMicrotask(callback);
      return { unref() {} };
    },
    clearTimer: () => undefined,
  });

  assert.equal(child.killed, true);
  assert.deepEqual(result, {
    ok: false,
    reason: 'timeout',
    message: 'GitHub sign-in timed out.',
  });
});

test('timed-out browser authentication escalates when its child ignores SIGTERM', async () => {
  const child = fakeChild();
  const killSignals = [];
  const timers = [];
  child.kill = (signal) => {
    const normalizedSignal = signal ?? 'SIGTERM';
    killSignals.push(normalizedSignal);
    if (normalizedSignal === 'SIGKILL') {
      queueMicrotask(() => child.emit('close', null, normalizedSignal));
    }
    return true;
  };

  const pending = authenticate({
    resolveGh: async () => '/opt/homebrew/bin/gh',
    spawnProcess: () => child,
    verifyAuth: async () => true,
    authTimeoutMs: 100,
    terminationGraceMs: 25,
    setTimer: (callback, timeoutMs) => {
      const timer = { callback, timeoutMs, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimer: () => undefined,
  });
  await Promise.resolve();

  assert.equal(timers[0].timeoutMs, 100);
  timers[0].callback();
  await Promise.resolve();
  assert.deepEqual(killSignals, ['SIGTERM']);

  assert.equal(timers[1].timeoutMs, 25);
  timers[1].callback();
  assert.deepEqual(killSignals, ['SIGTERM', 'SIGKILL']);
  assert.deepEqual(await pending, {
    ok: false,
    reason: 'timeout',
    message: 'GitHub sign-in timed out.',
  });
});

test('cancelling browser authentication terminates its child process', async () => {
  const child = fakeChild();
  const pending = authenticate({
    resolveGh: async () => '/opt/homebrew/bin/gh',
    spawnProcess: () => child,
    verifyAuth: async () => true,
  });
  await Promise.resolve();

  cancelSetup();

  assert.equal(child.killed, true);
  assert.deepEqual(await pending, {
    ok: false,
    reason: 'cancelled',
    message: 'GitHub sign-in was cancelled.',
  });
});

test('cancelling browser authentication escalates when its child ignores SIGTERM', async () => {
  const child = fakeChild();
  const killSignals = [];
  const timers = [];
  child.kill = (signal) => {
    const normalizedSignal = signal ?? 'SIGTERM';
    killSignals.push(normalizedSignal);
    if (normalizedSignal === 'SIGKILL') {
      queueMicrotask(() => child.emit('close', null, normalizedSignal));
    }
    return true;
  };
  const pending = authenticate({
    resolveGh: async () => '/opt/homebrew/bin/gh',
    spawnProcess: () => child,
    verifyAuth: async () => true,
    authTimeoutMs: 1_000,
    terminationGraceMs: 25,
    setTimer: (callback, timeoutMs) => {
      const timer = { callback, timeoutMs, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimer: () => undefined,
  });
  await Promise.resolve();

  cancelSetup();
  assert.deepEqual(killSignals, ['SIGTERM']);
  assert.equal(timers[1].timeoutMs, 25);
  timers[1].callback();

  assert.deepEqual(killSignals, ['SIGTERM', 'SIGKILL']);
  assert.deepEqual(await pending, {
    ok: false,
    reason: 'cancelled',
    message: 'GitHub sign-in was cancelled.',
  });
});

test('cancelling during final authentication verification cannot report success', async () => {
  const child = fakeChild();
  let verificationStarted;
  const started = new Promise((resolve) => {
    verificationStarted = resolve;
  });
  let finishVerification;
  const pending = authenticate({
    resolveGh: async () => '/opt/homebrew/bin/gh',
    spawnProcess: () => {
      queueMicrotask(() => {
        child.stderr.write('https://github.com/login/device\n');
        child.emit('close', 0, null);
      });
      return child;
    },
    verifyAuth: async () => {
      verificationStarted();
      return new Promise((resolve) => {
        finishVerification = resolve;
      });
    },
  });

  await started;
  cancelSetup();
  finishVerification(true);

  assert.deepEqual(await pending, {
    ok: false,
    reason: 'cancelled',
    message: 'GitHub sign-in was cancelled.',
  });
});

test('authentication cannot report success when its deadline expires during verification', async () => {
  const child = fakeChild();
  child.killed = true;
  let timeoutCallback;
  let verificationStarted;
  const started = new Promise((resolve) => {
    verificationStarted = resolve;
  });
  let finishVerification;
  const pending = authenticate({
    resolveGh: async () => '/opt/homebrew/bin/gh',
    spawnProcess: () => {
      queueMicrotask(() => {
        child.stderr.write('https://github.com/login/device\n');
        child.emit('close', 0, null);
      });
      return child;
    },
    verifyAuth: async () => {
      verificationStarted();
      return new Promise((resolve) => {
        finishVerification = resolve;
      });
    },
    setTimer: (callback) => {
      timeoutCallback = callback;
      return { unref() {} };
    },
    clearTimer: () => undefined,
  });

  await started;
  timeoutCallback();
  finishVerification(true);

  assert.deepEqual(await pending, {
    ok: false,
    reason: 'timeout',
    message: 'GitHub sign-in timed out.',
  });
});

test('PR selectors accept only bare positive digit strings', () => {
  assert.equal(prSelector(78), '78');
  assert.equal(prSelector('078'), '078');
  assert.equal(prSelector('--repo=other/repo'), null);
  assert.equal(prSelector('https://github.com/example/repo/pull/78'), null);
});

test('listPrs returns normalized rows and the viewer login', async () => {
  const runGh = async (_cwd, args) => {
    runGh.calls.push(args);
    if (args[0] === 'api') return ghResult({ stdout: 'octocat\n' });
    return ghResult({
      stdout: JSON.stringify([
        {
          number: 12,
          title: 'Add inbox',
          state: 'OPEN',
          url: 'https://example.test/pull/12',
          isDraft: false,
          headRefName: 'feat',
          baseRefName: 'main',
          mergeable: 'MERGEABLE',
          reviewDecision: 'REVIEW_REQUIRED',
          additions: 4,
          deletions: 1,
          changedFiles: 2,
          createdAt: '2026-08-18T00:00:00Z',
          updatedAt: '2026-08-18T01:00:00Z',
          author: { login: 'ana' },
          reviewRequests: [{ login: 'octocat' }],
          reviews: [{ author: { login: 'dev' }, state: 'COMMENTED' }],
        },
      ]),
    });
  };
  runGh.calls = [];
  const result = await listPrs('/repo', { state: 'open', limit: 50 }, runGh);
  assert.equal(result.ok, true);
  assert.equal(result.viewerLogin, 'octocat');
  assert.equal(result.prs[0].number, 12);
  assert.deepEqual(result.prs[0].reviewRequests, ['octocat']);
  assert.deepEqual(result.prs[0].reviews, [{ author: 'dev', state: 'commented' }]);
  assert.ok(runGh.calls[0].includes('--json'));
});

test('listPrs failed gh keeps no invented rows', async () => {
  const runGh = async (_cwd, args) => {
    if (args[0] === 'api') return ghResult({ stdout: 'octocat\n' });
    return ghResult({ code: 1, stderr: 'boom' });
  };
  const result = await listPrs('/repo', {}, runGh);
  assert.equal(result.ok, false);
  assert.deepEqual(result.prs, []);
  assert.equal(result.viewerLogin, null);
});

test('viewPr rejects a non-integer selector before spawning gh', async () => {
  let spawned = false;
  const runGh = async () => {
    spawned = true;
    return ghResult();
  };
  const result = await viewPr('/repo', { prNumber: 'https://github.com/o/r/pull/1' }, runGh);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing_pr');
  assert.equal(result.pr, null);
  assert.equal(spawned, false);
});

test('viewPr returns body on the detail payload', async () => {
  const runGh = async () =>
    ghResult({
      stdout: JSON.stringify({
        number: 12,
        title: 'Add inbox',
        state: 'OPEN',
        url: 'https://example.test/pull/12',
        isDraft: false,
        headRefName: 'feat',
        baseRefName: 'main',
        body: 'Hello',
        author: { login: 'ana' },
        reviewRequests: [],
        reviews: [],
      }),
    });
  const result = await viewPr('/repo', { prNumber: 12 }, runGh);
  assert.equal(result.ok, true);
  assert.equal(result.pr.body, 'Hello');
  assert.deepEqual(result.pr.reviewRequests, []);
});

test('viewPr returns the head branch commits with their GitHub authors', async () => {
  const runGh = async (_cwd, args) => {
    assert.match(args[3], /,commits$/);
    return ghResult({
      stdout: JSON.stringify({
        number: 12,
        title: 'Add inbox',
        state: 'OPEN',
        body: '',
        author: { login: 'ana' },
        reviewRequests: [],
        reviews: [],
        commits: [
          {
            oid: '1111111111111111',
            messageHeadline: ' Add the inbox ',
            committedDate: '2026-08-04T09:00:00Z',
            authors: [{ name: 'Ana', login: 'ana' }],
          },
          {
            oid: '2222222222222222',
            messageHeadline: 'Vendor bump',
            committedDate: '2026-08-04T10:00:00Z',
            authors: [{ name: 'Release Bot', login: '' }],
          },
          { messageHeadline: 'no oid, dropped' },
        ],
      }),
    });
  };
  const result = await viewPr('/repo', { prNumber: 12 }, runGh);
  assert.deepEqual(result.pr.commits, [
    {
      oid: '1111111111111111',
      headline: 'Add the inbox',
      committedDate: '2026-08-04T09:00:00Z',
      author: 'ana',
    },
    {
      oid: '2222222222222222',
      headline: 'Vendor bump',
      committedDate: '2026-08-04T10:00:00Z',
      author: 'Release Bot',
    },
  ]);
});

test('mergePr requires a known strategy and a bare PR number before spawning gh', async () => {
  let spawned = false;
  const runGh = async () => {
    spawned = true;
    return ghResult();
  };
  const badSelector = await mergePr('/repo', { prNumber: '--repo=evil', method: 'squash' }, runGh);
  assert.deepEqual(badSelector, { ok: false, reason: 'missing_pr' });
  const badMethod = await mergePr('/repo', { prNumber: 12, method: 'fast-forward' }, runGh);
  assert.deepEqual(badMethod, { ok: false, reason: 'invalid_method' });
  const noMethod = await mergePr('/repo', { prNumber: 12 }, runGh);
  assert.deepEqual(noMethod, { ok: false, reason: 'invalid_method' });
  assert.equal(spawned, false);
});

test('mergePr rejects inherited Object.prototype names as merge strategies', async () => {
  let spawned = false;
  const runGh = async () => {
    spawned = true;
    return ghResult();
  };
  for (const method of ['toString', 'constructor', 'hasOwnProperty', '__proto__']) {
    assert.deepEqual(
      await mergePr('/repo', { prNumber: 12, method }, runGh),
      { ok: false, reason: 'invalid_method' },
      `${method} must not resolve to a merge flag`,
    );
  }
  assert.equal(spawned, false);
});

test('mergePr passes the chosen strategy to gh and reports its refusal', async () => {
  const calls = [];
  const ok = await mergePr('/repo', { prNumber: 12, method: 'squash' }, async (_cwd, args) => {
    calls.push(args);
    return ghResult();
  });
  assert.deepEqual(ok, { ok: true });
  assert.deepEqual(calls[0], ['pr', 'merge', '--squash', '--', '12']);

  const refused = await mergePr('/repo', { prNumber: 12, method: 'rebase' }, async () =>
    ghResult({ code: 1, stderr: 'Pull request is not mergeable\n' }),
  );
  assert.deepEqual(refused, {
    ok: false,
    reason: 'gh_error',
    message: 'Pull request is not mergeable',
  });

  const missingGh = await mergePr('/repo', { prNumber: 12, method: 'merge' }, async () =>
    ghResult({ code: 1, spawnFailed: true }),
  );
  assert.deepEqual(missingGh, { ok: false, reason: 'gh_unavailable' });
});

test('prDiff rejects a non-integer selector and returns patch text on success', async () => {
  const bad = await prDiff('/repo', { prNumber: '--repo=evil' }, async () => ghResult());
  assert.equal(bad.ok, false);
  assert.equal(bad.diff, '');
  const good = await prDiff('/repo', { prNumber: 12 }, async (_cwd, args) => {
    assert.deepEqual(args.slice(-2), ['--', '12']);
    return ghResult({ stdout: 'diff --git a/a.ts b/a.ts\n' });
  });
  assert.equal(good.ok, true);
  assert.match(good.diff, /diff --git/);
});
