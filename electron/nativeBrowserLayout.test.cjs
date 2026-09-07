const test = require('node:test');
const assert = require('node:assert/strict');
const { createNativeBrowserLayout } = require('./nativeBrowserLayout.cjs');

function fixture(restoreSnapshot = async () => {}) {
  const mainWindow = { isDestroyed: () => false, webContents: { isDestroyed: () => false } };
  const mounted = [];
  const entries = new Map();
  for (const id of ['first', 'second']) {
    const view = {
      webContents: {
        isDestroyed: () => false,
        getURL: () => 'https://example.test/',
        setBackgroundThrottling: () => {},
      },
      setBounds: (bounds) => {
        view.bounds = bounds;
      },
      getBounds: () => view.bounds,
      setVisible: () => {},
    };
    entries.set(id, {
      browserSessionId: id,
      view,
      attached: false,
      visible: true,
      state: {},
      viewport: {},
    });
  }
  const layout = createNativeBrowserLayout({
    appName: 'DROIDEX',
    getMainWindow: () => mainWindow,
    findEntry: (id) => entries.get(id),
    ensureEntry: (id) => entries.get(id),
    ensureView: (id) => entries.get(id),
    restoreSnapshot,
    viewHost: {
      attachToMainWindow: (entry) => mounted.push(entry.browserSessionId),
      removeView: () => {},
      setHiddenBounds: () => {},
      addHiddenView: () => {},
    },
    eviction: { touch: () => {}, schedule: () => {} },
    urls: {
      normalizeNativeBrowserSessionId: (id) => id,
      normalizeBounds: (bounds) => bounds,
      restorableUrlForEntry: () => undefined,
    },
    cursor: { attach: () => {}, detach: () => {}, setBounds: () => {} },
    applyDesignState: () => {},
    loadUrl: () => assert.fail('unexpected navigation'),
    requireLoaded: () => {},
  });
  return { layout, entries, mounted };
}

test('pending page restore cannot attach after switching to another pane', async () => {
  let resolve;
  const f = fixture(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  f.entries.get('first').serialized = {};
  const pending = f.layout.attach('first', { width: 800, height: 600 });
  await f.layout.attach('second', { width: 800, height: 600 });
  resolve();
  await pending;
  assert.deepEqual(f.mounted, ['second']);
  assert.equal(f.entries.get('first').attached, false);
});

test('detach invalidates an attachment even before its restore completes', async () => {
  let resolve;
  const f = fixture(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  f.entries.get('first').serialized = {};
  const pending = f.layout.attach('first', { width: 800, height: 600 });
  f.layout.detach('first');
  resolve();
  await pending;
  assert.deepEqual(f.mounted, []);
});

test('recovered background view cannot reclaim a changed layout lease', async () => {
  const f = fixture();
  await f.layout.attach('first', { width: 800, height: 600 });
  const revision = f.layout.revision();
  await f.layout.attach('second', { width: 800, height: 600 });
  f.layout.mountRecovered(f.entries.get('first'), { width: 800, height: 600 }, revision);
  assert.deepEqual(f.mounted, ['first', 'second']);
  assert.equal(f.entries.get('first').attached, false);
  assert.equal(f.entries.get('second').attached, true);
});

test('recovered attached view uses bounds updated during the recovery delay', async () => {
  const f = fixture();
  const initialBounds = { x: 0, y: 0, width: 800, height: 600 };
  const latestBounds = { x: 20, y: 30, width: 960, height: 720 };
  await f.layout.attach('first', initialBounds);
  const revision = f.layout.revision();
  const entry = f.entries.get('first');
  const replacementView = entry.view;

  entry.view = null;
  entry.attached = false;
  f.layout.release(entry);
  f.layout.setBounds('first', latestBounds);
  entry.view = replacementView;
  f.layout.mountRecovered(entry, initialBounds, revision);

  assert.deepEqual(entry.view.getBounds(), latestBounds);
});
