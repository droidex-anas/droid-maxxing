const path = require('node:path');
const timers = require('node:timers/promises');
const { captureNative } = require('./native.cjs');
const { snapshotDisplay, cropSnapshot } = require('./desktopSnapshot.cjs');
const { png } = require('./validation.cjs');

const THEME_KEYS = [
  '--droid-bg',
  '--droid-surface',
  '--droid-elevated',
  '--droid-border',
  '--droid-text',
  '--droid-text-secondary',
  '--droid-text-muted',
  '--droid-accent',
];
function captureDesktop({ electron, app, signal: ownerSignal, theme, smartSelection }) {
  if (ownerSignal.aborted) return Promise.resolve(null);
  const controller = new AbortController();
  const { signal } = controller;
  const { BrowserWindow, ipcMain, screen, systemPreferences } = electron;
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const work = display.workArea;
  const width = Math.min(600, work.width);
  const toolbarBounds = {
    x: Math.round(work.x + (work.width - width) / 2),
    y: Math.round(work.y + work.height - 148),
    width,
    height: 132,
  };
  const panel = new BrowserWindow({
    ...toolbarBounds,
    type: 'panel',
    title: 'DROIDEX Capture',
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'desktopPreload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      partition: 'capture-desktop',
    },
  });
  panel.setAlwaysOnTop(true, 'screen-saver');
  // This nonactivating NSPanel can join Spaces without transforming the whole
  // application's process type (which would hide its Dock icon and windows).
  panel.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true,
  });
  panel.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  panel.webContents.on('will-navigate', (event) => event.preventDefault());
  panel.webContents.on('will-attach-webview', (event) => event.preventDefault());
  panel.webContents.session.setPermissionRequestHandler((_contents, _permission, reply) =>
    reply(false),
  );
  panel.webContents.session.setPermissionCheckHandler(() => false);
  const colors = {};
  for (const key of THEME_KEYS) {
    const value = theme?.[key];
    if (
      typeof value === 'string' &&
      value.length < 100 &&
      /^(#[0-9a-f]{3,8}|rgba?\([0-9.,% /]+\))$/i.test(value.trim())
    )
      colors[key] = value.trim();
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let busy = false;
    let snapshot = null;
    let phase = 'toolbar';
    const timeout = setTimeout(() => finish(null), 180_000);
    const abort = () => finish(null);
    const displaysChanged = () => finish(null);
    function finish(result, error) {
      if (settled) return;
      settled = true;
      // Closing, timeout and display changes also stop an active native snipper.
      controller.abort();
      snapshot = null;
      clearTimeout(timeout);
      ownerSignal.removeEventListener('abort', abort);
      screen.removeListener('display-removed', displaysChanged);
      screen.removeListener('display-metrics-changed', displaysChanged);
      ipcMain.removeHandler('capture:desktop');
      if (!panel.isDestroyed()) panel.destroy();
      if (error) reject(error);
      else resolve(result);
    }
    function show() {
      if (settled || panel.isDestroyed()) return;
      panel.showInactive();
      panel.focus();
    }
    async function choose(mode) {
      if (busy || phase !== 'toolbar') throw new Error('A screen selection is already open');
      if (!['area', 'window', 'screen', 'smart'].includes(mode))
        throw new Error('Unknown desktop capture mode');
      busy = true;
      try {
        if (systemPreferences.getMediaAccessStatus('screen') === 'denied')
          throw new Error(
            'Allow DROIDEX in System Settings → Privacy & Security → Screen & System Audio Recording, then reopen DROIDEX.',
          );
        panel.hide();
        await timers.setTimeout(160, undefined, { signal });
        if (settled) return null;
        const buffer =
          mode === 'area' || mode === 'window'
            ? await captureNative(mode, signal)
            : await snapshotDisplay(electron, display);
        if (settled || signal.aborted) return null;
        if (!buffer) {
          finish(null);
          return null;
        }
        if (mode !== 'smart') {
          finish({
            buffer,
            title: `${mode === 'screen' ? 'Display' : mode === 'window' ? 'Window' : 'Area'} capture`,
          });
          return null;
        }
        snapshot = buffer;
        phase = 'selection';
        panel.setBounds(display.bounds);
        return {
          source: `data:image/png;base64,${buffer.toString('base64')}`,
          ...png(buffer),
          smartSelection,
        };
      } catch (error) {
        if (settled || signal.aborted) return null;
        snapshot = null;
        phase = 'toolbar';
        panel.setBounds(toolbarBounds);
        show();
        throw error;
      } finally {
        busy = false;
      }
    }
    ipcMain.handle('capture:desktop', async (event, request) => {
      if (
        settled ||
        event.sender !== panel.webContents ||
        event.senderFrame !== panel.webContents.mainFrame
      )
        throw new Error('Desktop capture belongs to its isolated panel');
      switch (request?.operation) {
        case 'ready':
          show();
          return { theme: colors };
        case 'choose':
          return choose(request.mode);
        case 'selectionReady':
          if (phase !== 'selection' || !snapshot) throw new Error('No screen selection is open');
          show();
          return;
        case 'select': {
          if (busy || !snapshot || phase !== 'selection')
            throw new Error('No screen selection is open');
          const buffer = cropSnapshot(electron.nativeImage, snapshot, request.rect);
          finish({ buffer, title: 'Smart area capture' });
          return;
        }
        case 'cancel':
          finish(null);
          return;
        default:
          throw new Error('Unknown desktop capture operation');
      }
    });
    panel.on('closed', abort);
    panel.webContents.once('render-process-gone', () =>
      finish(null, new Error('The desktop capture panel stopped. Try the shortcut again.')),
    );
    screen.on('display-removed', displaysChanged);
    screen.on('display-metrics-changed', displaysChanged);
    ownerSignal.addEventListener('abort', abort, { once: true });
    if (ownerSignal.aborted) {
      finish(null);
      return;
    }
    const devUrl = app.isPackaged ? undefined : process.env.ELECTRON_START_URL;
    const loading = devUrl
      ? panel.loadURL(new URL('capture.html', devUrl).href)
      : panel.loadFile(path.join(app.getAppPath(), 'dist', 'capture.html'));
    void loading.catch((error) => finish(null, error));
  });
}
module.exports = { captureDesktop };
