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

test('download reservations collide case-insensitively', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'droidex-download-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const reserved = new Set();

  reserveDownloadPath(directory, 'Report.pdf', reserved);
  const second = reserveDownloadPath(directory, 'report.pdf', reserved);

  assert.equal(path.basename(second), 'report 2.pdf');
});

test('download filenames stay within the UTF-8 component limit with a collision suffix', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'droidex-download-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const reserved = new Set();
  const filename = `${'🚀'.repeat(100)}.txt`;

  const firstName = path.basename(reserveDownloadPath(directory, filename, reserved));
  const secondName = path.basename(reserveDownloadPath(directory, filename, reserved));

  assert.ok(Buffer.byteLength(firstName, 'utf8') <= 255);
  assert.ok(Buffer.byteLength(secondName, 'utf8') <= 255);
  assert.equal(Buffer.from(firstName, 'utf8').toString('utf8'), firstName);
  assert.match(secondName, / 2\.txt$/);
});
