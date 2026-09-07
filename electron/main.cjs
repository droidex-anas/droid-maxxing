const {
  app,
  BrowserWindow,
  Menu,
  Notification,
  WebContentsView,
  dialog,
  ipcMain,
  nativeTheme,
  powerMonitor,
  protocol,
  safeStorage,
  session,
  shell,
  webContents,
} = require('electron');
const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const gitVcs = require('./git.cjs');
const githubVcs = require('./github.cjs');
const githubPrConversation = require('./githubPrConversation.cjs');
const { createTerminalManager } = require('./terminal.cjs');
const { createTerminalSubscriptionRegistry } = require('./terminalPort.cjs');
const { createPerformanceMetricsCollector } = require('./performanceMetrics.cjs');
const { createNativeBrowserBudget } = require('./nativeBrowserBudget.cjs');
const { createNativeBrowserManager } = require('./nativeBrowser.cjs');
const { createPowerTier } = require('./powerTier.cjs');
const files = require('./files.cjs');
const attachments = require('./attachments.cjs');
const localImages = require('./localImages.cjs');
const { createSidecarSupervisor } = require('./sidecar.cjs');
const { installRendererNavigationGuard } = require('./rendererSecurity.cjs');
const { installApplicationMenu } = require('./applicationMenu.cjs');
const { createRendererOomRecovery, isRendererMemoryExit } = require('./rendererOomRecovery.cjs');
const { autoUpdater } = require('electron-updater');
const { createAppUpdater } = require('./appUpdater.cjs');
const Sentry = require('@sentry/electron/main');
const { createDiagnostics } = require('./diagnostics.cjs');
const {
  preferenceFilePath: hardwareAccelerationPreferenceFilePath,
  readHardwareAccelerationPreferenceSync,
  loadHardwareAccelerationPreference,
  saveHardwareAccelerationPreference,
} = require('./hardwareAcceleration.cjs');
const { closeAllDesktopNotifications, showDesktopNotification } = require('./notifications.cjs');
const APP_NAME = 'DROIDEX';
// An explicit profile override means a second dev instance is running beside
// the main one; its sidecar then gets an isolated history state dir so the two
// instances never fight over the history writer lease.
const userDataOverride = process.env.DROIDEX_USER_DATA_DIR;
const buildMetadata = readBuildMetadata();
const terminalManager = createTerminalManager({
  defaultCwd: async () => {
    const chatCwd = path.join(app.getPath('userData'), 'chats');
    await fsp.mkdir(chatCwd, { recursive: true });
    return chatCwd;
  },
});
const terminalSubscriptions = createTerminalSubscriptionRegistry(terminalManager);
const performanceMetrics = createPerformanceMetricsCollector({
  countPtys: () => terminalManager.count(),
  listWebContents: () => webContents.getAllWebContents(),
  nativeBrowserCounts: () => nativeBrowserManager.resourceCounts(),
  terminalCounts: () => terminalManager.resourceCounts(),
  powerTier: () => powerTier.current(),
  onSample: (metrics) => powerTier.noteRss(metrics.memory.rssBytes),
});
const filesRootAccess = files.createRootAccessRegistry();
const diagnostics = createDiagnostics({
  app,
  sentry: Sentry,
  dsn: buildMetadata.sentryDsn,
  logError: (message, error) => console.error('[diagnostics] %s:', message, error),
});
const sidecarSupervisor = createSidecarSupervisor({
  entryPath: sidecarEntry,
  cwd: () => (app.isPackaged ? process.resourcesPath : appRoot()),
  userData: () => app.getPath('userData'),
  stateDir: () => (userDataOverride ? path.join(userDataOverride, 'state') : undefined),
  onUnexpectedExit: (error) => diagnostics.captureException(error, { process: 'sidecar' }),
});
// subscribe() replays the current status synchronously, so mainWindow must
// already be initialized when this runs.
let mainWindow = null;
sidecarSupervisor.subscribe((status) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('sidecar-status', status);
  }
});
const appUpdater = createAppUpdater({
  app,
  autoUpdater,
  installMode: buildMetadata.updateInstallMode,
  sparkleFeedUrl: buildMetadata.sparkleFeedUrl,
  sparkleUpdater: () => require('@droidex/sparkle-updater'),
  prepareToInstall: () => sidecarSupervisor.stop(),
  logError: (message, error) => console.error('[update] %s:', message, error),
});
const rendererOomRecovery = createRendererOomRecovery();

// Selected app-icon appearance. 'system' tracks the OS light/dark setting via
// nativeTheme; 'light'/'dark' pin a specific artwork.
let appIconMode = 'system';
// Session to open after a finish-notification click. macOS often focuses the
// app before (or without) delivering the Notification `click` payload cleanly,
// so we queue the target and re-deliver on focus until the renderer acks.
/** @type {{ appSessionId: string, expiresAt: number } | null } */
let pendingNotificationOpen = null;
const PENDING_NOTIFICATION_OPEN_MS = 30_000;
// Keep hidden browser sessions warm by default so authenticated pages and
// compositor state survive while the Browser pane is closed.
const HIDDEN_BROWSER_IDLE_MS = Number(process.env.DROID_NATIVE_BROWSER_IDLE_MS ?? 0);
const nativeBrowserBudget = createNativeBrowserBudget({
  maxLive: process.env.DROID_NATIVE_BROWSER_MAX_LIVE,
  idleMs: HIDDEN_BROWSER_IDLE_MS,
});
const nativeBrowserManager = createNativeBrowserManager({
  app,
  appName: APP_NAME,
  BrowserWindow,
  WebContentsView,
  session,
  dialog,
  safeStorage,
  budget: nativeBrowserBudget,
  getMainWindow: () => mainWindow,
  preloadPath: path.join(__dirname, 'nativeBrowserPreload.cjs'),
  getHostAppUrl: () => process.env.ELECTRON_START_URL || mainWindow?.webContents.getURL(),
  sendToRenderer: (channel, payload) => {
    if (isWindowUsable(mainWindow)) mainWindow.webContents.send(channel, payload);
  },
});
const MEMORY_PRESSURE_RSS_BYTES = Number(
  process.env.DROID_MEMORY_PRESSURE_RSS_BYTES ?? 1.5 * 1024 * 1024 * 1024,
);
const powerTier = createPowerTier({
  powerMonitor,
  rssPressureBytes: MEMORY_PRESSURE_RSS_BYTES,
});

