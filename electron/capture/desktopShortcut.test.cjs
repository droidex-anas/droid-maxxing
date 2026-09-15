const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { installCaptureService } = require('./service.cjs');

test('the global shortcut requests desktop capture without restoring or focusing the main app', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'capture-shortcut-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let shortcut;
  const handlers = new Map();
  const seen = [];
  const contents = { mainFrame: {}, send: (channel) => seen.push(channel) };
  const window = {
    isDestroyed: () => false,
    webContents: contents,
    restore: () => seen.push('restore'),
    show: () => seen.push('show'),
    focus: () => seen.push('focus'),
  };
  const service = installCaptureService({
    electron: {
      ipcMain: {
        handle: (name, handler) => handlers.set(name, handler),
        removeHandler: (name) => handlers.delete(name),
      },
      globalShortcut: {
        register: (_key, handler) => {
          shortcut = handler;
          return true;
        },
        unregister() {},
      },
    },
    app: { getPath: () => dir },
    getMainWindow: () => window,
    saveImage: async () => '',
  });
  t.after(() => service.dispose());
  await handlers.get('capture:request')(
    { sender: contents, senderFrame: contents.mainFrame },
    { operation: 'preferences' },
  );
  shortcut();
  assert.deepEqual(seen, ['capture:shortcut']);
});
