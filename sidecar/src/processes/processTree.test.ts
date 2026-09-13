import assert from 'node:assert/strict';
import test from 'node:test';
import { descendantsOf, parseElapsedSeconds, parsePsTable } from './processTree.js';

// `etime` values are real macOS `ps` shapes: mm:ss, hh:mm:ss, and one
// multi-day dd-hh:mm:ss.
const TABLE = [
  '    1     0 21:12:36 /sbin/launchd',
  '  500     1 05:12 /Applications/DROIDEX.app/Contents/MacOS/DROIDEX',
  '  600   500 1-02:03:04 /usr/local/bin/droid exec --input-format stream-jsonrpc',
  '  700   600 00:45:10 /bin/zsh -c npm run dev',
  '  800   700 11:40 node /w/node_modules/.bin/vite',
  '  900     1 15:00 unrelated',
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

test('parseElapsedSeconds parses mm:ss, hh:mm:ss and dd-hh:mm:ss', () => {
  assert.equal(parseElapsedSeconds('11:40'), 700);
  assert.equal(parseElapsedSeconds('21:12:36'), 76_356);
  assert.equal(parseElapsedSeconds('1-02:03:04'), 93_784);
});

test('parseElapsedSeconds returns null for unparseable input', () => {
  assert.equal(parseElapsedSeconds('not-a-time'), null);
});
