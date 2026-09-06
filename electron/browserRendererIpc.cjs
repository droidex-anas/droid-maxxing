const USER_BROWSER_ACTIONS = new Set(['open', 'reload', 'resize']);

function registerBrowserRendererIpc(options) {
  const { ipcMain, assertMainRenderer, browserSettings, browserPrompts, nativeBrowser } = options;

  function handle(channel, operation) {
    ipcMain.handle(channel, (event, payload) => {
      assertMainRenderer(event);
      return operation(payload ?? {});
    });
  }

  handle('native-browser-attach', ({ browserSessionId, bounds, url }) =>
    nativeBrowser.attach(browserSessionId, bounds, { restoreUrl: url }),
  );
  handle('native-browser-detach', ({ browserSessionId }) => nativeBrowser.detach(browserSessionId));
  handle('native-browser-set-bounds', ({ browserSessionId, bounds }) =>
    nativeBrowser.setBounds(browserSessionId, bounds),
  );
  handle('native-browser-visible', ({ browserSessionId, visible }) =>
    nativeBrowser.setVisible(browserSessionId, visible),
  );
  handle('native-browser-go-back', ({ browserSessionId }) =>
    nativeBrowser.navigateHistory(browserSessionId, 'back'),
  );
  handle('native-browser-go-forward', ({ browserSessionId }) =>
    nativeBrowser.navigateHistory(browserSessionId, 'forward'),
  );
  handle('native-browser-set-design-mode', ({ browserSessionId, active }) =>
    nativeBrowser.setDesignMode(browserSessionId, active),
  );
  handle('native-browser-set-pencil-mode', ({ browserSessionId, active }) =>
    nativeBrowser.setPencilMode(browserSessionId, active),
  );
  handle('native-browser-agent-action', async ({ request }) => {
    const action = browserSettings.validateRequest(request);
    if (request.source === 'user') {
      if (!USER_BROWSER_ACTIONS.has(action)) {
        throw new Error('This browser action cannot claim direct user navigation.');
      }
    }
    const result = await nativeBrowser.runAgentAction(request);
    return {
      ...result,
      appSessionId: request.appSessionId,
      browserSessionId: request.browserSessionId,
    };
  });

  handle('browser-settings-get', () => browserSettings.snapshot());
  handle('browser-settings-update', ({ patch }) => browserSettings.update(patch));
  handle('browser-cookies-import', () => browserSettings.importCookies());
  handle('browser-cookie-profiles-discover', () => browserSettings.discoverCookieProfiles());
  handle('browser-cookie-profile-import-prepare', ({ profileId }) =>
    browserSettings.prepareCookieProfileImport(profileId),
  );
  handle('browser-cookie-profile-import-commit', ({ planId }) =>
    browserSettings.commitCookieProfileImport(planId),
  );
  handle('browser-cookie-profile-import-discard', ({ planId }) =>
    browserSettings.discardCookieProfileImport(planId),
  );
  handle('browser-data-clear', () => browserSettings.clearBrowsingData());
  handle('browser-credential-delete', ({ origin }) => browserSettings.deleteCredential(origin));
  handle('browser-site-grant-revoke', ({ kind, origin }) =>
    browserSettings.revokeSiteGrant(kind, origin),
  );
  handle('browser-download-directory-choose', () => browserSettings.chooseDownloadDirectory());
  handle('browser-permission-prompt-resolve', ({ requestId, response }) =>
    browserPrompts.resolve(requestId, response),
  );
}

module.exports = { registerBrowserRendererIpc };
