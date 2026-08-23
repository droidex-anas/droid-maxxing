const test = require('node:test');
const assert = require('node:assert/strict');
const {
  attachChildView,
  closeBrowserRegistry,
  detachChildView,
  disposeBrowserEntryView,
  setBrowserActionActive,
  setBrowserViewBoundsIfChanged,
  suspendBrowserRegistry,
  createNativeBrowserHostController,
} = require('./nativeBrowserHost.cjs');

function createHost() {
  const calls = [];
  return {
    calls,
    isDestroyed: () => false,
    contentView: {
      addChildView: (view) => calls.push(['add', view]),
      removeChildView: (view) => calls.push(['remove', view]),
    },
  };
}

test('attaching a browser view to its current host is idempotent', () => {
  const host = createHost();
  const view = {};
  const entry = { view, windowAttached: false, hostWindow: null };

  assert.equal(attachChildView(entry, host), true);
  assert.equal(attachChildView(entry, host), false);
  assert.deepEqual(host.calls, [['add', view]]);
});

test('moving a browser view removes it from the previous host first', () => {
  const firstHost = createHost();
  const secondHost = createHost();
  const view = {};
  const entry = { view, windowAttached: false, hostWindow: null };

  attachChildView(entry, firstHost);
  attachChildView(entry, secondHost);

  assert.deepEqual(firstHost.calls, [
    ['add', view],
    ['remove', view],
  ]);
  assert.deepEqual(secondHost.calls, [['add', view]]);
  assert.equal(entry.hostWindow, secondHost);
});

test('detaching a browser view clears ownership even when its host is gone', () => {
  const entry = {
    view: {},
    windowAttached: true,
    hostWindow: { isDestroyed: () => true },
  };

  assert.equal(detachChildView(entry), true);
  assert.equal(entry.windowAttached, false);
  assert.equal(entry.hostWindow, null);
});

test('suspending browser views preserves registry ownership for later restoration', () => {
  const first = { browserSessionId: 'browser-1' };
  const second = { browserSessionId: 'browser-2' };
  const registry = new Map([
    [first.browserSessionId, first],
    [second.browserSessionId, second],
  ]);
  const closed = [];

  suspendBrowserRegistry(registry, (entry, forget) => closed.push([entry, forget]));

  assert.deepEqual(closed, [
    [first, false],
    [second, false],
  ]);
  assert.equal(registry.get('browser-1'), first);
  assert.equal(registry.get('browser-2'), second);
});

test('closing all browser views forgets every registry entry', () => {
  const entry = { browserSessionId: 'browser-1' };
  const registry = new Map([[entry.browserSessionId, entry]]);
  const closed = [];

  closeBrowserRegistry(registry, (value, forget) => closed.push([value, forget]));

  assert.deepEqual(closed, [[entry, true]]);
  assert.equal(registry.size, 0);
});

test('disposing a browser view revokes permissions before ownership is cleared and contents close', () => {
  const events = [];
  const contents = {
    isDestroyed: () => false,
    close: () => events.push(['close']),
  };
  const view = { webContents: contents };
  const entry = {
    browserSessionId: 'browser-1',
    view,
    attached: true,
    windowAttached: true,
    hostWindow: createHost(),
  };

  disposeBrowserEntryView(entry, {
    detachCursor: () => events.push(['cursor']),
    removeView: (_entry, removedView) => events.push(['remove', removedView]),
    revokePermissions: (revokedContents) => {
      events.push(['revoke', revokedContents, entry.view]);
    },
  });

  assert.deepEqual(events, [['cursor'], ['revoke', contents, view], ['remove', view], ['close']]);
  assert.equal(entry.view, null);
  assert.equal(entry.attached, false);
});

test('equal browser bounds do not trigger a native view rebound', () => {
  const calls = [];
  const view = {
    getBounds: () => ({ x: 10, y: 20, width: 800, height: 600 }),
    setBounds: (bounds) => calls.push(bounds),
  };

  assert.equal(
    setBrowserViewBoundsIfChanged(view, { x: 10, y: 20, width: 800, height: 600 }),
    false,
  );
  assert.deepEqual(calls, []);
  assert.equal(
    setBrowserViewBoundsIfChanged(view, { x: 12, y: 20, width: 800, height: 600 }),
    true,
  );
  assert.deepEqual(calls, [{ x: 12, y: 20, width: 800, height: 600 }]);
});