app.setName(APP_NAME);
// Must run before the app is ready: the renderer loads transcript images through
// this scheme, and Chromium only treats it as a normal, fetchable origin when it
// is declared up front.
protocol.registerSchemesAsPrivileged([
  {
    scheme: localImages.LOCAL_IMAGE_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);
// Overridable so a second dev instance (e.g. a feature worktree) can run beside
// the main one without fighting over the Chromium profile lock.
app.setPath('userData', userDataOverride || path.join(app.getPath('appData'), APP_NAME));
const hardwareAccelerationPreferencePath = hardwareAccelerationPreferenceFilePath(
  app.getPath('userData'),
);
if (
  !readHardwareAccelerationPreferenceSync({ filePath: hardwareAccelerationPreferencePath }).enabled
) {
  app.disableHardwareAcceleration();
}
const diagnosticsInitialization = diagnostics.initialize();
app.whenReady().then(async () => {
  await diagnosticsInitialization;
  installApplicationMenu({
    Menu,
    app,
    appName: APP_NAME,
    appUpdater,
    reload: reloadShell,
    shell,
    logError: (message) => console.error('[menu] %s', message),
  });
  registerIpc();
  registerLocalImageProtocol();
  createMainWindow();
  powerTier.start();
  const metricsTimer = setInterval(() => performanceMetrics.collect(), 30_000);
  metricsTimer.unref?.();
  powerTier.onChange((tier) => {
    if (isWindowUsable(mainWindow))
      mainWindow.webContents.send('power-tier', { ...powerTier.snapshot(), tier });
  });
  powerTier.onMemoryPressure(() => {
    nativeBrowserManager.evictUnattached();
    terminalManager.trimReplay();
    if (isWindowUsable(mainWindow))
      mainWindow.webContents.send('memory-pressure', { at: Date.now() });
  });
  // Pin the DROIDEX mark on the dock/taskbar up front so OS notifications
  // inherit it instead of the bare Electron atom in dev builds.
  applyAppIcon();
  // Repaint the icon when the OS appearance flips while 'system' is selected.
  nativeTheme.on('updated', () => {
    if (appIconMode === 'system') applyAppIcon();
  });
  void sidecarSupervisor.start().catch((error) => console.error(error));
});

app.on('window-all-closed', () => {
  sidecarSupervisor.stop();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  sidecarSupervisor.stop();
  githubVcs.cancelSetup();
  closeAllDesktopNotifications();
  terminalManager.closeAll();
  terminalSubscriptions.clear();
  filesRootAccess.clear();
});

app.on('activate', () => {
  if (!mainWindow) createMainWindow();
  else focusMainWindow();
  void sidecarSupervisor.start().catch((error) => console.error(error));
  deliverPendingNotificationOpen();
});

app.on('child-process-gone', (_event, details) => {
  const error = new Error(
    `Electron child process exited: type=${details.type} reason=${details.reason} exitCode=${details.exitCode}`,
  );
  console.error(error.message);
  diagnostics.captureException(error, { process: details.type, reason: details.reason });
});

function createMainWindow() {
  const devStartUrl = app.isPackaged ? undefined : process.env.ELECTRON_START_URL;
  const rendererFile = path.join(appRoot(), 'dist/index.html');
  const rendererEntryUrl = devStartUrl || pathToFileURL(rendererFile).toString();
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 600,
    title: APP_NAME,
    icon: path.join(__dirname, 'assets', process.platform === 'darwin' ? 'icon.icns' : 'icon.png'),
    backgroundColor: process.platform === 'darwin' ? '#00000000' : '#0a0a0a',
    vibrancy: process.platform === 'darwin' ? 'under-window' : undefined,
    visualEffectState: 'active',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 14, y: 12 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  installRendererNavigationGuard(mainWindow.webContents, rendererEntryUrl, (url) =>
    shell.openExternal(url),
  );
  installMainRendererLifecycle(mainWindow.webContents);

  if (devStartUrl) mainWindow.loadURL(devStartUrl);
  else mainWindow.loadFile(rendererFile);

  // Re-deliver a queued notification open once the window is actually frontmost
  // and the renderer can receive IPC (critical when coming back from Safari).
  mainWindow.on('focus', () => {
    deliverPendingNotificationOpen();
  });
  mainWindow.on('show', () => {
    deliverPendingNotificationOpen();
  });
  mainWindow.webContents.on('did-finish-load', () => {
    deliverPendingNotificationOpen();
  });

  mainWindow.on('closed', () => {
    rendererOomRecovery.cancel();
    githubVcs.cancelSetup();
    nativeBrowserManager.closeAll();
    terminalManager.closeAll();
    terminalSubscriptions.clear();
    filesRootAccess.clear();
    mainWindow = null;
  });
  powerTier.attachWindow(mainWindow);
}

// Serves local image files to the renderer (see localImages.cjs). Registered on
// the default session only: the Browser pane runs in its own partition, so web
// pages there never gain a local-file reader.
function registerLocalImageProtocol() {
  session.defaultSession.protocol.handle(localImages.LOCAL_IMAGE_SCHEME, async (request) => {
    try {
      const filePath = localImages.localImageRequestPath(request.url);
      const { mime, data } = await localImages.readLocalImage(filePath);
      // no-store: an attachment path can be rewritten in place by a crop, and a
      // cached body would keep showing the superseded pixels.
      // The scheme is fetchable and serves image/svg+xml, so the response denies
      // every subresource and script: an SVG is inert in an <img>, but this keeps
      // it inert if a body is ever navigated to or embedded directly. nosniff
      // stops Chromium from re-typing a body as something executable.
      return new Response(data, {
        headers: {
          'content-type': mime,
          'cache-control': 'no-store',
          'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
          'x-content-type-options': 'nosniff',
        },
      });
    } catch (error) {
      // The renderer degrades to an "image unavailable" chip; the reason is only
      // useful when debugging, so keep it out of the UI and in the log.
      console.warn('Could not serve local image %s:', request.url, error);
      return new Response('Image unavailable', { status: 404 });
    }
  });
}

function registerIpc() {
  ipcMain.handle('bridge-info', (event) => {
    assertMainRenderer(event);
    return sidecarSupervisor.getBridgeInfo();
  });
  ipcMain.handle('sidecar-status', (event) => {
    assertMainRenderer(event);
    return sidecarSupervisor.snapshot();
  });
  ipcMain.handle('pick-directory', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    const selected = result.canceled ? null : (result.filePaths[0] ?? null);
    if (selected) await filesRootAccess.authorize(selected);
    return selected;
  });
  ipcMain.handle('pick-files', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'] });
    return result.canceled ? [] : result.filePaths;
  });
  // Composer image pastes/drops land in a temp dir and travel to Droid as
  // ordinary @-mentioned paths; discard only ever unlinks inside that dir.
  const attachmentsDir = path.join(os.tmpdir(), 'droidex-attachments');
  ipcMain.handle('save-image', (_event, { dataUrl }) => attachments.save(attachmentsDir, dataUrl));
  ipcMain.handle('discard-image', (_event, { path: target }) =>
    attachments.discard(attachmentsDir, target),
  );
  // OS finish/status banners. silent=false plays the system notification sound.
  // Foreground suppress is owned by the renderer; click opens the finished
  // session via the pending-open queue.
  ipcMain.handle('notify', (event, payload = {}) => {
    assertMainRenderer(event);
    const title =
      typeof payload.title === 'string' && payload.title.trim()
        ? payload.title.trim().slice(0, 120)
        : 'DROIDEX';
    const body = typeof payload.body === 'string' ? payload.body.trim().slice(0, 280) : '';
    const silent = payload.silent === true;
    const appSessionId =
      typeof payload.appSessionId === 'string' && payload.appSessionId.trim()
        ? payload.appSessionId.trim().slice(0, 200)
        : null;
    // Dock icon is applied on launch / icon settings; reuse that path for the banner.
    const iconPath = path.join(__dirname, 'assets', resolveAppIconFile(appIconMode));
    return showDesktopNotification(Notification, {
      title,
      body,
      silent,
      ...(fs.existsSync(iconPath) ? { icon: iconPath } : {}),
      // Queue first so focus/show handlers can re-send if this IPC is dropped.
      onActivate: () => queueNotificationSessionOpen(appSessionId),
    });
  });
  // Renderer acks after applying SET_ACTIVE_SESSION so we stop re-delivering.
  ipcMain.handle('notification-activate-ack', (event, payload = {}) => {
    assertMainRenderer(event);
    const appSessionId =
      typeof payload.appSessionId === 'string' ? payload.appSessionId.trim() : '';
    if (
      pendingNotificationOpen &&
      (!appSessionId || pendingNotificationOpen.appSessionId === appSessionId)
    ) {
      pendingNotificationOpen = null;
    }
    return { ok: true };
  });
  // Pull path: renderer asks on focus/visibility in case the push event was lost.
  ipcMain.handle('notification-take-pending', (event) => {
    assertMainRenderer(event);
    return takePendingNotificationOpen();
  });
  ipcMain.handle('get-api-key', getApiKey);
  ipcMain.handle('set-api-key', (_event, { key }) => setApiKey(key));
  ipcMain.handle('clear-api-key', clearApiKey);
  ipcMain.handle('list-files', (_event, { dir }) => listFiles(dir));
  ipcMain.handle('get-performance-metrics', (event) => {
    assertMainRenderer(event);
    return performanceMetrics.collect();
  });
  ipcMain.handle('system-idle-time', (event) => {
    assertMainRenderer(event);
    return powerMonitor.getSystemIdleTime();
  });
  ipcMain.handle('power-tier', (event) => {
    assertMainRenderer(event);
    return powerTier.snapshot();
  });
  ipcMain.handle('read-file', (_event, { path: filePath }) => readFile(filePath));
  ipcMain.handle('repo-status', (_event, { dir }) => repoStatus(dir));
  ipcMain.handle('list-editors', () => listEditors());
  ipcMain.handle('open-project', (_event, { dir, editor, target }) =>
    openProject(dir, editor, target),
  );

  ipcMain.handle('git-environment', (_event, { dir }) => gitVcs.environment(dir));
  ipcMain.handle('git-branches', (_event, { dir }) => gitVcs.branches(dir));
  ipcMain.handle('git-worktrees', (_event, { dir }) => gitVcs.worktrees(dir));
  ipcMain.handle('git-diff-stat', (_event, { dir, options }) => gitVcs.diffStat(dir, options));
  ipcMain.handle('git-diff-files', (_event, { dir, options }) => gitVcs.diffFiles(dir, options));
  ipcMain.handle('git-file-diff', (_event, { dir, options }) => gitVcs.fileDiff(dir, options));
  ipcMain.handle('git-mark-turn-start', (_event, { dir, ownerId }) =>
    gitVcs.markTurnStart(dir, ownerId),
  );
  ipcMain.handle('git-adopt-turn-baseline', (_event, { dir, clientRef, appSessionId }) =>
    gitVcs.adoptTurnBaseline(dir, clientRef, appSessionId),
  );
  ipcMain.handle('git-create-branch', (_event, { dir, options }) =>
    gitVcs.createBranch(dir, options),
  );
  ipcMain.handle('git-checkout', (_event, { dir, options }) => gitVcs.checkout(dir, options));
  ipcMain.handle('git-create-worktree', (_event, { dir, options }) =>
    gitVcs.createWorktree(dir, options),
  );
  ipcMain.handle('git-remove-worktree', (_event, { dir, options }) =>
    gitVcs.removeWorktree(dir, options),
  );
  ipcMain.handle('git-commit', (_event, { dir, options }) => gitVcs.commit(dir, options));
  ipcMain.handle('git-push', (_event, { dir, options }) => gitVcs.push(dir, options));
  ipcMain.handle('git-fetch', (_event, { dir }) => gitVcs.fetchRemotes(dir));

  ipcMain.handle('github-available', (event) => {
    assertMainRenderer(event);
    return githubVcs.available();
  });
  ipcMain.handle('github-install', (event) => {
    assertMainRenderer(event);
    return githubVcs.install();
  });
  ipcMain.handle('github-authenticate', (event) => {
    assertMainRenderer(event);
    return githubVcs.authenticate({
      onDeviceCode: (code) => {
        if (!event.sender.isDestroyed()) event.sender.send('github-auth-code', { code });
      },
    });
  });
  ipcMain.handle('github-cancel-setup', (event) => {
    assertMainRenderer(event);
    githubVcs.cancelSetup();
    return { ok: true };
  });
  ipcMain.handle('github-detect-pr', (event, payload = {}) => {
    assertMainRenderer(event);
    const { dir, options } = payload || {};
    const requestDir = prWorkspaceRequestDir(dir);
    if (!requestDir) return { ok: false, pr: null };
    return githubVcs.detectPr(requestDir, options);
  });
  ipcMain.handle('github-list-prs', (event, payload = {}) => {
    assertMainRenderer(event);
    const { dir, options } = payload || {};
    const requestDir = prWorkspaceRequestDir(dir);
    if (!requestDir) return { ok: false, reason: 'invalid', viewerLogin: null, prs: [] };
    return githubVcs.listPrs(requestDir, options);
  });
  ipcMain.handle('github-view-pr', (event, payload = {}) => {
    assertMainRenderer(event);
    const { dir, options } = payload || {};
    const requestDir = prWorkspaceRequestDir(dir);
    if (!requestDir) return { ok: false, reason: 'invalid', pr: null };
    return githubVcs.viewPr(requestDir, options);
  });
  ipcMain.handle('github-pr-diff', (event, payload = {}) => {
    assertMainRenderer(event);
    const { dir, options } = payload || {};
    const requestDir = prWorkspaceRequestDir(dir);
    if (!requestDir) return { ok: false, reason: 'invalid', diff: '' };
    return githubVcs.prDiff(requestDir, options);
  });
  ipcMain.handle('github-pr-checks', (event, payload = {}) => {
    assertMainRenderer(event);
    const { dir, options } = payload || {};
    const requestDir = prWorkspaceRequestDir(dir);
    if (!requestDir) return { ok: false, reason: 'invalid', checks: [] };
    return githubVcs.prChecks(requestDir, options);
  });
  ipcMain.handle('github-pr-comments', (event, payload = {}) => {
    assertMainRenderer(event);
    const { dir, options } = payload || {};
    const requestDir = prWorkspaceRequestDir(dir);
    if (!requestDir) return { ok: false, reason: 'invalid', comments: [] };
    return githubPrConversation.prComments(requestDir, options);
  });
  ipcMain.handle('github-create-pr', (event, payload = {}) => {
    assertMainRenderer(event);
    const { dir, options } = payload || {};
    const requestDir = prWorkspaceRequestDir(dir);
    if (!requestDir) return { ok: false, reason: 'invalid' };
    return githubVcs.createPr(requestDir, options);
  });
  ipcMain.handle('github-post-comment', (event, payload = {}) => {
    assertMainRenderer(event);
    const { dir, options } = payload || {};
    const requestDir = prWorkspaceRequestDir(dir);
    if (!requestDir) return { ok: false, reason: 'invalid' };
    return githubVcs.postComment(requestDir, options);
  });
  ipcMain.handle('github-merge-pr', (event, payload = {}) => {
    assertMainRenderer(event);
    const { dir, options } = payload || {};
    const requestDir = prWorkspaceRequestDir(dir);
    if (!requestDir) return { ok: false, reason: 'invalid' };
    return githubVcs.mergePr(requestDir, options);
  });

  ipcMain.handle('onboarding-get', getOnboarding);
  ipcMain.handle('onboarding-set', (_event, { patch }) => setOnboarding(patch));
  ipcMain.handle('app-version', () => app.getVersion());
  ipcMain.handle('app-check-update', (event, options) => {
    assertMainRenderer(event);
    return appUpdater.check(options);
  });
  ipcMain.handle('app-download-update', (event) => {
    assertMainRenderer(event);
    return appUpdater.downloadAndInstall();
  });
  ipcMain.handle('feedback-report', async (event, report) => {
    assertMainRenderer(event);
    let screenshotPng = null;
    if (report?.attachments?.screenshot && event.sender && !event.sender.isDestroyed()) {
      try {
        const image = await Promise.race([
          event.sender.capturePage(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('capture timeout')), 3_000)),
        ]);
        if (!image.isEmpty()) {
          const buffer = image.toPNG();
          if (buffer && buffer.length > 0 && buffer.length <= 500_000) {
            screenshotPng = buffer;
          }
        }
      } catch (error) {
        console.error('[feedback] screenshot capture skipped:', error?.message || error);
      }
    }
    return diagnostics.reportFeedback(report, { screenshotPng });
  });
  ipcMain.handle('diagnostics-preference-get', (event) => {
    assertMainRenderer(event);
    return diagnostics.automaticDiagnosticsPreference();
  });
  ipcMain.handle('diagnostics-preference-set', async (event, { enabled }) => {
    assertMainRenderer(event);
    return diagnostics.setAutomaticDiagnosticsEnabled(enabled);
  });
  ipcMain.handle('hardware-acceleration-preference-get', (event) => {
    assertMainRenderer(event);
    return loadHardwareAccelerationPreference({
      filePath: hardwareAccelerationPreferencePath,
      fs: fsp,
    });
  });
  ipcMain.handle('hardware-acceleration-preference-set', async (event, { enabled }) => {
    assertMainRenderer(event);
    return saveHardwareAccelerationPreference({
      filePath: hardwareAccelerationPreferencePath,
      enabled,
      fs: fsp,
    });
  });
  ipcMain.handle('app-relaunch', () => relaunchApp());
  ipcMain.handle('app-set-icon', (event, payload) => {
    assertMainRenderer(event);
    return setAppIcon(payload?.mode);
  });
  ipcMain.handle('open-external', (_event, { url }) => openExternal(url));

  ipcMain.handle('terminal-create', (event, args) => {
    assertMainRenderer(event);
    return terminalManager.create({
      appSessionId: args?.appSessionId,
      cwd: args?.cwd,
      cols: args?.cols,
      rows: args?.rows,
    });
  });
  ipcMain.handle('terminal-resize', (event, { id, cols, rows }) => {
    assertMainRenderer(event);
    terminalManager.resize(id, cols, rows);
  });
  ipcMain.handle('terminal-kill', (event, { id }) => {
    assertMainRenderer(event);
    terminalSubscriptions.unsubscribe(event.sender, id);
    terminalManager.kill(id);
  });
  ipcMain.handle('terminal-list', (event, filter) => {
    assertMainRenderer(event);
    return terminalManager.list({ appSessionId: filter?.appSessionId });
  });
  ipcMain.on('terminal-subscribe', (event, payload) => {
    const port = event.ports?.[0];
    try {
      assertMainRenderer(event);
      const id = payload?.id;
      if (typeof id !== 'string' || id.length === 0) {
        throw new Error('terminal-subscribe requires an id');
      }
      if (!port) throw new Error('terminal-subscribe requires a MessagePort');
      terminalSubscriptions.subscribe(event.sender, id, port);
    } catch (error) {
      if (port) {
        try {
          port.postMessage({
            kind: 'error',
            message: error instanceof Error ? error.message : String(error),
          });
        } catch {
          // port already closed
        }
        try {
          port.close();
        } catch {
          // already closed
        }
      }
    }
  });
  ipcMain.handle('terminal-unsubscribe', (event, { id }) => {
    assertMainRenderer(event);
    terminalSubscriptions.unsubscribe(event.sender, id);
  });
  ipcMain.handle('files-authorize-root', async (event, { root }) => {
    assertMainRenderer(event);
    const authorized = await filesRootAccess.tokenFor(root);
    if (authorized) return authorized;
    const expectedRoot = await files.canonicalDirectory(root);
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Allow Files access to this workspace',
      buttonLabel: 'Allow Files Access',
      defaultPath: expectedRoot,
      properties: ['openDirectory', 'dontAddToRecent'],
    });
    if (result.canceled || !result.filePaths[0]) {
      throw new Error('Files access was not authorized.');
    }
    const selectedRoot = await files.canonicalDirectory(result.filePaths[0]);
    if (selectedRoot !== expectedRoot) {
      throw new Error('Select the current workspace folder to authorize Files access.');
    }
    return filesRootAccess.authorize(selectedRoot);
  });
  ipcMain.handle('files-list', (event, { accessToken, relative }) => {
    assertMainRenderer(event);
    return files.listDirectory(filesRootAccess.resolve(accessToken), relative);
  });
  ipcMain.handle('files-preview', (event, { accessToken, relative }) => {
    assertMainRenderer(event);
    return files.readPreview(filesRootAccess.resolve(accessToken), relative);
  });
  ipcMain.handle('files-open', (event, { accessToken, relative }) => {
    assertMainRenderer(event);
    return files.openDefault(filesRootAccess.resolve(accessToken), relative, shell);
  });
  ipcMain.handle('files-reveal', (event, { accessToken, relative }) => {
    assertMainRenderer(event);
    return files.revealInFolder(filesRootAccess.resolve(accessToken), relative, shell);
  });

  ipcMain.handle('native-browser-open', (event, { browserSessionId, url, bounds, viewport }) => {
    assertMainRenderer(event);
    return nativeBrowserManager.open(browserSessionId, url, bounds, viewport);
  });
  ipcMain.handle('native-browser-attach', (event, { browserSessionId, bounds, url }) => {
    assertMainRenderer(event);
    return nativeBrowserManager.attach(browserSessionId, bounds, { restoreUrl: url });
  });
  ipcMain.handle('native-browser-detach', (event, { browserSessionId }) => {
    assertMainRenderer(event);
    return nativeBrowserManager.detach(browserSessionId);
  });
  ipcMain.handle('native-browser-set-bounds', (event, { browserSessionId, bounds }) => {
    assertMainRenderer(event);
    return nativeBrowserManager.setBounds(browserSessionId, bounds);
  });
  ipcMain.handle('native-browser-visible', (event, { browserSessionId, visible }) => {
    assertMainRenderer(event);
    return nativeBrowserManager.setVisible(browserSessionId, visible);
  });
  ipcMain.handle('native-browser-close', (event, { browserSessionId }) => {
    assertMainRenderer(event);
    return nativeBrowserManager.close(browserSessionId);
  });
  ipcMain.handle('native-browser-reload', (event, { browserSessionId }) => {
    assertMainRenderer(event);
    return nativeBrowserManager.reload(browserSessionId);
  });
  ipcMain.handle('native-browser-go-back', (event, { browserSessionId }) => {
    assertMainRenderer(event);
    return nativeBrowserManager.goBack(browserSessionId);
  });
  ipcMain.handle('native-browser-go-forward', (event, { browserSessionId }) => {
    assertMainRenderer(event);
    return nativeBrowserManager.goForward(browserSessionId);
  });
  ipcMain.handle('native-browser-set-design-mode', (event, { browserSessionId, active }) => {
    assertMainRenderer(event);
    return nativeBrowserManager.setDesignMode(browserSessionId, active);
  });
  ipcMain.handle('native-browser-set-pencil-mode', (event, { browserSessionId, active }) => {
    assertMainRenderer(event);
    return nativeBrowserManager.setPencilMode(browserSessionId, active);
  });
  ipcMain.handle('native-browser-agent-action', (event, { request }) => {
    assertMainRenderer(event);
    return nativeBrowserManager.runAgentAction(request);
  });
  ipcMain.handle('native-browser-capture', (event, { browserSessionId, box, options }) => {
    assertMainRenderer(event);
    return nativeBrowserManager.capture(browserSessionId, box, options);
  });

  ipcMain.on('native-browser-selection', (event, selection) => {
    mainWindow?.webContents.send(
      'native-browser-selection',
      nativeBrowserManager.withSession(event, selection),
    );
  });
  ipcMain.on('native-browser-design-prompt', async (event, payload) => {
    const browserSessionId = nativeBrowserManager.sessionIdForWebContents(event.sender);
    let selection = { ...payload.selection, browserSessionId };
    // Capture the annotated region (pencil strokes, highlights) while it is
    // still on screen so the agent receives the marked screenshot, not a
    // clean page that lost the user's annotations.
    const screenshot = await nativeBrowserManager
      .captureDesignSelection(event.sender, selection)
      .catch(() => undefined);
    if (screenshot) selection = { ...selection, screenshot };
    mainWindow?.webContents.send('native-browser-design-prompt', { ...payload, selection });
    // Echo the capture id so the preload only clears the matching pending
    // capture and ignores acks from superseded prompts.
    event.sender.send('native-browser-design-prompt-sent', { captureId: payload.captureId });
  });
  ipcMain.on('native-browser-agent-result', (_event, result) => {
    mainWindow?.webContents.send('native-browser-agent-result', result);
  });
  ipcMain.on('native-browser-credential-capture', (event, payload) => {
    void nativeBrowserManager.handleCredentialCapture(event.sender, payload);
  });
}

