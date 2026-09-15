const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createCaptureStore, MAX_RECORDS } = require('./store.cjs');
const {
  DEFAULT_PREFERENCES,
  decodePng,
  id: validateId,
  png: validatePng,
  preferences: validatePreferences,
  rect: validateRect,
  style: validateStyle,
} = require('./validation.cjs');
const { captureArguments, runCapture, captureComponent } = require('./native.cjs');
const { assertCaptureSender } = require('./service.cjs');

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH1sAAAAASUVORK5CYII=',
  'base64',
);
const bare = { preset: 'transparent', padding: 0, radius: 0, shadow: 0, texture: 0 };
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'capture-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return { dir, store: createCaptureStore(path.join(dir, 'captures')) };
}
test('PNG intake rejects unsupported MIME, malformed geometry and decompression-sized images', () => {
  assert.deepEqual(validatePng(PNG), { width: 1, height: 1 });
  assert.throws(() => decodePng('data:image/jpeg;base64,AA=='));
  assert.throws(() => validateRect({ x: -1, y: 0, width: 1, height: 1 }, 5, 5));
  assert.throws(() => validateRect({ x: 4, y: 0, width: 2, height: 1 }, 5, 5));
  assert.throws(() => validateRect({ x: NaN, y: 0, width: 1, height: 1 }, 5, 5));
  const bomb = Buffer.from(PNG);
  bomb.writeUInt32BE(100000, 16);
  assert.throws(() => validatePng(bomb), /limit/);
  assert.throws(() => validateId('../outside'));
  assert.throws(() => validateStyle({ ...bare, padding: Infinity }));
});
test('original bytes survive multiple edits and later default changes', async (t) => {
  const { store } = await fixture(t);
  const created = await store.create(PNG, 'Sidebar');
  assert.equal(created.recipe.style.preset, 'ember');
  const prefs = await store.preferences();
  await store.setPreferences({ ...prefs, style: { ...bare, preset: 'pearl' } });
  const reopened = await store.read(created.id);
  assert.equal(reopened.recipe.style.preset, 'ember');
  assert.equal(reopened.source, `data:image/png;base64,${PNG.toString('base64')}`);
  const recipe = { version: 1, crop: { x: 0, y: 0, width: 1, height: 1 }, style: bare };
  const saved = await store.save(created.id, 0, recipe, PNG, PNG);
  assert.equal(saved.revision, 1);
  assert.deepEqual((await store.output(created.id)).buffer, PNG);
  assert.equal((await store.read(created.id)).source, reopened.source);
  assert.equal((await store.preferences()).style.preset, 'pearl');
  assert.equal((await store.create(PNG, 'Next')).recipe.style.preset, 'pearl');
});
test('concurrent editors cannot overwrite a newer revision or use a thumbnail as export', async (t) => {
  const { store } = await fixture(t);
  const record = await store.create(PNG, 'One');
  const recipe = { version: 1, crop: { x: 0, y: 0, width: 1, height: 1 }, style: bare };
  await store.save(record.id, 0, recipe, PNG, PNG);
  await assert.rejects(store.save(record.id, 0, recipe, PNG, PNG), /another editor/);
  await assert.rejects(
    store.save(record.id, 1, { ...recipe, style: { ...bare, padding: 30 } }, PNG, PNG),
    /dimensions/,
  );
  assert.equal((await store.read(record.id)).revision, 1);
});
test('history persists across store instances and deletion removes originals and edits', async (t) => {
  const { store, dir } = await fixture(t);
  const record = await store.create(PNG, 'Saved');
  const restarted = createCaptureStore(path.join(dir, 'captures'));
  assert.equal((await restarted.list())[0].id, record.id);
  await assert.rejects(restarted.output(record.id), /save this capture/);
  await restarted.delete(record.id);
  assert.equal((await store.list()).length, 0);
  await assert.rejects(store.read(record.id), /ENOENT/);
});
test('serialized concurrent captures keep the bounded history within its count limit', async (t) => {
  const { store } = await fixture(t);
  await Promise.all(
    Array.from({ length: MAX_RECORDS + 4 }, (_, i) => store.create(PNG, `Capture ${i}`)),
  );
  assert.equal((await store.list()).length, MAX_RECORDS);
});
test('capture storage rejects symlink roots and symlinked originals', async (t) => {
  const { dir, store } = await fixture(t);
  const target = path.join(dir, 'other');
  await fs.mkdir(target);
  const linked = path.join(dir, 'linked');
  await fs.symlink(target, linked);
  await assert.rejects(createCaptureStore(linked).list(), /private directory/);
  const record = await store.create(PNG, 'Private');
  const source = path.join(dir, 'captures', `${record.id}.source.png`);
  await fs.rm(source);
  await fs.writeFile(path.join(target, 'outside.png'), PNG);
  await fs.symlink(path.join(target, 'outside.png'), source);
  await assert.rejects(store.read(record.id), /Unsafe capture file/);
});
test('capture IPC rejects subframes, embedded browsers and absent windows', () => {
  const frame = {};
  const contents = { mainFrame: frame };
  const window = { isDestroyed: () => false, webContents: contents };
  assert.doesNotThrow(() => assertCaptureSender({ sender: contents, senderFrame: frame }, window));
  assert.throws(() => assertCaptureSender({ sender: contents, senderFrame: {} }, window));
  assert.throws(() => assertCaptureSender({ sender: {}, senderFrame: frame }, window));
  assert.throws(() => assertCaptureSender({}, null));
});
test('native capture uses argument arrays, suppresses native sound, and does not write clipboard', () => {
  assert.deepEqual(captureArguments('area', '/tmp/capture.png'), [
    '-x',
    '-i',
    '-s',
    '-t',
    'png',
    '/tmp/capture.png',
  ]);
  assert.ok(captureArguments('window', '/tmp/capture.png').includes('-w'));
  assert.ok(captureArguments('screen', '/tmp/capture.png').includes('-m'));
  assert.ok(!captureArguments('area', '/tmp/capture.png').includes('-c'));
  assert.throws(() => captureArguments('shell', 'x'));
});
test('native cancellation resolves without a result and failure stays observable', async () => {
  const controller = new AbortController();
  const cancelled = await runCapture([], controller.signal, (command, args, options, callback) => {
    assert.equal(command, '/usr/sbin/screencapture');
    assert.equal(options.signal, controller.signal);
    assert.equal(options.timeout, 180000);
    controller.abort();
    callback(new Error('Aborted'));
  });
  assert.equal(cancelled, false);
  await assert.rejects(
    runCapture([], new AbortController().signal, (_command, _args, _options, callback) =>
      callback(new Error('Permission denied')),
    ),
    /Permission denied/,
  );
});
test('component capture converts CSS bounds through zoom and exports the highest density', async () => {
  let box;
  let density;
  const contents = {
    executeJavaScript: async () => ({ width: 500, height: 300 }),
    getZoomFactor: () => 1.5,
    capturePage: async (rect) => {
      box = rect;
      return {
        isEmpty: () => false,
        getScaleFactors: () => [1, 2],
        toPNG: (options) => {
          density = options.scaleFactor;
          return PNG;
        },
      };
    },
  };
  await captureComponent(contents, { x: 10, y: 20, width: 100, height: 80 });
  assert.deepEqual(box, { x: 15, y: 30, width: 150, height: 120 });
  assert.equal(density, 2);
  await assert.rejects(
    captureComponent(contents, { x: 499, y: 0, width: 10, height: 10 }),
    /outside/,
  );
});
test('preference schema rejects unrecognized shortcuts and IDs never become paths', () => {
  assert.throws(() => validatePreferences({ ...DEFAULT_PREFERENCES, shortcut: 'Command+Q;rm' }));
  assert.equal(validateId(randomUUID()).length, 36);
});
