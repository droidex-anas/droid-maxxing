import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { droidexHistoryDir, droidexUserDataDir } from './droidexPaths.js';

const originalUserData = process.env.DROIDEX_USER_DATA_DIR;
const originalState = process.env.DROIDEX_HISTORY_DIR;

function restoreEnv(): void {
  restore('DROIDEX_USER_DATA_DIR', originalUserData);
  restore('DROIDEX_HISTORY_DIR', originalState);
}

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test.afterEach(restoreEnv);
test.after(restoreEnv);

test('droidexHistoryDir treats blank DROIDEX_HISTORY_DIR as unset', () => {
  delete process.env.DROIDEX_HISTORY_DIR;
  assert.equal(droidexHistoryDir(), join(homedir(), '.factory', 'droidex'));

  process.env.DROIDEX_HISTORY_DIR = '';
  assert.equal(droidexHistoryDir(), join(homedir(), '.factory', 'droidex'));

  process.env.DROIDEX_HISTORY_DIR = '   ';
  assert.equal(droidexHistoryDir(), join(homedir(), '.factory', 'droidex'));

  process.env.DROIDEX_HISTORY_DIR = '/tmp/isolated-state';
  assert.equal(droidexHistoryDir(), '/tmp/isolated-state');
});

test('droidexUserDataDir treats blank DROIDEX_USER_DATA_DIR as unset', () => {
  delete process.env.DROIDEX_USER_DATA_DIR;
  assert.equal(droidexUserDataDir(), join(homedir(), 'Library', 'Application Support', 'DROIDEX'));

  process.env.DROIDEX_USER_DATA_DIR = '';
  assert.equal(droidexUserDataDir(), join(homedir(), 'Library', 'Application Support', 'DROIDEX'));

  process.env.DROIDEX_USER_DATA_DIR = '/tmp/isolated-profile';
  assert.equal(droidexUserDataDir(), '/tmp/isolated-profile');
});