function assertMainRenderer(event) {
  if (
    !mainWindow ||
    event.sender !== mainWindow.webContents ||
    event.senderFrame !== mainWindow.webContents.mainFrame
  ) {
    throw new Error('Desktop request rejected for unknown renderer.');
  }
}

function prWorkspaceRequestDir(value) {
  if (typeof value !== 'string') return null;
  return value.trim() ? value : null;
}

function resolveAppIconFile(mode) {
  const useDark = mode === 'dark' || (mode === 'system' && nativeTheme.shouldUseDarkColors);
  return useDark ? 'icon-dark.png' : 'icon.png';
}

function applyAppIcon() {
  const iconPath = path.join(__dirname, 'assets', resolveAppIconFile(appIconMode));
  if (!fs.existsSync(iconPath)) return;
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(iconPath);
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setIcon(iconPath);
  }
}

function focusMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow();
  }
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  if (process.platform === 'darwin' && app.dock) app.dock.bounce('informational');
}

function queueNotificationSessionOpen(appSessionId) {
  if (!appSessionId) {
    focusMainWindow();
    return;
  }
  pendingNotificationOpen = {
    appSessionId,
    expiresAt: Date.now() + PENDING_NOTIFICATION_OPEN_MS,
  };
  focusMainWindow();
  // Immediate attempt; focus/show/did-finish-load will retry until ack.
  deliverPendingNotificationOpen();
}

