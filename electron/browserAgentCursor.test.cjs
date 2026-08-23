const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const {
  BROWSER_AGENT_CURSOR_HOTSPOT,
  BROWSER_AGENT_CURSOR_STYLES,
  createBrowserAgentCursorController,
  createBrowserAgentCursorDataUrl,
} = require('./browserAgentCursor.cjs');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function harness(options = {}) {
  const windows = [];
  const load = options.load;

  class FakeWebContents extends EventEmitter {
    setWindowOpenHandler(handler) {
      this.windowOpenHandler = handler;
    }
  }

  class FakeBrowserWindow extends EventEmitter {
    constructor(windowOptions) {
      super();
      this.options = windowOptions;
      this.webContents = new FakeWebContents();
      this.bounds = [];
      this.destroyed = false;
      this.hidden = 0;
      this.shown = 0;
      windows.push(this);
    }

    isDestroyed() {
      return this.destroyed;
    }

    setIgnoreMouseEvents(ignore, settings) {
      this.ignoreMouseEvents = { ignore, settings };
    }

    loadURL(url) {
      this.loadedUrl = url;
      this.loadedUrls ??= [];
      this.loadedUrls.push(url);
      return load?.promise ?? Promise.resolve();
    }

    setBounds(bounds, animate) {
      this.bounds.push({ bounds, animate });
    }

    showInactive() {
      this.shown += 1;
    }

    hide() {
      this.hidden += 1;
    }

    destroy() {
      this.destroyed = true;
    }
  }

  const controller = createBrowserAgentCursorController({
    BrowserWindow: FakeBrowserWindow,
    clearTimeout: options.clearTimeout,
    logError: options.logError,
    setTimeout: options.setTimeout,
    style: options.style,
  });
  return { controller, windows };
}

function hostWindow(contentBounds = { x: 100, y: 200, width: 900, height: 700 }) {
  const host = new EventEmitter();
  host.destroyed = false;
  host.isDestroyed = () => host.destroyed;
  host.getContentBounds = () => contentBounds;
  return host;
}

const browserBounds = { x: 10, y: 20, width: 300, height: 200 };

test('cursor overlay is sandboxed, click-through, static, and blocks navigation', () => {
  const { controller, windows } = harness();
  const host = hostWindow();

  controller.attach({ browserSessionId: 'browser-1', hostWindow: host, bounds: browserBounds });

  assert.equal(windows.length, 1);
  const overlay = windows[0];
  assert.equal(overlay.options.parent, host);
  assert.equal(overlay.options.transparent, true);
  assert.equal(overlay.options.focusable, false);
  assert.deepEqual(overlay.options.webPreferences, {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    devTools: false,
  });
  assert.deepEqual(overlay.ignoreMouseEvents, { ignore: true, settings: { forward: true } });
  assert.match(decodeURIComponent(overlay.loadedUrl), /default-src 'none'/);
  assert.doesNotMatch(decodeURIComponent(overlay.loadedUrl), /<script/i);
  assert.deepEqual(overlay.webContents.windowOpenHandler(), { action: 'deny' });

  let prevented = false;
  overlay.webContents.emit('will-navigate', { preventDefault: () => (prevented = true) });
  assert.equal(prevented, true);
});

