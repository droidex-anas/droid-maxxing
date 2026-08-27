const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, readFile, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const {
  HARDWARE_ACCELERATION_DEFAULT,
  loadHardwareAccelerationPreference,
  parseHardwareAccelerationPreference,
  preferenceFilePath,
  readHardwareAccelerationPreferenceSync,
  resolveUserDataDir,
  saveHardwareAccelerationPreference,
} = require('./hardwareAcceleration.cjs');

test('missing preference defaults to hardware acceleration enabled', () => {
  assert.deepEqual(
    readHardwareAccelerationPreferenceSync({
      filePath: '/tmp/missing-hardware-acceleration.json',
      fs: {
        readFileSync() {
          const error = new Error('missing');
          error.code = 'ENOENT';
          throw error;
        },
      },
    }),
    { enabled: HARDWARE_ACCELERATION_DEFAULT },
  );
});

test('empty or malformed preference files fall back to enabled without throwing', () => {
  const cases = ['', '   ', '{broken', '{"version":2,"enabled":false}', '{"enabled":true}'];
  for (const raw of cases) {
    assert.deepEqual(
      readHardwareAccelerationPreferenceSync({
        filePath: '/tmp/invalid-hardware-acceleration.json',
        fs: { readFileSync: () => raw },
      }),
      { enabled: true },
    );
  }
  assert.equal(
    parseHardwareAccelerationPreference('{"version":1,"enabled":false}')?.enabled,
    false,
  );
});

test('startup read disables acceleration only when the persisted preference says so', () => {
  const enabled = readHardwareAccelerationPreferenceSync({
    filePath: '/tmp/enabled.json',
    fs: {
      readFileSync: () => JSON.stringify({ version: 1, enabled: true }),
    },
  });
  const disabled = readHardwareAccelerationPreferenceSync({
    filePath: '/tmp/disabled.json',
    fs: {
      readFileSync: () => JSON.stringify({ version: 1, enabled: false }),
    },
  });

  assert.deepEqual(enabled, { enabled: true });
  assert.deepEqual(disabled, { enabled: false });
});

test('settings writes round-trip through the same reader main uses at startup', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'droidex-hardware-acceleration-'));
  const filePath = preferenceFilePath(dir);
  const fs = require('node:fs/promises');

  await saveHardwareAccelerationPreference({ filePath, enabled: false, fs });
  assert.deepEqual(await loadHardwareAccelerationPreference({ filePath, fs }), { enabled: false });
  assert.deepEqual(readHardwareAccelerationPreferenceSync({ filePath }), { enabled: false });

  await saveHardwareAccelerationPreference({ filePath, enabled: true, fs });
  const raw = await readFile(filePath, 'utf8');
  assert.deepEqual(JSON.parse(raw), { version: 1, enabled: true });
  assert.deepEqual(readHardwareAccelerationPreferenceSync({ filePath }), { enabled: true });
});

test('resolveUserDataDir honors DROIDEX_USER_DATA_DIR', () => {
  assert.equal(
    resolveUserDataDir({
      app: { getPath: () => '/Users/me/Library/Application Support' },
      env: { DROIDEX_USER_DATA_DIR: '/custom/profile' },
    }),
    '/custom/profile',
  );
  assert.equal(
    resolveUserDataDir({
      app: { getPath: () => '/Users/me/Library/Application Support' },
      env: {},
    }),
    path.join('/Users/me/Library/Application Support', 'DROIDEX'),
  );
});

test('invalid async preference loads fail closed for settings IPC', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'droidex-hardware-acceleration-invalid-'));
  const filePath = preferenceFilePath(dir);
  await writeFile(filePath, '{broken', 'utf8');

  await assert.rejects(
    () => loadHardwareAccelerationPreference({ filePath, fs: require('node:fs/promises') }),
    /invalid/i,
  );
});
