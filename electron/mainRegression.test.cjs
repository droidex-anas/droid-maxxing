const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const mainSource = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8');
const browserRendererIpcSource = fs.readFileSync(
  path.join(__dirname, 'browserRendererIpc.cjs'),
  'utf8',
);

test('native browser and settings invoke handlers authorize the main renderer', () => {
  const channels = [
    'native-browser-attach',
    'native-browser-detach',
    'native-browser-set-bounds',
    'native-browser-visible',
    'native-browser-go-back',
    'native-browser-go-forward',
    'native-browser-set-design-mode',
    'native-browser-set-pencil-mode',
    'native-browser-agent-action',
    'browser-settings-get',
    'browser-settings-update',
    'browser-cookies-import',
    'browser-cookie-profiles-discover',
    'browser-cookie-profile-import-prepare',
    'browser-cookie-profile-import-commit',
    'browser-cookie-profile-import-discard',
    'browser-data-clear',
    'browser-credential-delete',
    'browser-site-grant-revoke',
    'browser-download-directory-choose',
    'browser-permission-prompt-resolve',
  ];

  for (const channel of channels) {
    assert.match(browserRendererIpcSource, new RegExp(`handle\\('${channel}'`));
  }
  assert.match(
    browserRendererIpcSource,
    /ipcMain\.handle\(channel, \(event, payload\) => \{\s*assertMainRenderer\(event\);/,
  );
  assert.match(mainSource, /registerBrowserRendererIpc\(\{/);
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
    /contents\.on\('will-navigate', \(event, requestedUrl\) => \{[\s\S]*?entry\.failedRestoreUrl = null;[\s\S]*?entry\.targetUrl = requestedUrl;/,
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
    /const reload = chooseBrowserReload\(\{[\s\S]*?currentUrl: contents\.getURL\(\),[\s\S]*?failedRestoreUrl: entry\.failedRestoreUrl,[\s\S]*?targetUrl: entry\.targetUrl,[\s\S]*?homePage: browserSettings\.homePage\(\),[\s\S]*?if \(reload\.kind === 'load'\) \{\s*return loadNativeBrowserUrl\(entry, reload\.url, \{ force: true \}\);/,
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
  const initializeAt = mainSource.indexOf(
    'const diagnosticsInitialization = diagnostics.initialize();',
  );
  const readyAt = mainSource.indexOf('app.whenReady().then(async () =>');
  assert.ok(initializeAt > 0 && initializeAt < readyAt);
  assert.match(
    mainSource,
    /await diagnosticsInitialization;\s*browserWebAuthn\.initialize\(\);\s*try \{\s*await browserSettings\.initialize\(\);\s*\} catch \(error\) \{\s*failBrowserSettingsStartup\(error\);\s*return;\s*\}\s*installApplicationMenu/,
  );
  const failHandlerStart = mainSource.indexOf('function failBrowserSettingsStartup(error) {');
  const failHandlerEnd = mainSource.indexOf('app.whenReady()', failHandlerStart);
  assert.ok(failHandlerStart > 0 && failHandlerStart < failHandlerEnd);
  const failHandler = mainSource.slice(failHandlerStart, failHandlerEnd);
  assert.match(failHandler, /console\.error\(\s*`\[startup\] \$\{detail\}`/);
  assert.match(
    failHandler,
    /dialog\.showErrorBox\(\s*'DROIDEX Browser settings are invalid',\s*detail\)/,
  );
  assert.match(failHandler, /browserSettings\.settingsPath/);
  assert.match(failHandler, /app\.exit\(1\);/);

  for (const channel of ['diagnostics-preference-get', 'diagnostics-preference-set']) {
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
});

test('embedded websites use exact allow-once media grants and deny device access', () => {
  assert.match(mainSource, /ses\.setDevicePermissionHandler\(\(\) => false\)/);
  assert.match(
    mainSource,
    /ses\.setPermissionCheckHandler\([\s\S]*?browserSettings\.canAccessPermission/,
  );
  assert.match(
    mainSource,
    /ses\.setPermissionRequestHandler\([\s\S]*?browserSettings\.handlePermissionRequest/,
  );
  assert.match(mainSource, /browserSettings\.revokePermissionsForNavigation\(contents\)/);
  assert.match(mainSource, /browserSettings\.revokePermissionsForContents\(contents\)/);
});

test('agent browser actions are authorized and executed as one main-process transaction', () => {
  const handlerStart = browserRendererIpcSource.indexOf("handle('native-browser-agent-action'");
  const handlerEnd = browserRendererIpcSource.indexOf('\n\n  handle(', handlerStart + 1);
  const handler = browserRendererIpcSource.slice(handlerStart, handlerEnd);
  assert.match(handler, /await browserSettings\.authorizeAgentRequest\(request\)/);
  assert.match(handler, /await nativeBrowser\.runAgentAction\(request, bounds\)/);
  assert.doesNotMatch(mainSource + browserRendererIpcSource, /native-browser-agent-result/);
});

test('manual address-bar navigation is not mislabeled as an agent origin request', () => {
  assert.match(browserRendererIpcSource, /request\.source === 'user'/);
  assert.match(browserRendererIpcSource, /USER_BROWSER_ACTIONS\.has\(action\)/);
  assert.match(mainSource, /entry\.userNavigationActive/);
});

test('native browser sessions stay bound to their owning DROIDEX chat', () => {
  assert.match(mainSource, /appSessionId: null,/);
  assert.match(
    mainSource,
    /function bindNativeBrowserAppSession\(entry, appSessionId\)[\s\S]*?entry\.appSessionId !== appSessionId[\s\S]*?belongs to a different DROIDEX chat/,
  );
  assert.match(
    mainSource,
    /const entry = ensureNativeBrowserView\(request\.browserSessionId\);\s*bindNativeBrowserAppSession\(entry, request\.appSessionId\);/,
  );
});

test('manual navigation provenance cannot bless page navigations, popups, or later transitions', () => {
  const popupStart = mainSource.indexOf('contents.setWindowOpenHandler');
  const popupEnd = mainSource.indexOf("contents.on('did-create-window'", popupStart);
  const popupHandler = mainSource.slice(popupStart, popupEnd);
  const navigateStart = mainSource.indexOf("contents.on('will-navigate'");
  const navigateEnd = mainSource.indexOf("contents.on('will-redirect'", navigateStart);
  const navigateHandler = mainSource.slice(navigateStart, navigateEnd);

  assert.match(popupHandler, /requiresAgentOriginApproval\('popup'/);
  assert.match(navigateHandler, /requiresAgentOriginApproval\('navigate'/);
  assert.match(mainSource, /requiresAgentOriginApproval\('redirect'/);
  assert.match(mainSource, /agentNavigationAutonomy\(entry\.agentRequest\)/);
  assert.doesNotMatch(mainSource, /lastAgentAutonomy/);
  assert.match(
    mainSource,
    /\.finally\(\(\) => \{\s*if \(!entry\.agentRequest && entry\.pendingAgentNavigation === pending\) \{\s*entry\.pendingAgentNavigation = null;/,
  );
});

test('trusted physical navigation is frame-bound and consumed for only its exact popup or navigation', () => {
  const registrationStart = mainSource.indexOf("ipcMain.on('native-browser-user-navigation'");
  const registrationEnd = mainSource.indexOf('\n  ipcMain.on(', registrationStart + 1);
  const registration = mainSource.slice(registrationStart, registrationEnd);
  const expirationStart = mainSource.indexOf("ipcMain.on('native-browser-user-navigation-expired'");
  const expirationEnd = mainSource.indexOf('\n  ipcMain.on(', expirationStart + 1);
  const expiration = mainSource.slice(expirationStart, expirationEnd);
  const popupStart = mainSource.indexOf('contents.setWindowOpenHandler');
  const popupEnd = mainSource.indexOf("contents.on('did-create-window'", popupStart);
  const popup = mainSource.slice(popupStart, popupEnd);
  const navigateStart = mainSource.indexOf("contents.on('will-navigate'");
  const navigateEnd = mainSource.indexOf("contents.on('will-redirect'", navigateStart);
  const navigate = mainSource.slice(navigateStart, navigateEnd);

  assert.match(registration, /event\.senderFrame !== contents\.mainFrame/);
  assert.match(
    registration,
    /if \(entry\.agentActionActive\) \{\s*entry\.trustedUserNavigation = null;\s*return;/,
  );
  assert.match(registration, /validateUrl\(payload\?\.destinationUrl\)/);
  assert.match(registration, /createTrustedUserNavigation\(\{/);
  assert.match(registration, /browserSessionId: entry\.browserSessionId/);
  assert.match(registration, /view: entry\.view/);
  assert.match(registration, /navigationGeneration: entry\.navigationGeneration/);
  assert.match(registration, /documentGeneration: entry\.documentGeneration/);
  assert.match(expiration, /activationId === payload\?\.activationId/);
  assert.match(popup, /consumeTrustedPhysicalNavigation\(entry, view, nextUrl\)/);
  assert.match(navigate, /consumeTrustedPhysicalNavigation\(entry, view, requestedUrl\)/);
});

test('visible agent actions attach their Browser surface before showing the page-proof cursor', () => {
  const start = mainSource.indexOf('async function runNativeBrowserAgentAction(request, bounds)');
  const end = mainSource.indexOf('\nasync function authorizeNativeBrowserAuthentication', start);
  const action = mainSource.slice(start, end);
  assert.match(
    action,
    /const entry = ensureNativeBrowserView\(request\.browserSessionId\);\s*bindNativeBrowserAppSession\(entry, request\.appSessionId\);\s*if \(bounds\) \{\s*entry\.visible = true;\s*if \(request\.action !== 'open'\) \{\s*await attachNativeBrowser\(request\.browserSessionId, bounds\);\s*\}\s*/,
  );
  assert.match(
    action,
    /} else \{\s*await restoreNativeBrowserForAction\(request\.browserSessionId\);/,
  );
  assert.doesNotMatch(
    action,
    /setBrowserActionActive\(entry, true\);\s*browserAgentCursor\.hide\(entry\.browserSessionId\);/,
    'consecutive actions must preserve the parked point so the cursor can glide from it',
  );
});

test('same browser navigation preserves the parked agent cursor', () => {
  const handlerStart = mainSource.indexOf(
    "contents.on('did-start-navigation'",
    mainSource.indexOf('function ensureNativeBrowserView'),
  );
  const handlerEnd = mainSource.indexOf("contents.on('did-fail-load'", handlerStart);
  const handler = mainSource.slice(handlerStart, handlerEnd);

  assert.doesNotMatch(handler, /browserAgentCursor\.hide/);
  assert.match(
    handler,
    /if \(entry\.view !== view \|\| !isMainFrame\) return;\s*entry\.documentGeneration \+= 1;\s*if \(isInPlace\)/,
  );
  assert.match(handler, /revokePermissionsForNavigation/);
});

test('agent interactions pin the page generation before any authentication policy awaits', () => {
  const actionStart = mainSource.indexOf(
    'async function runNativeBrowserAgentAction(request, bounds)',
  );
  const actionEnd = mainSource.indexOf(
    '\nasync function authorizeNativeBrowserAuthentication',
    actionStart,
  );
  const action = mainSource.slice(actionStart, actionEnd);
  const captureIndex = action.indexOf('const actionDocumentGeneration = entry.documentGeneration;');
  const authorizationIndex = action.indexOf(
    'await authorizeNativeBrowserAuthentication(entry, contents, request);',
  );
  const contextIndex = action.indexOf("'window.__DROIDMAXX_AGENT_CONTEXT?.();'");
  const sensitiveIndex = action.indexOf(
    'await blockBrowserAgentSensitiveTyping(contents, request);',
  );

  assert.ok(captureIndex >= 0 && captureIndex < authorizationIndex);
  assert.ok(captureIndex < contextIndex && contextIndex < authorizationIndex);
  assert.ok(authorizationIndex < sensitiveIndex);
  assert.match(action.slice(authorizationIndex, sensitiveIndex), /assertCurrentActionTarget\(\);/);
  assert.match(
    action.slice(sensitiveIndex),
    /assertCurrentActionTarget\(\);\s*const execution = executeBrowserAgentInteraction/,
  );
  assert.match(action, /isCurrent: isCurrentActionTarget,\s*pageContext,/);
});

test('a snapshot can recreate an invalidated in-page navigation lease', () => {
  const actionStart = mainSource.indexOf(
    'async function runNativeBrowserAgentAction(request, bounds)',
  );
  const actionEnd = mainSource.indexOf(
    '\nasync function authorizeNativeBrowserAuthentication',
    actionStart,
  );
  const action = mainSource.slice(actionStart, actionEnd);
  const snapshotIndex = action.indexOf("if (request.action === 'snapshot')");
  const contextIndex = action.indexOf("'window.__DROIDMAXX_AGENT_CONTEXT?.();'");

  assert.ok(snapshotIndex >= 0 && snapshotIndex < contextIndex);
  assert.match(
    action.slice(snapshotIndex, contextIndex),
    /return await snapshotNativeBrowserAfterNavigation\(contents, request\)/,
  );
});

test('visible open delegates its only attach to openNativeBrowser', () => {
  const actionStart = mainSource.indexOf(
    'async function runNativeBrowserAgentAction(request, bounds)',
  );
  const actionEnd = mainSource.indexOf(
    '\nasync function authorizeNativeBrowserAuthentication',
    actionStart,
  );
  const action = mainSource.slice(actionStart, actionEnd);
  const openStart = mainSource.indexOf('async function openNativeBrowser(');
  const openEnd = mainSource.indexOf('\nasync function attachNativeBrowser(', openStart);
  const open = mainSource.slice(openStart, openEnd);

  assert.match(action, /if \(request\.action !== 'open'\) \{\s*await attachNativeBrowser/);
  assert.match(open, /if \(bounds\) await attachNativeBrowser\(entry\.browserSessionId, bounds/);
  assert.equal(open.match(/await attachNativeBrowser\(/g)?.length, 1);
});

test('failed browser loads and snapshots are never converted to successful actions', () => {
  const snapshotStart = mainSource.indexOf('async function snapshotNativeBrowserAfterNavigation');
  const snapshotEnd = mainSource.indexOf(
    '\nfunction consumeTrustedPhysicalNavigation',
    snapshotStart,
  );
  const snapshot = mainSource.slice(snapshotStart, snapshotEnd);
  const loadStart = mainSource.indexOf('async function loadNativeBrowserUrl');
  const loadEnd = mainSource.indexOf('\nasync function restoreNativeBrowserForAction', loadStart);
  const load = mainSource.slice(loadStart, loadEnd);

  assert.match(snapshot, /requireFreshBrowserSnapshot/);
  assert.doesNotMatch(snapshot, /ok: true/);
  assert.match(load, /isExpectedSupersededLoad/);
  assert.match(load, /throw err/);
});

test('disabled browser diagnostics return before scanning browser entries', () => {
  const start = mainSource.indexOf('function recordNativeBrowserNetworkEvent(details)');
  const end = mainSource.indexOf('\nfunction clearAllNativeBrowserDiagnostics', start);
  const record = mainSource.slice(start, end);
  const guard = record.indexOf('if (!browserSettings.areDiagnosticsEnabled()) return;');
  const scan = record.indexOf('nativeBrowserHost.findEntry(');

  assert.ok(guard >= 0, 'missing diagnostics disabled guard');
  assert.ok(scan > guard, 'browser entry scan must happen after the disabled guard');
});

test('remote DROIDEX browser pages are sandboxed and cross-origin transitions are gated', () => {
  const viewStart = mainSource.indexOf('const view = new WebContentsView');
  const viewEnd = mainSource.indexOf("contents.on('console-message'", viewStart);
  const viewSetup = mainSource.slice(viewStart, viewEnd);
  assert.match(viewSetup, /contextIsolation: true/);
  assert.match(viewSetup, /nodeIntegration: false/);
  assert.match(viewSetup, /sandbox: true/);
  assert.match(viewSetup, /setWindowOpenHandler/);
  assert.match(viewSetup, /consumeAuthenticationPopup/);
  assert.match(viewSetup, /beginAgentNavigationApproval/);
  assert.match(mainSource, /contents\.on\('did-create-window',[\s\S]*?hardenAuthenticationPopup/);
  assert.match(mainSource, /contents\.on\('will-navigate',[\s\S]*?beginAgentNavigationApproval/);
  assert.match(mainSource, /contents\.on\('will-redirect',[\s\S]*?beginAgentNavigationApproval/);
});

test('saved-login capture is bound to the owning main frame and delegated to the capture guard', () => {
  const start = mainSource.indexOf("ipcMain.on('native-browser-credential-capture'");
  const end = mainSource.indexOf('\n  });', start) + 5;
  const handler = mainSource.slice(start, end);
  assert.match(handler, /event\.senderFrame !== contents\.mainFrame/);
  assert.match(handler, /createCredentialCaptureGuard\(entry, contents, url\)/);
  assert.match(handler, /isStillValid,/);
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
