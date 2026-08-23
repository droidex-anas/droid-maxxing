const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { reserveDownloadPath } = require('./browserDownloads.cjs');

test('download paths are sanitized and reserved across concurrent downloads', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'droidex-download-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const reserved = new Set();

  const first = reserveDownloadPath(directory, 'report<>:"/\\|?*.pdf. ', reserved);
  const second = reserveDownloadPath(directory, path.basename(first), reserved);

  assert.equal(path.dirname(first), directory);
  assert.doesNotMatch(path.basename(first), /[<>:"/\\|?*]|[. ]$/);
  assert.notEqual(first, second);
  assert.match(path.basename(second), / 2\.pdf$/);
});
