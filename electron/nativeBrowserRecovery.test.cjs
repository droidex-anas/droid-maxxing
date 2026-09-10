const test = require('node:test');
const assert = require('node:assert/strict');
const { createNativeBrowserRecovery } = require('./nativeBrowserRecovery.cjs');

function fixture(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(console, 'error', () => {});
  const view = { getBounds: () => ({ width: 800, height: 600 }) };
  const entry = {
    browserSessionId: 'browser-1',
    view,
    targetUrl: 'https://example.test/',
    rendererCrashes: [],
  };
  const mounted = [],
    loads = [];
  let registered = entry;
  let revision = 1;
  const recovery = createNativeBrowserRecovery({
    budget: { isEvictionClose: (reason) => reason === 'evict' },
    urls: { restorableUrlForEntry: (_entry, url) => url },
    findEntry: () => registered,
    closeEntry: (current) => {
      recovery.cancel(current);
      current.view = null;
    },
    ensureView: () => {
      entry.view = view;
    },
    loadUrl: (_entry, url) => {
      loads.push(url);
      return Promise.resolve({ ok: true });
    },
    reportFailure: () => {},
    getAttachmentRevision: () => revision,
    hostIsUsable: () => true,
    mountRecovered: (_entry, _bounds, capturedRevision) => mounted.push(capturedRevision),
  });
  return {
    recovery,
    entry,
    view,
    mounted,
    loads,
    unregister: () => {
      registered = null;
    },
    switchPane: () => {
      revision += 1;
    },
  };
}

test('renderer retry retains its original layout lease across a pane switch', (t) => {
  const f = fixture(t);
  f.recovery.recover(f.entry, f.view, { reason: 'crashed' });
  f.switchPane();
  t.mock.timers.tick(250);
  assert.deepEqual(f.mounted, [1]);
  assert.deepEqual(f.loads, ['https://example.test/']);
});

for (const action of ['cancel', 'unregister']) {
  test(`renderer retry does not recreate a session after ${action}`, (t) => {
    const f = fixture(t);
    f.recovery.recover(f.entry, f.view, { reason: 'crashed' });
    if (action === 'cancel') f.recovery.cancel(f.entry);
    else f.unregister();
    t.mock.timers.tick(250);
    assert.deepEqual(f.mounted, []);
    assert.deepEqual(f.loads, []);
  });
}

test('renderer crash loop stops after three crashes within the window', (t) => {
  const f = fixture(t);
  for (let count = 0; count < 3; count += 1) {
    f.recovery.recover(f.entry, f.view, { reason: 'crashed' });
    t.mock.timers.tick(250);
  }
  assert.equal(f.mounted.length, 2);
  assert.equal(f.entry.view, null);
});