function pendingNotificationPayload() {
  if (!pendingNotificationOpen) return null;
  if (Date.now() > pendingNotificationOpen.expiresAt) {
    pendingNotificationOpen = null;
    return null;
  }
  return { appSessionId: pendingNotificationOpen.appSessionId };
}

function deliverPendingNotificationOpen() {
  const payload = pendingNotificationPayload();
  if (!payload || !isWindowUsable(mainWindow)) return;
  mainWindow.webContents.send('notification-activate', payload);
}

/** Return and clear the pending open (renderer pull on focus). */
function takePendingNotificationOpen() {
  const payload = pendingNotificationPayload();
  pendingNotificationOpen = null;
  return payload;
}

function setAppIcon(mode) {
  if (mode !== 'light' && mode !== 'dark' && mode !== 'system') {
    throw new Error('App icon mode must be light, dark, or system.');
  }
  appIconMode = mode;
  applyAppIcon();
  return mode;
}

function reloadShell(ignoreCache) {
  nativeBrowserManager.detach();
  if (!isWindowUsable(mainWindow)) return;
  closeRendererOwnedTerminals();
  if (ignoreCache) mainWindow.webContents.reloadIgnoringCache();
  else mainWindow.webContents.reload();
}

function installMainRendererLifecycle(contents) {
  let hasLoadedMainFrame = false;
  let cleanedForNavigation = false;

  const cleanupForRendererReplacement = () => {
    if (!hasLoadedMainFrame || cleanedForNavigation) return;
    cleanedForNavigation = true;
    githubVcs.cancelSetup();
    closeRendererOwnedTerminals();
  };

  contents.on('did-finish-load', () => {
    hasLoadedMainFrame = true;
    cleanedForNavigation = false;
  });
  contents.on('will-frame-navigate', (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) {
      rendererOomRecovery.cancel();
      cleanupForRendererReplacement();
    }
  });
  contents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) {
      rendererOomRecovery.cancel();
      cleanupForRendererReplacement();
    }
  });
  contents.on('render-process-gone', cleanupForRendererReplacement);
  contents.on('render-process-gone', (_event, details) => {
    const scheduled = rendererOomRecovery.handle(details, () => {
      if (!isWindowUsable(mainWindow) || mainWindow.webContents !== contents) return;
      console.error('[renderer] Reloading after renderer OOM');
      reloadShell(false);
    });
    if (isRendererMemoryExit(details) && !scheduled) {
      console.error('[renderer] Automatic OOM recovery stopped to avoid a reload crash loop');
    }
  });
}

