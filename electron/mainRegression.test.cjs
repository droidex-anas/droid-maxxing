const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const mainSource = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8');

test('native browser invoke handlers authorize the main renderer', () => {
  const channels = [
    'native-browser-open',
    'native-browser-attach',
    'native-browser-detach',
    'native-browser-set-bounds',
    'native-browser-visible',
    'native-browser-close',
    'native-browser-reload',
    'native-browser-go-back',
    'native-browser-go-forward',
    'native-browser-set-design-mode',
    'native-browser-set-pencil-mode',
    'native-browser-agent-action',
    'native-browser-capture',
  ];

  for (const channel of channels) {
    const start = mainSource.indexOf(`ipcMain.handle('${channel}'`);
    assert.notEqual(start, -1, `missing ${channel} handler`);
    const nextHandle = mainSource.indexOf('\n  ipcMain.handle(', start + 1);
    const nextListener = mainSource.indexOf('\n  ipcMain.on(', start + 1);
    const end = Math.min(
      ...[nextHandle, nextListener, mainSource.length].filter((index) => index >= 0),
    );
    assert.match(
      mainSource.slice(start, end),
      /assertMainRenderer\(event\)/,
      `${channel} must authorize its sender`,
    );
  }
});

test('native browser restore does not reopen a URL that already failed this run', () => {
  assert.match(mainSource, /targetUrl: null,\s*failedRestoreUrl: null,/);
  assert.match(
    mainSource,
    /function rememberFailedRestoreUrl\(entry, url\) \{\s*if \(entry\.failedRestoreUrl\) return;[\s\S]*?entry\.failedRestoreUrl = restoreUrl;/,
  );
  assert.match(
    mainSource,
    /if \(fallback\) \{\s*rememberFailedRestoreUrl\(entry, entry\.targetUrl \|\| failedUrl\);\s*void loadNativeBrowserUrl\(entry, fallback, \{ force: true \}\);/,
  );
  assert.match(
    mainSource,
    /}\s*rememberFailedRestoreUrl\(entry, entry\.targetUrl \|\| failedUrl\);\s*emitNativeBrowserLoadFailed/,
  );
  assert.match(
    mainSource,
    /contents\.on\('did-navigate', \(_event, loadedUrl\) => \{[\s\S]*?entry\.failedRestoreUrl = null;[\s\S]*?entry\.targetUrl = loadedUrl;/,
  );
  assert.match(
    mainSource,
    /contents\.on\('will-navigate', \(_event, requestedUrl\) => \{[\s\S]*?entry\.failedRestoreUrl = null;[\s\S]*?entry\.targetUrl = requestedUrl;/,
  );
  const nativeDidNavigateStart = mainSource.indexOf("contents.on('did-navigate'");
  const didFinishStart = mainSource.indexOf(
    "contents.on('did-finish-load'",
    nativeDidNavigateStart,
  );
  const didFailStart = mainSource.indexOf("contents.on('did-fail-load'", didFinishStart);
  assert.doesNotMatch(
    mainSource.slice(didFinishStart, didFailStart),
    /entry\.failedRestoreUrl = null/,
  );
  assert.match(
    mainSource,
    /function nativeBrowserUrlsMatch\(left, right\) \{[\s\S]*?new URL\(left\)\.href === new URL\(right\)\.href/,
  );
  assert.match(
    mainSource,
    /function restorableUrlForEntry\(entry, url\) \{[\s\S]*?nativeBrowserUrlsMatch\(entry\.failedRestoreUrl, value\)[\s\S]*?\? undefined/,
  );
  assert.match(
    mainSource,
    /if \(entry\.failedRestoreUrl\) \{\s*const retryUrl = entry\.failedRestoreUrl;\s*entry\.failedRestoreUrl = null;\s*return loadNativeBrowserUrl\(entry, retryUrl, \{ force: true \}\);/,
  );
});

test('main renderer reload closes renderer-owned terminals before navigation', () => {
  const closeRendererOwnedTerminals =
    /function closeRendererOwnedTerminals\(\) \{\s*terminalSubscriptions\.clear\(\);\s*terminalManager\.closeAll\(\);\s*\}/;
  const willFrameNavigateCleanup =
    /contents\.on\('will-frame-navigate', \(_event, _url, isInPlace, isMainFrame\) => \{\s*if \(isMainFrame && !isInPlace\) \{\s*rendererOomRecovery\.cancel\(\);\s*cleanupForRendererReplacement\(\);\s*\}\s*\}\);/;
  const didStartNavigationCleanup =
    /contents\.on\('did-start-navigation', \(_event, _url, isInPlace, isMainFrame\) => \{\s*if \(isMainFrame && !isInPlace\) \{\s*rendererOomRecovery\.cancel\(\);\s*cleanupForRendererReplacement\(\);\s*\}\s*\}\);/;
  const explicitReloadCleanup =
    /function reloadShell\(ignoreCache\) \{\s*detachNativeBrowser\(\);\s*if \(!isWindowUsable\(mainWindow\)\) return;\s*closeRendererOwnedTerminals\(\);/;

  assert.match(mainSource, /installMainRendererLifecycle\(mainWindow\.webContents\)/);
  assert.match(mainSource, closeRendererOwnedTerminals);
  assert.match(mainSource, willFrameNavigateCleanup);
  assert.match(mainSource, didStartNavigationCleanup);
  assert.match(mainSource, /contents\.on\('render-process-gone', cleanupForRendererReplacement\)/);
  assert.match(mainSource, /rendererOomRecovery\.handle\(details,/);
  assert.match(mainSource, /if \(isRendererMemoryExit\(details\) && !scheduled\)/);
  assert.match(mainSource, /reloadShell\(false\)/);
  assert.match(mainSource, explicitReloadCleanup);
});

test('sidecar lifecycle is delegated to the packaged-runtime supervisor', () => {
  assert.match(mainSource, /createSidecarSupervisor\(\{/);
  assert.match(mainSource, /entryPath: sidecarEntry/);
  assert.match(mainSource, /sidecarSupervisor\.getBridgeInfo\(\)/);
  assert.doesNotMatch(mainSource, /NODE_BIN|function nodeBin/);
});

test('bridge credentials require the top-level trusted renderer', () => {
  const handlerStart = mainSource.indexOf("ipcMain.handle('bridge-info'");
  const handlerEnd = mainSource.indexOf('\n  ipcMain.handle(', handlerStart + 1);
  const handler = mainSource.slice(handlerStart, handlerEnd);

  assert.notEqual(handlerStart, -1);
  assert.match(handler, /assertMainRenderer\(event\)/);
  assert.match(mainSource, /event\.senderFrame !== mainWindow\.webContents\.mainFrame/);
  assert.match(mainSource, /installRendererNavigationGuard\(mainWindow\.webContents/);
});

test('manual feedback reports require the trusted renderer', () => {
  const handlerStart = mainSource.indexOf("ipcMain.handle('feedback-report'");
  const handlerEnd = mainSource.indexOf('\n  ipcMain.handle(', handlerStart + 1);
  const handler = mainSource.slice(handlerStart, handlerEnd);

  assert.notEqual(handlerStart, -1);
  assert.match(handler, /assertMainRenderer\(event\)/);
  assert.match(handler, /diagnostics\.reportFeedback\(report,/);
});

test('GitHub setup handlers require the trusted renderer and teardown their process', () => {
  for (const channel of [
    'github-available',
    'github-install',
    'github-authenticate',
    'github-cancel-setup',
  ]) {
    const handlerStart = mainSource.indexOf(`ipcMain.handle('${channel}'`);
    const handlerEnd = mainSource.indexOf('\n  ipcMain.handle(', handlerStart + 1);
    assert.notEqual(handlerStart, -1, `missing ${channel} handler`);
    assert.match(
      mainSource.slice(handlerStart, handlerEnd),
      /assertMainRenderer\(event\)/,
      `${channel} must authorize its sender`,
    );
  }

  const authenticateStart = mainSource.indexOf("ipcMain.handle('github-authenticate'");
  const authenticateEnd = mainSource.indexOf('\n  ipcMain.handle(', authenticateStart + 1);
  const authenticateHandler = mainSource.slice(authenticateStart, authenticateEnd);
  assert.match(authenticateHandler, /onDeviceCode/);
  assert.match(authenticateHandler, /event\.sender\.send\('github-auth-code', \{ code \}\)/);

  assert.match(mainSource, /app\.on\('before-quit',[\s\S]*?githubVcs\.cancelSetup\(\)/);
  const windowClosedStart = mainSource.indexOf("mainWindow.on('closed'");
  const windowClosedEnd = mainSource.indexOf('\n  });', windowClosedStart);
  assert.notEqual(windowClosedStart, -1);
  assert.match(mainSource.slice(windowClosedStart, windowClosedEnd), /githubVcs\.cancelSetup\(\)/);
  assert.match(
    mainSource,
    /const cleanupForRendererReplacement = \(\) => \{[\s\S]*?githubVcs\.cancelSetup\(\)/,
  );
});

test('pull request workspace handlers require the trusted renderer', () => {
  for (const channel of [
    'github-detect-pr',
    'github-list-prs',
    'github-view-pr',
    'github-pr-diff',
    'github-pr-checks',
    'github-pr-comments',
    'github-create-pr',
    'github-post-comment',
    'github-merge-pr',
  ]) {
    const handlerStart = mainSource.indexOf(`ipcMain.handle('${channel}'`);
    const handlerEnd = mainSource.indexOf('\n  ipcMain.handle(', handlerStart + 1);
    assert.notEqual(handlerStart, -1, `missing ${channel} handler`);
    assert.match(
      mainSource.slice(handlerStart, handlerEnd),
      /assertMainRenderer\(event\)/,
      `${channel} must authorize its sender`,
    );
  }
});

test('pull request workspace handlers validate IPC directories before PR operations', () => {
  assert.match(
    mainSource,
    /function prWorkspaceRequestDir\(value\) \{\s*if \(typeof value !== 'string'\) return null;\s*return value\.trim\(\) \? value : null;\s*\}/,
  );

  const expectations = {
    'github-detect-pr':
      /if \(!requestDir\) return \{ ok: false, pr: null \};[\s\S]*?githubVcs\.detectPr\(requestDir, options\)/,
    'github-list-prs':
      /if \(!requestDir\) return \{ ok: false, reason: 'invalid', viewerLogin: null, prs: \[\] \};[\s\S]*?githubVcs\.listPrs\(requestDir, options\)/,
    'github-view-pr':
      /if \(!requestDir\) return \{ ok: false, reason: 'invalid', pr: null \};[\s\S]*?githubVcs\.viewPr\(requestDir, options\)/,
    'github-pr-diff':
      /if \(!requestDir\) return \{ ok: false, reason: 'invalid', diff: '' \};[\s\S]*?githubVcs\.prDiff\(requestDir, options\)/,
    'github-pr-checks':
      /if \(!requestDir\) return \{ ok: false, reason: 'invalid', checks: \[\] \};[\s\S]*?githubVcs\.prChecks\(requestDir, options\)/,
    'github-pr-comments':
      /if \(!requestDir\) return \{ ok: false, reason: 'invalid', comments: \[\] \};[\s\S]*?githubPrConversation\.prComments\(requestDir, options\)/,
    'github-create-pr':
      /if \(!requestDir\) return \{ ok: false, reason: 'invalid' \};[\s\S]*?githubVcs\.createPr\(requestDir, options\)/,
    'github-post-comment':
      /if \(!requestDir\) return \{ ok: false, reason: 'invalid' \};[\s\S]*?githubVcs\.postComment\(requestDir, options\)/,
    'github-merge-pr':
      /if \(!requestDir\) return \{ ok: false, reason: 'invalid' \};[\s\S]*?githubVcs\.mergePr\(requestDir, options\)/,
  };

  for (const [channel, pattern] of Object.entries(expectations)) {
    const handlerStart = mainSource.indexOf(`ipcMain.handle('${channel}'`);
    const handlerEnd = mainSource.indexOf('\n  ipcMain.handle(', handlerStart + 1);
    const handler = mainSource.slice(handlerStart, handlerEnd);
    assert.match(handler, /const requestDir = prWorkspaceRequestDir\(dir\)/);
    assert.match(handler, pattern, channel);
  }
});

test('diagnostics initialize before app readiness and preferences require the trusted renderer', () => {
  const disableAt = mainSource.indexOf('app.disableHardwareAcceleration();');
  const initializeAt = mainSource.indexOf(
    'const diagnosticsInitialization = diagnostics.initialize();',
  );
  const readyAt = mainSource.indexOf('app.whenReady().then(async () =>');
  assert.ok(disableAt > 0 && disableAt < initializeAt);
  assert.ok(initializeAt > 0 && initializeAt < readyAt);
  assert.match(mainSource, /await diagnosticsInitialization;\s*installApplicationMenu/);
  assert.match(
    mainSource,
    /readHardwareAccelerationPreferenceSync\(\{ filePath: hardwareAccelerationPreferencePath \}\)\.enabled/,
  );

  for (const channel of [
    'diagnostics-preference-get',
    'diagnostics-preference-set',
    'hardware-acceleration-preference-get',
    'hardware-acceleration-preference-set',
  ]) {
    const handlerStart = mainSource.indexOf(`ipcMain.handle('${channel}'`);
    const handlerEnd = mainSource.indexOf('\n  ipcMain.handle(', handlerStart + 1);
    assert.notEqual(handlerStart, -1);
    assert.match(mainSource.slice(handlerStart, handlerEnd), /assertMainRenderer\(event\)/);
  }
  const preferenceHandlerStart = mainSource.indexOf("ipcMain.handle('diagnostics-preference-set'");
  const preferenceHandlerEnd = mainSource.indexOf(
    '\n  ipcMain.handle(',
    preferenceHandlerStart + 1,
  );
  const preferenceHandler = mainSource.slice(preferenceHandlerStart, preferenceHandlerEnd);
  assert.match(preferenceHandler, /return diagnostics\.setAutomaticDiagnosticsEnabled\(enabled\)/);
  assert.doesNotMatch(preferenceHandler, /relaunchApp/);

  const hardwareHandlerStart = mainSource.indexOf(
    "ipcMain.handle('hardware-acceleration-preference-set'",
  );
  const hardwareHandlerEnd = mainSource.indexOf('\n  ipcMain.handle(', hardwareHandlerStart + 1);
  const hardwareHandler = mainSource.slice(hardwareHandlerStart, hardwareHandlerEnd);
  assert.match(hardwareHandler, /saveHardwareAccelerationPreference/);
  assert.doesNotMatch(hardwareHandler, /relaunchApp/);
});

test('embedded websites cannot request unused system permissions', () => {
  assert.match(mainSource, /ses\.setDevicePermissionHandler\(\(\) => false\)/);
  assert.match(mainSource, /ses\.setPermissionCheckHandler\(\(\) => false\)/);
  assert.match(
    mainSource,
    /ses\.setPermissionRequestHandler\(\(_webContents, _permission, callback\) => callback\(false\)\)/,
  );
});

test('app icon switching authorizes the renderer and accepts only committed icon modes', () => {
  const handlerStart = mainSource.indexOf("ipcMain.handle('app-set-icon'");
  const handlerEnd = mainSource.indexOf('\n  ipcMain.handle(', handlerStart + 1);
  const handler = mainSource.slice(handlerStart, handlerEnd);

  assert.notEqual(handlerStart, -1);
  assert.match(handler, /assertMainRenderer\(event\)/);
  assert.match(handler, /setAppIcon\(payload\?\.mode\)/);
  assert.match(mainSource, /mode !== 'light' && mode !== 'dark' && mode !== 'system'/);
  assert.match(mainSource, /app\.dock\.setIcon\(iconPath\)/);
  assert.match(mainSource, /mainWindow\.setIcon\(iconPath\)/);
});

test('the local image scheme is privileged before ready and served to the main session only', () => {
  // registerSchemesAsPrivileged is a no-op once the app is ready, so it must sit
  // at module scope; handling it on defaultSession keeps the Browser pane's
  // partition (untrusted web content) without a local-file reader.
  const privilegedIndex = mainSource.indexOf('protocol.registerSchemesAsPrivileged');
  assert.notEqual(privilegedIndex, -1);
  assert.ok(privilegedIndex < mainSource.indexOf('app.whenReady()'));
  assert.match(mainSource, /scheme: localImages\.LOCAL_IMAGE_SCHEME/);
  assert.match(
    mainSource,
    /session\.defaultSession\.protocol\.handle\(localImages\.LOCAL_IMAGE_SCHEME/,
  );
  assert.match(mainSource, /registerLocalImageProtocol\(\);/);
  // A served SVG must not be able to run anything if a body is navigated to or
  // embedded rather than displayed in an <img>.
  assert.match(mainSource, /'content-security-policy': "default-src 'none';/);
  assert.match(mainSource, /'x-content-type-options': 'nosniff'/);
});

test('system app icon tracks the OS appearance and repaints on change', () => {
  assert.match(
    mainSource,
    /mode === 'dark' \|\| \(mode === 'system' && nativeTheme\.shouldUseDarkColors\)/,
  );
  assert.match(mainSource, /useDark \? 'icon-dark\.png' : 'icon\.png'/);
  assert.match(
    mainSource,
    /nativeTheme\.on\('updated', \(\) => \{\s*if \(appIconMode === 'system'\) applyAppIcon\(\);\s*\}\);/,
  );
});
