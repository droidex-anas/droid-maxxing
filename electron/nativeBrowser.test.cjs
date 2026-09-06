const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createNativeBrowserBudget } = require('./nativeBrowserBudget.cjs');
const { createNativeBrowserManager } = require('./nativeBrowser.cjs');

let nextContentsId = 1;

class FakeWebContents extends EventEmitter {
  constructor() {
    super();
    this.id = nextContentsId++;
    this.url = 'about:blank';
    this.destroyed = false;
    this.loadedUrls = [];
    this.reloads = [];
    this.scripts = [];
    this.navigationHistory = {
      canGoBack: () => false,
      canGoForward: () => false,
    };
    this.debugger = {
      isAttached: () => true,
      attach() {},
      sendCommand: async () => ({}),
    };
  }

  isDestroyed() {
    return this.destroyed;
  }

  getURL() {
    return this.url;
  }

  setWindowOpenHandler(handler) {
    this.windowOpenHandler = handler;
  }

  setBackgroundThrottling() {}

  send() {}

  async loadURL(url) {
    this.loadedUrls.push(url);
    this.url = url;
    this.emit('did-start-navigation', {}, url, false, true);
    this.emit('did-navigate', {}, url);
    this.emit('did-finish-load');
  }

  reload() {
    this.reloads.push(this.url);
    this.emit('did-start-navigation', {}, this.url, false, true);
    this.emit('did-finish-load');
  }

  commitNavigation(url) {
    this.url = url;
    this.emit('did-start-navigation', {}, url, false, true);
    this.emit('did-navigate', {}, url);
    this.emit('did-finish-load');
  }

  failNavigation(url, code = -105) {
    this.url = 'chrome-error://chromewebdata/';
    this.emit('did-fail-load', {}, code, 'navigation failed', url, true);
  }

  async executeJavaScript(script) {
    this.scripts.push(script);
    if (script.includes('__DROIDMAXX_MASK_SENSITIVE_FIELDS')) return true;
    if (script.includes('__DROIDMAXX_AGENT_ACTION')) {
      const requestId = script.match(/"requestId":"([^"]+)"/)?.[1];
      return {
        requestId,
        ok: true,
        snapshot: { url: this.url, scroll: { x: 0, y: 0 }, refs: [] },
      };
    }
    return undefined;
  }

  async capturePage() {
    return {
      isEmpty: () => false,
      toPNG: () => Buffer.from('captured-page'),
    };
  }

  close() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('destroyed');
  }
}

class FakeView {
  constructor() {
    this.webContents = new FakeWebContents();
    this.bounds = { x: 0, y: 0, width: 1200, height: 800 };
  }

  getBounds() {
    return this.bounds;
  }

  setBounds(bounds) {
    this.bounds = bounds;
  }

  setVisible() {}
}

class FakeWindow extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.children = [];
    this.contentView = {
      addChildView: (view) => this.children.push(view),
      removeChildView: (view) => {
        this.children = this.children.filter((candidate) => candidate !== view);
      },
    };
  }

  isDestroyed() {
    return this.destroyed;
  }

  setContentSize() {}

  setIgnoreMouseEvents() {}

  close() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('closed');
  }
}

function harness() {
  const views = [];
  const hiddenWindows = [];
  const mainWindow = new FakeWindow();
  const revoked = [];
  const forgotten = [];
  class WebContentsView extends FakeView {
    constructor() {
      super();
      views.push(this);
    }
  }
  class BrowserWindow extends FakeWindow {
    constructor() {
      super();
      hiddenWindows.push(this);
    }
  }
  const browserSession = new EventEmitter();
  browserSession.setDevicePermissionHandler = () => {};
  browserSession.setPermissionCheckHandler = () => {};
  browserSession.setPermissionRequestHandler = () => {};
  browserSession.webRequest = { onCompleted() {}, onErrorOccurred() {} };
  const browserSettings = {
    homePage: () => 'https://home.example/',
    canAccessPermission: () => false,
    handlePermissionRequest: (_contents, _permission, callback) => callback(false),
    prepareDownload() {},
    areDiagnosticsEnabled: () => false,
    revokePermissionsForNavigation() {},
    revokePermissionsForContents: (contents) => revoked.push(contents),
    captureCredential: async () => undefined,
    credentialForAgent: async () => undefined,
    authorizeAuthenticationAction: async () => undefined,
    authorizeAgentRequest: async () => undefined,
    authorizeAgentOrigin: async () => undefined,
  };
  const cursor = {
    attach() {},
    detach() {},
    forget: (browserSessionId) => forgotten.push(browserSessionId),
    setBounds() {},
    park: async () => true,
    show: async () => true,
  };
  const manager = createNativeBrowserManager({
    appName: 'DROIDEX',
    BrowserWindow,
    WebContentsView,
    session: { fromPartition: () => browserSession },
    browserSettings,
    cursor,
    budget: createNativeBrowserBudget({ maxLive: 4, idleMs: 0 }),
    getMainWindow: () => mainWindow,
    getHostAppUrl: () => 'http://127.0.0.1:5173/',
    preloadPath: '/tmp/nativeBrowserPreload.cjs',
    sendToRenderer() {},
  });
  return { forgotten, hiddenWindows, mainWindow, manager, revoked, views };
}

test('user open and reload follow the live page, then recover its failed URL', async () => {
  const { manager, views } = harness();
  await manager.open('browser-1', 'https://example.test/start');
  const contents = views[0].webContents;

  contents.commitNavigation('https://example.test/live');
  await manager.reload('browser-1');
  assert.deepEqual(contents.reloads, ['https://example.test/live']);

  contents.failNavigation('https://example.test/live');
  await manager.reload('browser-1');
  assert.equal(contents.loadedUrls.at(-1), 'https://example.test/live');
  assert.equal(contents.getURL(), 'https://example.test/live');
});

test('capture runs through the composed page service and returns native image bytes', async () => {
  const { manager, views } = harness();
  await manager.open('browser-1', 'https://example.test/page');

  const result = await manager.capture('browser-1', { x: 5, y: 6, width: 40, height: 30 });

  assert.equal(result, Buffer.from('captured-page').toString('base64'));
  assert.equal(
    views[0].webContents.scripts.some((script) => script.includes('(true)')),
    true,
  );
  assert.equal(
    views[0].webContents.scripts.some((script) => script.includes('(false)')),
    true,
  );
});

test('background agent snapshots stay on the hidden host', async () => {
  const { hiddenWindows, mainWindow, manager } = harness();

  const result = await manager.runAgentAction({
    requestId: 'snapshot-1',
    appSessionId: 'app-1',
    browserSessionId: 'browser-1',
    action: 'snapshot',
  });

  assert.equal(result.ok, true);
  assert.equal(result.snapshot.url, 'https://home.example/');
  assert.deepEqual(mainWindow.children, []);
  assert.equal(hiddenWindows.length, 1);
  assert.equal(hiddenWindows[0].children.length, 1);
});

test('closeAll closes every view and revokes its permissions and cursor ownership', async () => {
  const { forgotten, hiddenWindows, manager, revoked, views } = harness();
  await manager.open('browser-1', 'https://one.example/');
  await manager.open('browser-2', 'https://two.example/');

  manager.closeAll();

  assert.deepEqual(
    views.map((view) => view.webContents.destroyed),
    [true, true],
  );
  assert.deepEqual(
    revoked,
    views.map((view) => view.webContents),
  );
  assert.deepEqual(forgotten, ['browser-1', 'browser-2']);
  assert.equal(
    hiddenWindows.every((window) => window.destroyed),
    true,
  );
});