function closeRendererOwnedTerminals() {
  terminalSubscriptions.clear();
  terminalManager.closeAll();
}

function appRoot() {
  // Packaged app files (renderer dist, electron/) live inside app.asar, which
  // Electron resolves transparently for loadFile/loadURL.
  return app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar')
    : path.resolve(__dirname, '..');
}

function sidecarEntry() {
  // The sidecar ships as an extraResource beside the asar so it can be spawned
  // as a plain Node script; an asar path would not survive as a child cwd/argv.
  if (!app.isPackaged && process.env.SIDECAR_ENTRY) return process.env.SIDECAR_ENTRY;
  return app.isPackaged
    ? path.join(process.resourcesPath, 'sidecar/dist/sidecar.mjs')
    : path.join(appRoot(), 'sidecar/dist/sidecar.mjs');
}

function readBuildMetadata() {
  if (!app.isPackaged) {
    return {
      sentryDsn: process.env.SENTRY_DSN || '',
      sparkleFeedUrl: process.env.SPARKLE_FEED_URL || '',
      updateInstallMode: 'sparkle',
    };
  }
  try {
    const metadata = require(path.join(app.getAppPath(), 'package.json'));
    return {
      sentryDsn: typeof metadata.sentryDsn === 'string' ? metadata.sentryDsn : '',
      sparkleFeedUrl: typeof metadata.sparkleFeedUrl === 'string' ? metadata.sparkleFeedUrl : '',
      updateInstallMode: metadata.updateInstallMode === 'automatic' ? 'automatic' : 'sparkle',
    };
  } catch {
    return { sentryDsn: '', sparkleFeedUrl: '', updateInstallMode: 'sparkle' };
  }
}

