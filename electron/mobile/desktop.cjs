const { app, BrowserWindow, dialog, ipcMain, clipboard } = require('electron');
const { readFile, copyFile } = require('node:fs/promises');
const path = require('node:path');

let window = null;
let installed = false;
const channel = 'droidex-mobile-control';

async function request(operation, body) {
  let capability;
  try {
    capability = JSON.parse(await readFile(path.join(app.getPath('userData'), 'mobile-control.json'), 'utf8'));
  } catch {
    throw new Error('DROIDEX is still starting. Try again after the desktop agent is ready.');
  }
  if (!Number.isInteger(capability.port) || capability.port < 1 || capability.port > 65535 || !/^[a-f0-9]{64}$/.test(capability.token)) {
    throw new Error('The mobile service is unavailable. Restart DROIDEX.');
  }
  const response = await fetch(`http://127.0.0.1:${capability.port}/${operation}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${capability.token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(25000),
    redirect: 'error',
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'The mobile service could not complete this request.');
  return result;
}

function installHandler() {
  if (installed) return;
  installed = true;
  ipcMain.handle(channel, async (event, operation, value) => {
    if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
      throw new Error('Unknown mobile settings window.');
    }
    switch (operation) {
      case 'status': return request('status');
      case 'folder': {
        const result = await dialog.showOpenDialog(window, { title: 'Workspace for your phone', properties: ['openDirectory'] });
        return result.canceled ? null : result.filePaths[0];
      }
      case 'enable': {
        if (!value || typeof value.workspace !== 'string' || typeof value.address !== 'string') throw new Error('Choose a workspace and network.');
        const consent = await dialog.showMessageBox(window, {
          type: 'warning', buttons: ['Cancel', 'Enable for testing'], defaultId: 0, cancelId: 0,
          message: 'Allow your paired phone to work on this computer?',
          detail: 'The phone can start agent sessions, use your provider quota, and approve real commands or file edits. The workspace is a starting directory, not an operating-system sandbox. Pair only your own phone on a trusted private network. No port forwarding.',
        });
        if (consent.response !== 1) throw new Error('Mobile access was not enabled.');
        return request('enable', { workspace: value.workspace, address: value.address });
      }
      case 'approve':
        if (!value || typeof value.id !== 'string' || typeof value.allow !== 'boolean') throw new Error('Invalid pairing approval.');
        return request('approve', { id: value.id, allow: value.allow });
      case 'disable': return request('disable', {});
      case 'copy': {
        const state = await request('status');
        if (!state.code || Date.now() >= state.expiresAt) throw new Error('Generate a new pairing code.');
        clipboard.writeText(state.code);
        return true;
      }
      case 'save-guide': {
        const result = await dialog.showSaveDialog(window, {
          title: 'Save DROIDEX pairing guide',
          defaultPath: 'DROIDEX-Remote-Guide.svg',
          filters: [{ name: 'SVG image', extensions: ['svg'] }],
        });
        if (result.canceled || !result.filePath) return false;
        await copyFile(path.join(__dirname, 'RemoteArtwork', 'guide.svg'), result.filePath);
        return true;
      }
      default: throw new Error('Unsupported mobile operation.');
    }
  });
}

async function openMobileWindow() {
  if (window && !window.isDestroyed()) { window.show(); window.focus(); return; }
  installHandler();
  window = new BrowserWindow({
    title: 'Connect your phone · DROIDEX', width: 580, height: 710, minWidth: 420, minHeight: 560,
    backgroundColor: '#0a0a0a', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.on('closed', () => { window = null; });
  await window.loadFile(path.join(__dirname, 'index.html'));
}

module.exports = { openMobileWindow };