test('hidden browser actions unthrottle only while active and visible browsers stay unthrottled', () => {
  const hiddenThrottling = [];
  const hidden = {
    attached: false,
    visible: true,
    view: {
      webContents: {
        isDestroyed: () => false,
        setBackgroundThrottling: (value) => hiddenThrottling.push(value),
      },
    },
  };
  setBrowserActionActive(hidden, true);
  setBrowserActionActive(hidden, false);
  assert.deepEqual(hiddenThrottling, [false, true]);

  const visibleThrottling = [];
  const visible = {
    attached: true,
    visible: true,
    view: {
      webContents: {
        isDestroyed: () => false,
        setBackgroundThrottling: (value) => visibleThrottling.push(value),
      },
    },
  };
  setBrowserActionActive(visible, true);
  setBrowserActionActive(visible, false);
  assert.deepEqual(visibleThrottling, [false, false]);
});

test('host controller owns attachment moves and preserves hidden session entries', () => {
  const main = createHost();
  const hidden = createHost();
  const detachedCursors = [];
  hidden.setContentSize = () => {};
  hidden.close = () => hidden.calls.push(['close']);
  hidden.on = () => {};
  const controller = createNativeBrowserHostController({
    idleMs: 0,
    getMainWindow: () => main,
    isViewUsable: Boolean,
    createHiddenWindow: () => hidden,
    detachCursor: (browserSessionId) => detachedCursors.push(browserSessionId),
  });
  const view = {
    setVisible: () => {},
    setBounds: () => {},
    getBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
    webContents: {
      isDestroyed: () => false,
      setBackgroundThrottling: () => {},
      close: () => {},
    },
  };
  const entry = controller.ensureEntry('browser-1', (browserSessionId) => ({
    browserSessionId,
    view,
    visible: true,
    attached: false,
    windowAttached: false,
    hostWindow: null,
    idleTimer: null,
    viewport: { width: 800, height: 600 },
  }));

  assert.equal(controller.attachToMain(entry), true);
  assert.equal(controller.getAttachedSessionId(), 'browser-1');
  controller.detach('browser-1');
  assert.equal(controller.getAttachedSessionId(), null);
  assert.equal(controller.getEntry('browser-1'), entry);
  assert.equal(entry.hostWindow, hidden);
  assert.equal(entry.attached, false);
  assert.deepEqual(detachedCursors, ['browser-1']);
});

test('host controller suspend disposes views but retains entries and close forgets them', () => {
  const closed = [];
  const cursorEvents = [];
  const hidden = createHost();
  hidden.setContentSize = () => {};
  hidden.close = () => {};
  hidden.on = () => {};
  const controller = createNativeBrowserHostController({
    idleMs: 0,
    getMainWindow: createHost,
    isViewUsable: Boolean,
    createHiddenWindow: () => hidden,
    detachCursor: (browserSessionId) => cursorEvents.push(['detach', browserSessionId]),
    forgetCursor: (browserSessionId) => cursorEvents.push(['forget', browserSessionId]),
    revokePermissions: () => closed.push('revoke'),
  });
  const makeEntry = (browserSessionId) => ({
    browserSessionId,
    view: {
      webContents: {
        isDestroyed: () => false,
        close: () => closed.push('close'),
      },
    },
    attached: false,
    windowAttached: false,
    hostWindow: null,
    idleTimer: null,
  });
  controller.ensureEntry('browser-1', makeEntry);
  controller.suspendAll();
  assert.equal(controller.hasEntry('browser-1'), true);
  assert.equal(controller.getEntry('browser-1').view, null);
  assert.deepEqual(closed, ['revoke', 'close']);
  assert.deepEqual(cursorEvents, [['detach', 'browser-1']]);

  controller.closeAll();
  assert.equal(controller.hasEntry('browser-1'), false);
  assert.deepEqual(cursorEvents, [
    ['detach', 'browser-1'],
    ['forget', 'browser-1'],
  ]);
});