function isWindowUsable(window) {
  return Boolean(window && !window.isDestroyed());
}

async function getApiKey() {
  try {
    const encrypted = await fsp.readFile(apiKeyPath());
    return safeStorage.decryptString(encrypted);
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
}

async function setApiKey(key) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Electron safeStorage encryption is not available on this system.');
  }
  await fsp.mkdir(path.dirname(apiKeyPath()), { recursive: true });
  await fsp.writeFile(apiKeyPath(), safeStorage.encryptString(key));
}

async function clearApiKey() {
  await fsp.rm(apiKeyPath(), { force: true });
}

function apiKeyPath() {
  return path.join(app.getPath('userData'), 'factory-api-key.bin');
}

// ── Onboarding state ────────────────────────────────────────────────
// Kept in userData (not localStorage) so the first-run tour survives a cache
// clear and only ever shows once.
const ONBOARDING_VERSION = 1;

function onboardingPath() {
  return path.join(app.getPath('userData'), 'onboarding.json');
}

async function getOnboarding() {
  try {
    const raw = await fsp.readFile(onboardingPath(), 'utf8');
    const parsed = JSON.parse(raw);
    return { completed: false, version: ONBOARDING_VERSION, ...parsed };
  } catch {
    return { completed: false, version: ONBOARDING_VERSION };
  }
}

