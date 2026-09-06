const test = require('node:test');
const assert = require('node:assert/strict');
const {
  attachChildView,
  createNativeBrowserViewHost,
  detachChildView,
  isBrowserViewUsable,
  safeWebContents,
  setBrowserActionActive,
  setBrowserViewBoundsIfChanged,
} = require('./nativeBrowserHost.cjs');

function createWindow() {
  const listeners = new Map();
  const children = [];
  return {
    children,
    closed: 0,
    contentSizes: [],
    destroyed: false,
    contentView: {
      addChildView(view) {
        children.push(view);
      },
      removeChildView(view) {
        const index = children.indexOf(view);
        if (index >= 0) children.splice(index, 1);
      },
    },
    isDestroyed() {
      return this.destroyed;
    },
    setContentSize(width, height) {
      this.contentSizes.push({ width, height });
    },
    setIgnoreMouseEvents() {},
    on(event, listener) {
      listeners.set(event, listener);
    },
    close() {
      this.closed += 1;
      this.destroyed = true;
      listeners.get('closed')?.();
    },
  };
}

function createView(initialBounds = { x: 0, y: 0, width: 800, height: 600 }) {
  let bounds = initialBounds;
  const visibility = [];
  const throttling = [];
  const boundsChanges = [];
  const contents = {
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
    setBackgroundThrottling(value) {
      throttling.push(value);
    },
  };
  return {
    boundsChanges,
    contents,
    throttling,
    visibility,
    webContents: contents,
    getBounds: () => bounds,
    setBounds(next) {
      bounds = next;
      boundsChanges.push(next);
    },
    setVisible(value) {
      visibility.push(value);
    },
  };
}

function createEntry(browserSessionId, view, overrides = {}) {
  return {
    browserSessionId,
    view,
    visible: true,
    attached: false,
    windowAttached: false,
    hostWindow: null,
    ...overrides,
  };
}

function createHarness(entries) {
  const mainWindow = createWindow();
  const hiddenWindows = [];
  function BrowserWindow(options) {
    const window = createWindow();
    window.options = options;
    hiddenWindows.push(window);
    return window;
  }
  const host = createNativeBrowserViewHost({
    BrowserWindow,
    getMainWindow: () => mainWindow,
    listEntries: () => entries,
  });
  return { hiddenWindows, host, mainWindow };
}

test('child-view attachment is idempotent and removes the previous host first', () => {
  const firstHost = createWindow();
  const secondHost = createWindow();
  const view = createView();
  const entry = createEntry('browser-1', view);

  assert.equal(attachChildView(entry, firstHost), true);
  assert.equal(attachChildView(entry, firstHost), false);
  assert.equal(attachChildView(entry, secondHost), true);

  assert.deepEqual(firstHost.children, []);
  assert.deepEqual(secondHost.children, [view]);
  assert.equal(entry.hostWindow, secondHost);
  assert.equal(entry.windowAttached, true);
});

test('detaching clears ownership even when the host is already destroyed', () => {
  const view = createView();
  const host = createWindow();
  host.destroyed = true;
  const entry = createEntry('browser-1', view, {
    hostWindow: host,
    windowAttached: true,
  });

  assert.equal(detachChildView(entry), true);
  assert.equal(entry.hostWindow, null);
  assert.equal(entry.windowAttached, false);
});

test('hidden views share one offscreen host sized to the largest browser viewport', () => {
  const firstView = createView({ x: 0, y: 0, width: 800, height: 600 });
  const secondView = createView({ x: 0, y: 0, width: 1200, height: 700 });
  const entries = [createEntry('browser-1', firstView), createEntry('browser-2', secondView)];
  const { hiddenWindows, host } = createHarness(entries);

  host.addHiddenView(entries[0]);
  host.addHiddenView(entries[1]);

  assert.equal(hiddenWindows.length, 1);
  assert.deepEqual(hiddenWindows[0].children, [firstView, secondView]);
  assert.deepEqual(hiddenWindows[0].contentSizes.at(-1), { width: 1200, height: 700 });
  assert.deepEqual(firstView.visibility, [true]);
  assert.deepEqual(secondView.visibility, [true]);
  assert.equal(entries[0].hostWindow, hiddenWindows[0]);
  assert.equal(entries[1].hostWindow, hiddenWindows[0]);
});

test('moving the last hidden view to the main window closes the unused hidden host', () => {
  const view = createView();
  const entry = createEntry('browser-1', view, { visible: false });
  const entries = [entry];
  const { hiddenWindows, host, mainWindow } = createHarness(entries);

  host.addHiddenView(entry);
  const hiddenWindow = hiddenWindows[0];
  host.attachToMainWindow(entry);

  assert.deepEqual(hiddenWindow.children, []);
  assert.equal(hiddenWindow.closed, 1);
  assert.deepEqual(mainWindow.children, [view]);
  assert.equal(entry.hostWindow, mainWindow);
  assert.deepEqual(view.visibility, [true, false]);
  assert.deepEqual(view.throttling, [true]);
});

test('removing the last hidden view clears ownership and closes its host', () => {
  const view = createView();
  const entry = createEntry('browser-1', view);
  const entries = [entry];
  const { hiddenWindows, host } = createHarness(entries);

  host.addHiddenView(entry);
  const hiddenWindow = hiddenWindows[0];
  host.removeView(entry, view);

  assert.deepEqual(hiddenWindow.children, []);
  assert.equal(hiddenWindow.closed, 1);
  assert.equal(entry.hostWindow, null);
  assert.equal(entry.windowAttached, false);
});

test('hidden bounds normalize invalid dimensions and resize their live host', () => {
  const view = createView();
  const entry = createEntry('browser-1', view);
  const entries = [entry];
  const { hiddenWindows, host } = createHarness(entries);
  host.addHiddenView(entry);

  host.setHiddenBounds(entry, { width: 1400.4, height: 0 });

  assert.deepEqual(view.boundsChanges, [{ x: 0, y: 0, width: 1400, height: 800 }]);
  assert.deepEqual(hiddenWindows[0].contentSizes.at(-1), { width: 1400, height: 800 });
});

test('equal bounds avoid a native rebound and action state controls background throttling', () => {
  const view = createView({ x: 10, y: 20, width: 800, height: 600 });
  assert.equal(
    setBrowserViewBoundsIfChanged(view, { x: 10, y: 20, width: 800, height: 600 }),
    false,
  );
  assert.equal(
    setBrowserViewBoundsIfChanged(view, { x: 12, y: 20, width: 800, height: 600 }),
    true,
  );
  assert.deepEqual(view.boundsChanges, [{ x: 12, y: 20, width: 800, height: 600 }]);

  const entry = createEntry('browser-1', view, { attached: false });
  assert.equal(setBrowserActionActive(entry, true), true);
  assert.equal(setBrowserActionActive(entry, false), true);
  entry.attached = true;
  assert.equal(setBrowserActionActive(entry, false), true);
  assert.deepEqual(view.throttling, [false, true, false]);
});

test('view usability fails closed for destroyed or throwing web contents', () => {
  const destroyed = createView();
  destroyed.contents.destroyed = true;
  assert.equal(safeWebContents(destroyed), null);
  assert.equal(isBrowserViewUsable(destroyed), false);

  const throwing = {
    get webContents() {
      throw new Error('view is closing');
    },
  };
  assert.equal(safeWebContents(throwing), null);
  assert.equal(isBrowserViewUsable(throwing), false);
});
