import assert from 'node:assert/strict';
import test from 'node:test';
import { descendantsOf, parsePsTable } from './processTree.js';

const TABLE = [
  '    1     0     0 /sbin/launchd',
  '  500     1   500 /Applications/DROIDEX.app/Contents/MacOS/DROIDEX',
  '  600   500   600 /usr/local/bin/droid exec --input-format stream-jsonrpc',
  '  700   600   700 /bin/zsh -c npm run dev',
  '  800   700   700 node /w/node_modules/.bin/vite',
  '  900     1   900 unrelated',
].join('\n');

test('parsePsTable reads pid, ppid, elapsed seconds and command', () => {
  const rows = parsePsTable(TABLE, 10_000);
  assert.equal(rows.length, 6);
  assert.deepEqual(rows[4], {
    pid: 800,
    ppid: 700,
    startedAt: 10_000 - 700 * 1000,
    command: 'node /w/node_modules/.bin/vite',
  });
});

test('descendantsOf walks the tree under the roots only', () => {
  const rows = parsePsTable(TABLE, 10_000);
  assert.deepEqual(
    descendantsOf(rows, [600]).map((r) => r.pid),
    [700, 800],
  );
  assert.deepEqual(descendantsOf(rows, [999]), []);
});
