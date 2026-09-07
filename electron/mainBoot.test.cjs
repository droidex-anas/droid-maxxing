const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { SENTINEL } = require('./mainBootEval.cjs');

test('main.cjs evaluates under a stubbed electron without throwing', () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, 'mainBootEval.cjs')], {
    encoding: 'utf8',
    timeout: 15_000,
    env: {
      ...process.env,
      SENTRY_DSN: '',
      ELECTRON_START_URL: '',
      SIDECAR_ENTRY: '',
    },
  });

  assert.equal(
    result.status,
    0,
    `main.cjs failed during module evaluation\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  assert.match(result.stdout, new RegExp(`^${SENTINEL}$`, 'm'));
  assert.doesNotMatch(result.stderr, /ReferenceError|before initialization/);
});

for (const profile of ['blank', 'fresh', 'padded']) {
  test(`main startup handles a ${profile} profile override before app.setPath`, () => {
    const result = spawnSync(
      process.execPath,
      [path.join(__dirname, 'mainBootEval.cjs'), profile],
      {
        encoding: 'utf8',
        timeout: 15_000,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`^${SENTINEL}$`, 'm'));
  });
}

test('main rejects a relative profile override before creating it', () => {
  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, 'mainBootEval.cjs'), 'relative'],
    {
      encoding: 'utf8',
      timeout: 15_000,
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /DROIDEX_USER_DATA_DIR must be an absolute path/);
});

test('main reports an actionable profile directory creation failure', () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, 'mainBootEval.cjs'), 'file'], {
    encoding: 'utf8',
    timeout: 15_000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Cannot create the DROIDEX profile directory/);
  assert.match(result.stderr, /DROIDEX_USER_DATA_DIR to a writable absolute directory/);
});