test('cursor documents are main-owned static arrows with one exact hotspot', () => {
  assert.deepEqual(BROWSER_AGENT_CURSOR_STYLES, ['dark', 'light', 'droidex']);
  assert.deepEqual(BROWSER_AGENT_CURSOR_HOTSPOT, { x: 10, y: 8 });

  const documents = BROWSER_AGENT_CURSOR_STYLES.map((style) =>
    decodeURIComponent(createBrowserAgentCursorDataUrl(style)),
  );
  for (const document of documents) {
    assert.match(document, /default-src 'none'/);
    assert.match(document, /<path d="M10 8/);
    assert.doesNotMatch(document, /<script|javascript:/i);
  }
  assert.equal(documents[2].match(/class="agent-trail/g)?.length, 2);
  assert.doesNotMatch(documents[0], /class="agent-trail/);
  assert.doesNotMatch(documents[1], /class="agent-trail/);
  assert.equal(new Set(documents).size, 3);
  assert.throws(
    () => createBrowserAgentCursorDataUrl('url(https://page.example/cursor.svg)'),
    /style must be dark, light, or droidex/,
  );
});

test('controller accepts only trusted styles and can reload a live overlay', async () => {
  const { controller, windows } = harness();
  controller.attach({
    browserSessionId: 'browser-1',
    hostWindow: hostWindow(),
    bounds: browserBounds,
  });

  assert.match(decodeURIComponent(windows[0].loadedUrl), /class="agent-trail/);
  assert.match(decodeURIComponent(windows[0].loadedUrl), /fill="#34383f"/i);
  assert.equal(controller.setStyle('dark'), true);
  assert.equal(windows[0].loadedUrls.length, 2);
  assert.match(decodeURIComponent(windows[0].loadedUrl), /fill="#141517"/);
  assert.equal(controller.setStyle('dark'), false);
  assert.throws(() => controller.setStyle('<svg onload=alert(1)>'), /style must be/);

  const light = harness({ style: 'light' });
  light.controller.attach({
    browserSessionId: 'browser-2',
    hostWindow: hostWindow(),
    bounds: browserBounds,
  });
  assert.match(decodeURIComponent(light.windows[0].loadedUrl), /fill="#f7f7f8"/i);
});

test('main can position the cursor above the attached browser session', async () => {
  const { controller, windows } = harness();
  controller.attach({
    browserSessionId: 'browser-1',
    hostWindow: hostWindow(),
    bounds: browserBounds,
  });

  assert.equal(await controller.show({ browserSessionId: 'browser-1', x: 30, y: 40 }), true);

  assert.deepEqual(windows[0].bounds.at(-1), {
    bounds: { x: 130, y: 252, width: 44, height: 44 },
    animate: false,
  });
  assert.equal(windows[0].shown, 1);
  assert.equal(await controller.show({ browserSessionId: 'other-browser', x: 30, y: 40 }), false);
  assert.equal(await controller.show({ browserSessionId: 'browser-1', x: 301, y: 40 }), false);
  assert.equal(await controller.show({ browserSessionId: 'browser-1', x: 300, y: 40 }), false);
});

test('visible cursor expires instead of lingering over stale page state', async () => {
  let scheduled;
  let delay;
  const { controller, windows } = harness({
    setTimeout: (callback, timeoutMs) => {
      scheduled = callback;
      delay = timeoutMs;
      return { unref: () => undefined };
    },
    clearTimeout: () => undefined,
  });
  controller.attach({
    browserSessionId: 'browser-1',
    hostWindow: hostWindow(),
    bounds: browserBounds,
  });

  await controller.show({ browserSessionId: 'browser-1', x: 20, y: 30 });
  assert.equal(delay, 1_800);
  assert.equal(windows[0].shown, 1);

  scheduled();

  assert.equal(windows[0].hidden > 0, true);
});

test('bounds updates reposition a visible cursor and reject stale coordinates', async () => {
  const { controller, windows } = harness();
  controller.attach({
    browserSessionId: 'browser-1',
    hostWindow: hostWindow(),
    bounds: browserBounds,
  });
  await controller.show({ browserSessionId: 'browser-1', x: 280, y: 100 });

  assert.equal(controller.setBounds('browser-1', { x: 50, y: 60, width: 400, height: 300 }), true);
  assert.deepEqual(windows[0].bounds.at(-1).bounds, {
    x: 420,
    y: 352,
    width: 44,
    height: 44,
  });
  assert.equal(controller.setBounds('browser-1', { x: 50, y: 60, width: 200, height: 80 }), false);
  assert.equal(windows[0].hidden > 0, true);
});

test('detach invalidates a pending show and hides background sessions', async () => {
  const load = deferred();
  const { controller, windows } = harness({ load });
  controller.attach({
    browserSessionId: 'browser-1',
    hostWindow: hostWindow(),
    bounds: browserBounds,
  });
  const showing = controller.show({ browserSessionId: 'browser-1', x: 20, y: 30 });

  assert.equal(controller.detach('browser-1'), true);
  load.resolve();

  assert.equal(await showing, false);
  assert.equal(windows[0].shown, 0);
  assert.equal(windows[0].hidden > 0, true);
  assert.equal(await controller.show({ browserSessionId: 'browser-1', x: 20, y: 30 }), false);
});

test('switching sessions hides the old cursor and destroy releases the overlay', async () => {
  const { controller, windows } = harness();
  const host = hostWindow();
  controller.attach({ browserSessionId: 'browser-1', hostWindow: host, bounds: browserBounds });
  await controller.show({ browserSessionId: 'browser-1', x: 20, y: 30 });

  controller.attach({ browserSessionId: 'browser-2', hostWindow: host, bounds: browserBounds });
  assert.equal(windows.length, 1);
  assert.equal(windows[0].hidden > 0, true);
  assert.equal(await controller.show({ browserSessionId: 'browser-1', x: 20, y: 30 }), false);
  assert.equal(await controller.show({ browserSessionId: 'browser-2', x: 20, y: 30 }), true);

  controller.destroy();
  assert.equal(windows[0].destroyed, true);
});

test('reattaching the same session with equal bounds preserves the live cursor', async () => {
  const { controller, windows } = harness();
  const host = hostWindow();
  controller.attach({ browserSessionId: 'browser-1', hostWindow: host, bounds: browserBounds });
  await controller.show({ browserSessionId: 'browser-1', x: 20, y: 30 });
  const hiddenBefore = windows[0].hidden;

  assert.equal(
    controller.attach({ browserSessionId: 'browser-1', hostWindow: host, bounds: browserBounds }),
    false,
  );
  assert.equal(windows[0].hidden, hiddenBefore);
  assert.equal(await controller.show({ browserSessionId: 'browser-1', x: 25, y: 35 }), true);
});

test('host close destroys its cursor overlay', () => {
  const { controller, windows } = harness();
  const host = hostWindow();
  controller.attach({ browserSessionId: 'browser-1', hostWindow: host, bounds: browserBounds });

  host.emit('closed');

  assert.equal(windows[0].destroyed, true);
});

test('overlay load failures stay hidden, report diagnostics, and release the window', async () => {
  const load = deferred();
  const errors = [];
  const { controller, windows } = harness({
    load,
    logError: (message, error) => errors.push({ message, error }),
  });
  controller.attach({
    browserSessionId: 'browser-1',
    hostWindow: hostWindow(),
    bounds: browserBounds,
  });
  const showing = controller.show({ browserSessionId: 'browser-1', x: 20, y: 30 });
  const error = new Error('load failed');

  load.reject(error);

  assert.equal(await showing, false);
  assert.equal(windows[0].shown, 0);
  assert.equal(windows[0].destroyed, true);
  assert.deepEqual(errors, [{ message: 'Failed to load the browser agent cursor.', error }]);
});