// Serialize read-modify-write so rapid fire-and-forget patches (e.g. two quick
// Settings toggles) can't both read the same old state and clobber each other.
let onboardingWriteQueue = Promise.resolve();

function setOnboarding(patch) {
  const run = onboardingWriteQueue.then(async () => {
    const current = await getOnboarding();
    const next = { ...current, ...(patch || {}), version: ONBOARDING_VERSION };
    await fsp.mkdir(path.dirname(onboardingPath()), { recursive: true });
    await fsp.writeFile(onboardingPath(), JSON.stringify(next, null, 2));
    return next;
  });
  // Keep the queue chained even if this write rejects.
  onboardingWriteQueue = run.catch(() => {});
  return run;
}

function relaunchApp() {
  app.relaunch();
  app.exit(0);
}

function openExternal(url) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    throw new Error('Refusing to open non-http(s) URL.');
  }
  return shell.openExternal(url);
}

async function listFiles(dir) {
  const root = expandHome(dir);
  const rootStat = await fsp.stat(root);
  if (!rootStat.isDirectory()) throw new Error('not a directory');
  const skip = new Set([
    'node_modules',
    '.git',
    'dist',
    'build',
    'target',
    '.next',
    '.cache',
    'out',
  ]);
  const out = [];
  const stack = [root];
  while (stack.length && out.length < 6000) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.') && !skip.has(entry.name)) stack.push(fullPath);
      } else if (entry.isFile()) {
        out.push(path.relative(root, fullPath).split(path.sep).join('/'));
        if (out.length >= 6000) break;
      }
    }
  }
  return out.sort();
}

function readFile(filePath) {
  return fsp.readFile(expandHome(filePath), 'utf8');
}

async function repoStatus(dir) {
  const root = expandHome(String(dir || ''));
  if (!root) return null;
  try {
    const rootStat = await fsp.stat(root);
    if (!rootStat.isDirectory()) return null;
    const [repoRoot, status] = await Promise.all([
      git(root, ['rev-parse', '--show-toplevel']),
      git(root, ['status', '--porcelain=v1', '--branch', '--untracked-files=all']),
    ]);
    return { repoRoot: repoRoot.trim() || null, ...parseGitStatus(status) };
  } catch {
    return null;
  }
}

