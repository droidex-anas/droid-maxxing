const path = require('node:path');
const fs = require('node:fs/promises');
const { createCaptureStore } = require('./store.cjs');
const { captureNative, captureComponent } = require('./native.cjs');
const { captureDesktop } = require('./desktopPicker.cjs');
const { decodePng, id: validateId } = require('./validation.cjs');

function assertCaptureSender(event, window) {
  if (
    !window ||
    window.isDestroyed() ||
    event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame
  )
    throw new Error('Capture is restricted to the DROIDEX application window');
}
function installCaptureService({ electron, app, getMainWindow, saveImage }) {
  const { ipcMain, nativeImage, clipboard, dialog, globalShortcut, systemPreferences } = electron;
  const store = createCaptureStore(path.join(app.getPath('userData'), 'captures'));
  let active = null;
  let shortcut = '';
  let shortcutRegistered = false;
  let disposed = false;

  function updateShortcut(preferences) {
    if (shortcut && shortcutRegistered) globalShortcut?.unregister(shortcut);
    shortcut = preferences.shortcut;
    shortcutRegistered = false;
    if (!shortcut || !globalShortcut) return;
    shortcutRegistered = globalShortcut.register(shortcut, () => {
      const window = getMainWindow();
      if (!window || window.isDestroyed()) return;
      if (active) {
        active.controller.abort();
        return;
      }
      window.webContents.send('capture:shortcut');
    });
  }
  const ready = store
    .preferences()
    .then((preferences) => {
      if (!disposed) updateShortcut(preferences);
    })
    .catch((error) => console.error('Capture preferences unavailable:', error.message));

  async function take(event, request) {
    if (active) throw new Error('A capture is already open');
    const mode = request?.mode;
    if (!['area', 'window', 'screen', 'component', 'desktop'].includes(mode))
      throw new Error('Unknown capture mode');
    const requestId = validateId(request.requestId);
    const window = getMainWindow();
    const controller = new AbortController();
    const job = { requestId, controller, sender: event.sender, mode };
    let completed = false;
    active = job;
    const cancel = () => controller.abort();
    event.sender.once('destroyed', cancel);
    event.sender.once('did-start-loading', cancel);
    try {
      let buffer;
      let title = request.title;
      if (mode === 'desktop') {
        if (process.platform !== 'darwin')
          throw new Error('The desktop capture toolbar currently requires macOS.');
        const preferences = await store.preferences();
        if (controller.signal.aborted || disposed) return null;
        const result = await captureDesktop({
          electron,
          app,
          signal: controller.signal,
          theme: request.theme,
          smartSelection: preferences.smartSelection,
        });
        if (!result || controller.signal.aborted || disposed) return null;
        buffer = result.buffer;
        title = result.title;
      } else if (mode === 'component') {
        buffer = await captureComponent(event.sender, request.rect);
      } else {
        if (process.platform !== 'darwin')
          throw new Error(
            'Desktop snipping is currently available on macOS. Use Import image here.',
          );
        if (systemPreferences.getMediaAccessStatus('screen') === 'denied')
          throw new Error(
            'Allow DROIDEX in System Settings → Privacy & Security → Screen & System Audio Recording, then reopen the app.',
          );
        window.hide();
        // Let the window server remove DROIDEX before the native picker begins.
        await new Promise((resolve) => setTimeout(resolve, 180));
        if (controller.signal.aborted) return null;
        buffer = await captureNative(mode, controller.signal);
        if (!buffer && systemPreferences.getMediaAccessStatus('screen') === 'denied')
          throw new Error(
            'Screen Recording permission was denied. Enable DROIDEX in macOS Privacy & Security settings.',
          );
      }
      if (!buffer || controller.signal.aborted || disposed) return null;
      const item = await store.create(
        buffer,
        title ||
          `${mode === 'screen' ? 'Display' : mode === 'component' ? 'Component' : mode === 'window' ? 'Window' : 'Area'} capture`,
      );
      const document = await store.read(item.id);
      if (controller.signal.aborted || disposed) return null;
      completed = true;
      return document;
    } finally {
      event.sender.removeListener('destroyed', cancel);
      event.sender.removeListener('did-start-loading', cancel);
      if (active === job) active = null;
      if (
        !disposed &&
        (mode !== 'desktop' || completed) &&
        window === getMainWindow() &&
        !window.isDestroyed() &&
        !event.sender.isDestroyed()
      ) {
        if (window.isMinimized()) window.restore();
        window.show();
        window.focus();
      }
    }
  }

  async function handle(event, request) {
    assertCaptureSender(event, getMainWindow());
    if (disposed) throw new Error('Capture is closing');
    switch (request?.operation) {
      case 'preferences':
        await ready;
        return {
          preferences: await store.preferences(),
          nativeAvailable: process.platform === 'darwin',
          shortcutRegistered,
        };
      case 'setPreferences': {
        const next = await store.setPreferences(request.value);
        if (!disposed) updateShortcut(next);
        return {
          preferences: next,
          nativeAvailable: process.platform === 'darwin',
          shortcutRegistered,
        };
      }
      case 'take':
        return take(event, request);
      case 'cancel':
        if (active?.requestId === request.requestId && active.sender === event.sender)
          active.controller.abort();
        return;
      case 'import': {
        const { buffer } = decodePng(request.source);
        if (nativeImage.createFromBuffer(buffer).isEmpty())
          throw new Error('The imported image could not be decoded');
        const item = await store.create(buffer, request.title);
        return store.read(item.id);
      }
      case 'read':
        return store.read(request.id);
      case 'list':
        return store.list();
      case 'thumbnail':
        return store.thumbnail(request.id);
      case 'delete':
        return store.delete(request.id);
      case 'save': {
        const { buffer } = decodePng(request.output);
        const image = nativeImage.createFromBuffer(buffer);
        if (image.isEmpty()) throw new Error('The capture export could not be decoded');
        const thumbnail = image
          .resize({ width: Math.min(360, image.getSize().width), quality: 'best' })
          .toPNG();
        return store.save(request.id, request.revision, request.recipe, buffer, thumbnail);
      }
      case 'copy': {
        const { buffer } = await store.output(request.id);
        clipboard.writeImage(nativeImage.createFromBuffer(buffer));
        return;
      }
      case 'export': {
        const { buffer } = await store.output(request.id);
        const result = await dialog.showSaveDialog(getMainWindow(), {
          title: 'Save capture',
          defaultPath: 'DROIDEX Capture.png',
          filters: [{ name: 'PNG image', extensions: ['png'] }],
        });
        if (result.canceled || !result.filePath) return false;
        await fs.writeFile(result.filePath, buffer, { mode: 0o600 });
        return true;
      }
      case 'attach': {
        const { item, buffer, preview, width, height } = await store.output(request.id);
        // The composer owns a fresh temp copy. Editing/deleting history can
        // never invalidate an attachment already referenced by a prompt.
        const attachmentPath = await saveImage(
          `data:image/png;base64,${buffer.toString('base64')}`,
        );
        return {
          path: attachmentPath,
          preview,
          capture: { id: item.id, title: item.title, width, height },
        };
      }
      default:
        throw new Error('Unknown capture operation');
    }
  }
  ipcMain.handle('capture:request', handle);
  return {
    cancel() {
      active?.controller.abort();
    },
    dispose() {
      disposed = true;
      active?.controller.abort();
      if (shortcut && shortcutRegistered) globalShortcut?.unregister(shortcut);
      ipcMain.removeHandler('capture:request');
    },
  };
}
module.exports = { installCaptureService, assertCaptureSender };
