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