async function openProject(dir, editor, target) {
  const root = await projectRoot(dir);
  const pathToOpen = target === 'diff' ? await writeDiffFile(root) : root;
  await launchProjectTarget(editor, pathToOpen, root, target);
}

async function projectRoot(dir) {
  const root = expandHome(String(dir || ''));
  if (!root) throw new Error('No project folder selected.');
  const rootStat = await fsp.stat(root);
  if (!rootStat.isDirectory()) throw new Error('Project path is not a directory.');
  try {
    return (await git(root, ['rev-parse', '--show-toplevel'])).trim() || root;
  } catch {
    return root;
  }
}

async function writeDiffFile(root) {
  let diff;
  try {
    diff = await currentGitDiff(root);
  } catch (err) {
    diff = `Unable to read git diff: ${err.message}\n`;
  }
  const dir = path.join(app.getPath('temp'), 'droidex-diffs');
  await fsp.mkdir(dir, { recursive: true });
  const name = (path.basename(root) || 'repo').replace(/[^\w.-]+/g, '-');
  const filePath = path.join(dir, `${name}-${Date.now()}.diff`);
  await fsp.writeFile(filePath, diff || 'No changes.\n', 'utf8');
  return filePath;
}

async function currentGitDiff(root) {
  const parts = [await git(root, ['diff', 'HEAD', '--'])];
  const untracked = (await git(root, ['ls-files', '--others', '--exclude-standard']))
    .split(/\r?\n/)
    .filter(Boolean);
  for (const file of untracked) {
    const diff = await gitDiff(root, ['diff', '--no-index', '--', os.devNull, file]);
    if (diff) parts.push(diff);
  }
  return parts.filter(Boolean).join('\n');
}

async function launchProjectTarget(editor, pathToOpen, root, target) {
  const id = normalizeEditor(editor);
  if (id === 'finder') {
    if (target === 'diff') shell.showItemInFolder(pathToOpen);
    else await openPathOrThrow(pathToOpen);
    return;
  }
  if (id === 'terminal') {
    if (target === 'diff') {
      await openPathOrThrow(pathToOpen);
      return;
    }
    await openTerminal(root);
    return;
  }
  if (id === 'vscode') return openApp('Visual Studio Code', 'code', pathToOpen);
  if (id === 'cursor') return openApp('Cursor', 'cursor', pathToOpen);
  if (id === 'xcode') return openApp('Xcode', 'xed', pathToOpen);
}

async function openPathOrThrow(targetPath) {
  const error = await shell.openPath(targetPath);
  if (error) throw new Error(error);
}

function normalizeEditor(value) {
  return ['vscode', 'cursor', 'finder', 'terminal', 'xcode'].includes(value) ? value : 'vscode';
}

// Report which launch targets are actually installed on this machine so the UI
// only offers editors the user can really open.
function listEditors() {
  if (process.platform === 'darwin') {
    const editors = [];
    if (appBundleExists(['Visual Studio Code.app', 'VSCodium.app'])) editors.push('vscode');
    if (appBundleExists(['Cursor.app'])) editors.push('cursor');
    editors.push('finder', 'terminal');
    if (appBundleExists(['Xcode.app'])) editors.push('xcode');
    return editors;
  }
  const editors = [];
  if (commandOnPath('code')) editors.push('vscode');
  if (commandOnPath('cursor')) editors.push('cursor');
  editors.push('finder', 'terminal');
  return editors;
}

function appBundleExists(bundleNames) {
  const dirs = ['/Applications', path.join(os.homedir(), 'Applications')];
  return bundleNames.some((name) => dirs.some((dir) => fs.existsSync(path.join(dir, name))));
}

function commandOnPath(command) {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  try {
    require('node:child_process').execFileSync(probe, [command], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function openApp(macAppName, command, targetPath) {
  if (process.platform === 'darwin') return spawnDetached('open', ['-a', macAppName, targetPath]);
  return spawnDetached(command, [targetPath]);
}

function openTerminal(root) {
  if (process.platform === 'darwin') return spawnDetached('open', ['-a', 'Terminal', root]);
  if (process.platform === 'win32') return spawnDetached('cmd.exe', ['/k'], { cwd: root });
  return spawnDetached('x-terminal-emulator', ['--working-directory', root]);
}

function spawnDetached(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', cwd: options.cwd });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

function git(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-C', cwd, ...args],
      { timeout: 5000, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) reject(err);
        else resolve(String(stdout));
      },
    );
  });
}

function gitDiff(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-C', cwd, ...args],
      { timeout: 5000, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err && err.code !== 1) reject(err);
        else resolve(String(stdout));
      },
    );
  });
}

function parseGitStatus(stdout) {
  let branch = null;
  let changed = 0;
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  for (const line of String(stdout).split(/\r?\n/)) {
    if (!line) continue;
    if (line.startsWith('## ')) {
      branch = parseGitBranch(line.slice(3));
      continue;
    }
    const x = line[0];
    const y = line[1];
    if (x === '!' && y === '!') continue;
    changed++;
    if (x === '?' && y === '?') {
      untracked++;
      continue;
    }
    if (x !== ' ' && x !== '?') staged++;
    if (y !== ' ' && y !== '?') unstaged++;
  }
  return { branch, changed, staged, unstaged, untracked };
}

function parseGitBranch(value) {
  const text = String(value || '').trim();
  if (text.startsWith('No commits yet on '))
    return text.slice('No commits yet on '.length).trim() || null;
  const branch = text.split('...')[0].trim();
  if (!branch || branch === 'HEAD' || branch.startsWith('HEAD ')) return null;
  return branch;
}

function expandHome(value) {
  if (!value.startsWith('~/')) return value;
  return path.join(app.getPath('home'), value.slice(2));
}
