const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { captureDesktop } = require('./desktopPicker.cjs');
const { snapshotDisplay } = require('./desktopSnapshot.cjs');
const { png } = require('./validation.cjs');

function imageBuffer(width, height) {
  const buffer = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buffer);
  buffer.write('IHDR', 12);
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}
function fixture() {
  let panel;
  const handlers = new Map();
  const calls = [];
  const display = {
    id: 42,
    size: { width: 1200, height: 800 },
    scaleFactor: 2,
    bounds: { x: -1200, y: 80, width: 1200, height: 800 },
    workArea: { x: -1200, y: 100, width: 1200, height: 760 },
  };
  class Panel extends EventEmitter {
    constructor(options) {
      super();
      panel = this;
      this.options = options;
      this.dead = false;
      this.webContents = new EventEmitter();
      Object.assign(this.webContents, {
        mainFrame: {},
        setWindowOpenHandler() {},
        session: { setPermissionCheckHandler() {}, setPermissionRequestHandler() {} },
      });
    }
    setAlwaysOnTop() {}
    setVisibleOnAllWorkspaces(visible, options) {
      this.workspaceOptions = { visible, ...options };
    }
    loadFile() {
      return Promise.resolve();
    }
    showInactive() {
      calls.push('show-panel');
    }
    focus() {
      calls.push('focus-panel');
    }
    hide() {
      calls.push('hide-panel');
    }
    setBounds(rect) {
      calls.push(['bounds', rect]);
    }
    isDestroyed() {
      return this.dead;
    }
    destroy() {
      this.dead = true;
      this.emit('closed');
    }
  }
  const screen = new EventEmitter();
  screen.getCursorScreenPoint = () => ({ x: -500, y: 200 });
  screen.getDisplayNearestPoint = () => display;
  const buffer = imageBuffer(2400, 1600);
  const electron = {
    BrowserWindow: Panel,
    screen,
    ipcMain: {
      handle: (name, handler) => handlers.set(name, handler),
      removeHandler: (name) => handlers.delete(name),
    },
    systemPreferences: { getMediaAccessStatus: () => 'granted' },
    desktopCapturer: {
      getSources: async () => [
        { display_id: '42', thumbnail: { isEmpty: () => false, toPNG: () => buffer } },
      ],
    },
    nativeImage: {
      createFromBuffer: (source) => ({
        getSize: () => png(source),
        crop: (crop) => ({ toPNG: () => imageBuffer(crop.width, crop.height) }),
      }),
    },
  };
  const controller = new AbortController();
  const result = captureDesktop({
    electron,
    app: { isPackaged: true, getAppPath: () => '/app' },
    signal: controller.signal,
    theme: {},
    smartSelection: true,
  });
  const event = { sender: panel.webContents, senderFrame: panel.webContents.mainFrame };
  const request = (operation, extra = {}) =>
    handlers.get('capture:desktop')(event, { operation, ...extra });
  return { panel, controller, result, event, request, calls, electron, display, handlers, buffer };
}
test('desktop panel rejects foreign senders and Escape releases IPC, window and listeners', async () => {
  const f = fixture();
  await assert.rejects(
    f.handlers.get('capture:desktop')({ ...f.event, senderFrame: {} }, { operation: 'ready' }),
    /isolated panel/,
  );
  await assert.rejects(
    f.handlers.get('capture:desktop')({ ...f.event, sender: {} }, { operation: 'ready' }),
    /isolated panel/,
  );
  assert.deepEqual(f.panel.workspaceOptions, {
    visible: true,
    visibleOnFullScreen: true,
    skipTransformProcessType: true,
  });
  assert.equal(f.panel.options.type, 'panel');
  await f.request('ready');
  assert.deepEqual(f.calls, ['show-panel', 'focus-panel']);
  await f.request('cancel');
  assert.equal(await f.result, null);
  assert.equal(f.panel.isDestroyed(), true);
  assert.equal(f.handlers.size, 0);
  assert.equal(f.electron.screen.listenerCount('display-removed'), 0);
});
test('smart selection hides the toolbar before sampling and crops the retained physical pixels', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  const pending = f.request('choose', { mode: 'smart' });
  assert.deepEqual(f.calls, ['hide-panel']);
  t.mock.timers.tick(160);
  const snapshot = await pending;
  assert.equal(snapshot.width, 2400);
  assert.equal(snapshot.height, 1600);
  assert.deepEqual(f.calls.at(-1), ['bounds', f.display.bounds]);
  await f.request('selectionReady');
  await assert.rejects(
    f.request('select', { rect: { x: -1, y: 0, width: 100, height: 100 } }),
    /crop x/,
  );
  assert.equal(f.panel.isDestroyed(), false);
  await f.request('select', { rect: { x: 600, y: 120, width: 500, height: 300 } });
  assert.deepEqual(png((await f.result).buffer), { width: 500, height: 300 });
});
test('closing a picker during screen sampling cannot show it again or deliver a late capture', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  let release;
  const started = Promise.withResolvers();
  f.electron.desktopCapturer.getSources = () =>
    new Promise((resolve) => {
      release = resolve;
      started.resolve();
    });
  const pending = f.request('choose', { mode: 'smart' });
  t.mock.timers.tick(160);
  // Wait for sampling itself, not a version-dependent number of microtasks.
  await started.promise;
  f.controller.abort();
  assert.equal(await f.result, null);
  release([{ display_id: '42', thumbnail: { isEmpty: () => false, toPNG: () => f.buffer } }]);
  assert.equal(await pending, null);
  assert.deepEqual(f.calls, ['hide-panel']);
});
test('display identity and physical size are checked rather than falling back to a blurry or wrong screen', async () => {
  const f = fixture();
  f.controller.abort();
  await f.result;
  let requested;
  f.electron.desktopCapturer.getSources = async (options) => {
    requested = options;
    return [
      { display_id: 'wrong-display', thumbnail: { isEmpty: () => false, toPNG: () => f.buffer } },
    ];
  };
  await assert.rejects(snapshotDisplay(f.electron, f.display), /could not be captured/);
  assert.deepEqual(requested.thumbnailSize, { width: 2400, height: 1600 });
  f.electron.desktopCapturer.getSources = async () => [
    { display_id: '42', thumbnail: { isEmpty: () => false, toPNG: () => imageBuffer(1200, 800) } },
  ];
  await assert.rejects(snapshotDisplay(f.electron, f.display), /full resolution/);
});
test('display changes cancel instead of reusing stale screen coordinates', async () => {
  const f = fixture();
  f.electron.screen.emit('display-metrics-changed');
  assert.equal(await f.result, null);
  assert.equal(f.panel.isDestroyed(), true);
});

test('closing during the hide delay cancels acquisition rather than launching a snipper later', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  let samples = 0;
  f.electron.desktopCapturer.getSources = async () => {
    samples++;
    return [];
  };
  const pending = f.request('choose', { mode: 'smart' });
  await f.request('cancel');
  assert.equal(await f.result, null);
  assert.equal(await pending, null);
  t.mock.timers.tick(200);
  assert.equal(samples, 0);
});

test('permission denial stays in the desktop toolbar without acquiring pixels', async () => {
  const f = fixture();
  f.electron.systemPreferences.getMediaAccessStatus = () => 'denied';
  await assert.rejects(f.request('choose', { mode: 'smart' }), /Allow DROIDEX/);
  assert.equal(f.panel.isDestroyed(), false);
  assert.ok(!f.calls.includes('hide-panel'));
  await f.request('cancel');
  assert.equal(await f.result, null);
});
test('an abandoned toolbar times out and releases its IPC and display listeners', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  t.mock.timers.tick(180_000);
  assert.equal(await f.result, null);
  assert.equal(f.handlers.size, 0);
  assert.equal(f.electron.screen.listenerCount('display-metrics-changed'), 0);
});
