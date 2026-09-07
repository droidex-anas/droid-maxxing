const { EventEmitter } = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createNativeBrowserViewFactory } = require('./nativeBrowserView.cjs');

function harness(overrides = {}) {
  const calls = {
    transition: [],
    detachCursor: [],
    invalidateNavigation: 0,
    invalidateCredentials: 0,
    revokeNavigation: 0,
    revokeContents: 0,
    devicePermission: null,
    permissionCheck: null,
    permissionRequest: null,
  };
  const contents = new EventEmitter();
  Object.assign(contents, {
    id: 17,
    isDestroyed: () => false,
    getURL: () => 'https://current.test/page',
    send() {},
    setWindowOpenHandler(handler) {
      this.windowOpenHandler = handler;
    },
  });
  function WebContentsView(options) {
    this.options = options;
    this.webContents = contents;
  }
  const browserSession = {
    setDevicePermissionHandler(handler) {
      calls.devicePermission = handler;
    },
    setPermissionCheckHandler(handler) {
      calls.permissionCheck = handler;
    },
    setPermissionRequestHandler(handler) {
      calls.permissionRequest = handler;
    },
    on() {},
    webRequest: {
      onCompleted(_filter, handler) {
        this.completed = handler;
      },
      onErrorOccurred(_filter, handler) {
        this.failed = handler;
      },
    },
  };
  const browserSettings = {
    canAccessPermission: () => 'permission-check',
    handlePermissionRequest: () => 'permission-request',
    prepareDownload() {},
    areDiagnosticsEnabled: () => true,
    revokePermissionsForNavigation: () => {
      calls.revokeNavigation += 1;
    },
    revokePermissionsForContents: () => {
      calls.revokeContents += 1;
    },
    ...overrides.browserSettings,
  };
  const navigation = {
    authorizeTransition: (_entry, _view, kind, url) => {
      calls.transition.push({ kind, url });
      return overrides.allowTransition ?? false;
    },
    clearTrustedUserNavigation: (entry) => {
      entry.trustedUserNavigation = null;
    },
    invalidate: () => {
      calls.invalidateNavigation += 1;
    },
  };
  const credentials = {
    allowAuthenticationPopup: () => undefined,
    hardenAuthenticationPopup() {},
    invalidate: () => {
      calls.invalidateCredentials += 1;
    },
    ...overrides.credentials,
  };
  const factory = createNativeBrowserViewFactory({
    WebContentsView,
    session: { fromPartition: () => browserSession },
    preloadPath: '/app/nativeBrowserPreload.cjs',
    partition: 'persist:droidex-browser',
    normalizeBrowserConsoleMessage: (details) => details,
    redactBrowserDiagnosticUrl: (url) => url,
    urls: {
      validateUrl: (url) => {
        const parsed = new URL(url);
        if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('unsafe');
      },
      isChromeErrorUrl: (url) => url.startsWith('chrome-error://'),
      httpFallbackUrl: () => undefined,
      rememberFailedRestoreUrl() {},
    },
    safeWebContents: (view) => view?.webContents ?? null,
    browserSettings,
    navigation,
    cursor: { detach: (id) => calls.detachCursor.push(id) },
    credentials,
    loadUrl: async () => ({ ok: true }),
    emitLoaded() {},
    emitLoadFailed() {},
    applyDesignState() {},
    recoverRenderer() {},
    onViewDestroyed() {},
    listEntries: () => [],
  });
  return { browserSession, calls, contents, factory };
}

test('browser view entries initialize feature lifecycle state', () => {
  const { factory } = harness();

  const entry = factory.createEntry('browser-1');

  assert.equal(entry.appSessionId, null);
  assert.equal(entry.documentGeneration, 0);
  assert.equal(entry.navigationGeneration, 0);
  assert.equal(entry.agentActionActive, false);
  assert.equal(entry.userNavigationActive, false);
  assert.equal(entry.captureActivityCount, 0);
  assert.equal(entry.pendingAgentNavigation, null);
  assert.equal(entry.trustedUserNavigation, null);
  assert.equal(entry.approvedHistoryTransition, null);
  assert.equal(entry.authenticationCapability, null);
  assert.equal(entry.authenticationPopupCapability, null);
});

test('browser session permission handling is delegated to feature settings', () => {
  const { calls, factory } = harness();
  factory.configureSession();

  assert.equal(calls.devicePermission(), false);
  assert.equal(
    calls.permissionCheck('contents', 'camera', 'https://site.test', {}),
    'permission-check',
  );
  assert.equal(
    calls.permissionRequest('contents', 'camera', () => {}, {}),
    'permission-request',
  );
});

test('unsafe and unapproved cross-origin navigations are prevented', () => {
  const { calls, contents, factory } = harness();
  const entry = factory.createEntry('browser-1');
  factory.attachView(entry);
  let prevented = 0;
  const event = { preventDefault: () => (prevented += 1) };

  contents.emit('will-navigate', event, 'javascript:alert(1)');
  contents.emit('will-navigate', event, 'https://next.test/path');

  assert.equal(prevented, 2);
  assert.deepEqual(calls.transition, [{ kind: 'navigate', url: 'https://next.test/path' }]);
});

test('main-frame navigation invalidates document-bound trust and credentials', () => {
  const { calls, contents, factory } = harness();
  const entry = factory.createEntry('browser-1');
  entry.trustedUserNavigation = { activationId: 'old' };
  factory.attachView(entry);

  contents.emit('did-start-navigation', {}, 'https://next.test', false, true);

  assert.equal(entry.documentGeneration, 1);
  assert.equal(entry.trustedUserNavigation, null);
  assert.equal(calls.invalidateCredentials, 1);
  assert.equal(calls.revokeNavigation, 1);
});

test('destroyed views revoke capabilities, permissions, and trusted cursor state', () => {
  const { calls, contents, factory } = harness();
  const entry = factory.createEntry('browser-1');
  factory.attachView(entry);

  contents.emit('destroyed');

  assert.equal(entry.view, null);
  assert.deepEqual(calls.detachCursor, ['browser-1']);
  assert.equal(calls.invalidateNavigation, 1);
  assert.equal(calls.invalidateCredentials, 1);
  assert.equal(calls.revokeContents, 1);
});
