const test = require('node:test');
const assert = require('node:assert/strict');
const { createNativeBrowserLayout } = require('./nativeBrowserLayout.cjs');

function fixture(restoreSnapshot = async () => {}) {
  const mainWindow = { isDestroyed: () => false, webContents: { isDestroyed: () => false } };
  const mounted = [];
  const cursorCalls = [];
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
      agentCursorActive: false,
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
    cursor: {
      attach: ({ browserSessionId }) => cursorCalls.push(['attach', browserSessionId]),
      detach: (id) => cursorCalls.push(['detach', id]),
      forget: (id) => cursorCalls.push(['forget', id]),
      setBounds: () => {},
    },
    applyDesignState: () => {},
    loadUrl: () => assert.fail('unexpected navigation'),
    requireLoaded: () => {},
  });
  return { layout, entries, mounted, cursorCalls };
}

test('an idle browser stays attached without presenting an agent cursor', async () => {
  const f = fixture();
  await f.layout.attach('first', { width: 800, height: 600 });
  assert.equal(f.entries.get('first').attached, true);
  assert.deepEqual(f.cursorCalls, []);
});

test('ending a run hides its cursor without hiding the browser page', async () => {
  const f = fixture();
  await f.layout.attach('first', { width: 800, height: 600 });
  f.cursorCalls.length = 0;
  f.layout.setVisible('first', true, true);
  f.layout.setVisible('first', true, false);
  assert.deepEqual(f.cursorCalls, [
    ['attach', 'first'],
    ['detach', 'first'],
  ]);
  assert.equal(f.entries.get('first').attached, true);
  assert.equal(f.entries.get('first').visible, true);
});

test('a stopped run cannot regain its cursor when a pending attach finishes', async () => {
  let finish;
  const f = fixture(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  f.entries.get('first').serialized = {};
  f.layout.setVisible('first', true, true);
  const pending = f.layout.attach('first', { width: 800, height: 600 });
  f.layout.setVisible('first', true, false);
  finish();
  await pending;
  assert.deepEqual(f.cursorCalls, [['detach', 'first']]);
  assert.equal(f.entries.get('first').attached, true);
});

test('recovery and overlay dismissal do not restore the cursor of a stopped run', async () => {
  const f = fixture();
  const bounds = { width: 800, height: 600 };
  await f.layout.attach('first', bounds);
  f.layout.setVisible('first', true, true);
  f.layout.setVisible('first', false, false);
  f.cursorCalls.length = 0;
  f.layout.mountRecovered(f.entries.get('first'), bounds, f.layout.revision());
  f.layout.setVisible('first', true, false);
  assert.deepEqual(f.cursorCalls, [['detach', 'first']]);
});

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
