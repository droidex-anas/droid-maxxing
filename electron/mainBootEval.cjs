// Require-time boot of main.cjs under a Node `electron` stub. Does not ready
// the app, create windows, dispatch IPC, or spawn the sidecar.
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SENTINEL = 'MAIN_BOOT_EVAL_OK';

function unused(name) {
  const throwOnUse = () => {
    throw new Error(`electron stub: ${name} was used during main-module evaluation`);
  };
  return new Proxy(throwOnUse, {
    get(_target, prop) {
      if (prop === 'prototype') return Function.prototype;
      throw new Error(
        `electron stub: ${name}.${String(prop)} was used during main-module evaluation`,
      );
    },
    apply: throwOnUse,
    construct: throwOnUse,
  });
}

function createElectronStub(options) {
  const appRoot = options.appRoot;
  const paths = {
    home: os.homedir(),
    appData: path.join(options.userData, 'appData'),
    userData: options.userData,
    temp: os.tmpdir(),
    exe: process.execPath,
    logs: path.join(options.userData, 'logs'),
    crashDumps: path.join(options.userData, 'crashDumps'),
    sessionData: path.join(options.userData, 'sessionData'),
  };

  const app = new EventEmitter();
  app.isPackaged = false;
  app.name = 'DROIDEX';
  app.setName = (name) => {
    app.name = name;
  };
  app.getName = () => app.name;
  app.getVersion = () => options.version;
  app.getAppPath = () => appRoot;
  app.getPath = (name) => {
    if (!Object.hasOwn(paths, name)) throw new Error(`electron stub: unknown app path ${name}`);
    return paths[name];
  };
  app.setPath = (name, value) => {
    paths[name] = value;
  };
  app.disableHardwareAcceleration = () => {};
  app.isReady = () => false;
  // Stay pending: resolving would enter createMainWindow, which this stub refuses.
  app.whenReady = () => new Promise(() => {});
  app.quit = () => {};
  app.exit = () => {};
  app.relaunch = () => {};
  app.commandLine = { appendSwitch() {} };
  app.getAppMetrics = () => [];

  const protocol = {
    registerSchemesAsPrivileged() {},
    handle() {},
    registerStringProtocol() {},
  };
  const defaultSession = {
    protocol,
    setPermissionRequestHandler() {},
    setPermissionCheckHandler() {},
    setDevicePermissionHandler() {},
    getPreloads: () => [],
    setPreloads() {},
    registerPreloadScript() {},
  };
  const ipcMain = new EventEmitter();
  ipcMain.handle = () => {};
  ipcMain.removeHandler = () => {};

  const nativeTheme = new EventEmitter();
  nativeTheme.shouldUseDarkColors = false;

  const powerMonitor = new EventEmitter();
  powerMonitor.isOnBatteryPower = () => false;

  return {
    app,
    BrowserWindow: unused('BrowserWindow'),
    Menu: unused('Menu'),
    Notification: unused('Notification'),
    WebContentsView: unused('WebContentsView'),
    dialog: unused('dialog'),
    ipcMain,
    nativeTheme,
    powerMonitor,
    protocol,
    safeStorage: unused('safeStorage'),
    session: {
      defaultSession,
      fromPartition() {
        return defaultSession;
      },
    },
    shell: unused('shell'),
    webContents: { getAllWebContents: () => [] },
    net: unused('net'),
    autoUpdater: unused('autoUpdater'),
    screen: unused('screen'),
  };
}

function installElectronStub(electron) {
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === 'electron') return electron;
    return originalLoad.call(this, request, parent, isMain);
  };
}

function evaluateMain() {
  const appRoot = path.resolve(__dirname, '..');
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'droidex-boot-eval-'));
  process.env.DROIDEX_USER_DATA_DIR = userData;
  delete process.env.SENTRY_DSN;
  delete process.env.ELECTRON_START_URL;
  delete process.env.SIDECAR_ENTRY;
  process.resourcesPath = path.join(userData, 'resources');
  Object.defineProperty(process.versions, 'electron', { value: '37.2.0', configurable: true });
  Object.defineProperty(process.versions, 'chrome', { value: '136.0.0.0', configurable: true });

  const packageJson = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'));
  const electron = createElectronStub({
    appRoot,
    userData,
    version: packageJson.version,
  });
  installElectronStub(electron);
  require(path.join(__dirname, 'main.cjs'));
  process.stdout.write(`${SENTINEL}\n`);
}

module.exports = { SENTINEL, evaluateMain };

if (require.main === module) {
  try {
    evaluateMain();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
