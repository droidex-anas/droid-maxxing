const fs = require('node:fs');
const path = require('node:path');
const { createBrowserCredentialVault } = require('./browserCredentialVault.cjs');
const { downloadReservationKey, reserveDownloadPath } = require('./browserDownloads.cjs');
const { createBrowserPermissionController } = require('./browserPermissions.cjs');
const { browserPromptFromDialogOptions } = require('./browserPrompt.cjs');
const {
  createBrowserCookieImports,
  serializeCookieImportFailure,
} = require('./browserCookieImports.cjs');
const {
  addExactOrigin,
  createCookieImportReceipt,
  createDefaultBrowserSettings,
  effectiveNavigationApproval,
  exactHttpOrigin,
  readSettings,
  updateSitePermissions,
  validateAgentRequest,
  validateExactOrigin,
  validateSettings,
  validateSettingsPatch,
  weakensBrowserProtection,
  writeSettings,
} = require('./browserSettingsSchema.cjs');

const AUTONOMY_LEVELS = new Set(['off', 'low', 'medium', 'high']);
const DIAGNOSTIC_ACTIONS = new Set(['inspect', 'network', 'console']);

function createBrowserSettingsController(options) {
  return new BrowserSettingsController(options);
}

class BrowserSettingsController {
  constructor(options) {
    this.options = options;
    this.settingsPath = path.join(options.userDataPath, 'browser-settings.json');
    this.settings = undefined;
    this.settingsWriteQueue = Promise.resolve();
    this.reservedDownloadPaths = new Set();
    this.credentials = createBrowserCredentialVault({
      ...options,
      showMessageBox: (dialogOptions) => this.showMessageBox(dialogOptions),
    });
    this.permissions = createBrowserPermissionController({
      isNativeBrowserContents: options.isNativeBrowserContents,
      getSiteDecision: (origin, mediaType) => this.getSitePermissionDecision(origin, mediaType),
      persistSiteDecision: (input) => this.persistSitePermissionDecision(input),
      requestPermission: (input) => this.requestSitePermission(input),
    });
    this.cookieImports = createBrowserCookieImports({
      platform: options.platform,
      getCookieStore: () => this.options.getSession().cookies,
      showPrompt: (dialogOptions) => this.showMessageBox(dialogOptions),
      showOpenDialog: (dialogOptions) => this.showOpenDialog(dialogOptions),
      snapshot: () => this.snapshot(),
      recordReceipt: (receipt) => this.recordCookieImport(receipt),
      beforeCommit: async () => {
        await this.options.suspendBrowsers();
      },
      afterCommit: async () => {
        const cookies = this.options.getSession().cookies;
        if (typeof cookies.flushStore === 'function') await cookies.flushStore();
      },
    });
  }

  async initialize() {
    this.settings = await readSettings(this.settingsPath, this.defaultSettings());
    this.options.applyAgentCursorStyle(this.settings.agentCursorStyle);
    this.options.applyAgentCursorSize(this.settings.agentCursorSize);
    this.options.applyAgentCursorVisibility(this.settings.showAgentCursor);
  }

  async snapshot() {
    const settings = this.requireSettings();
    const [cookies, credentialOrigins, keychainAvailable] = await Promise.all([
      this.options.getSession().cookies.get({}),
      this.credentials.origins(),
      this.credentials.isAvailable(),
    ]);
    return {
      agentAccessEnabled: settings.agentAccessEnabled,
      navigationApproval: settings.navigationApproval,
      loginFillApproval: settings.loginFillApproval,
      diagnosticsEnabled: settings.diagnosticsEnabled,
      sitePermissionMode: settings.sitePermissionMode,
      askDownloadLocation: settings.askDownloadLocation,
      showAgentCursor: settings.showAgentCursor,
      agentCursorStyle: settings.agentCursorStyle,
      agentCursorSize: settings.agentCursorSize,
      homePage: settings.homePage,
      downloadDirectoryLabel:
        settings.downloadDirectory === this.options.downloadsPath
          ? 'System Downloads folder'
          : 'Custom download folder',
      cookieCount: cookies.length,
      credentialOrigins,
      approvedAgentOrigins: [...settings.approvedAgentOrigins].sort(),
      sitePermissionRules: [...settings.sitePermissions].sort((left, right) =>
        left.origin.localeCompare(right.origin),
      ),
      keychainAvailable,
      touchIdAvailable: this.credentials.touchIdAvailable(),
      webAuthn: this.options.getWebAuthnCapability(),
      platform: this.options.platform,
      permissionSummary: {
        camera: settings.sitePermissionMode === 'ask' ? 'ask' : 'blocked',
        microphone: settings.sitePermissionMode === 'ask' ? 'ask' : 'blocked',
        devices: 'blocked',
      },
      lastCookieImport: settings.lastCookieImport ? { ...settings.lastCookieImport } : null,
    };
  }

  async update(patch) {
    const validatedPatch = validateSettingsPatch(patch);
    if (weakensBrowserProtection(this.requireSettings(), validatedPatch)) {
      const response = await this.showMessageBox({
        type: 'warning',
        buttons: ['Apply change', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        title: 'Reduce DROIDEX Browser protection?',
        message: 'This change gives agents or websites more browser access.',
        detail:
          'Passwords, account creation, OAuth consent, and supported OS passkey sheets still require user approval.',
      });
      if (response.response !== 0) return this.snapshot();
    }
    await this.queueSettingsMutation((current) => ({
      ...current,
      ...validatedPatch,
    }));
    if (validatedPatch.agentCursorStyle !== undefined) {
      this.options.applyAgentCursorStyle(validatedPatch.agentCursorStyle);
    }
    if (validatedPatch.agentCursorSize !== undefined) {
      this.options.applyAgentCursorSize(validatedPatch.agentCursorSize);
    }
    if (validatedPatch.showAgentCursor !== undefined) {
      this.options.applyAgentCursorVisibility(validatedPatch.showAgentCursor);
    }
    if (
      validatedPatch.diagnosticsEnabled === false ||
      validatedPatch.agentAccessEnabled === false
    ) {
      this.options.clearBrowserDiagnostics?.();
    }
    return this.snapshot();
  }

  async authorizeAgentRequest(request) {
    const action = this.validateRequest(request);
    if (action === 'close') return true;
    const settings = this.requireSettings();
    if (!settings.agentAccessEnabled) {
      throw new Error('Agent browser access is off. Enable it in Settings > Browser.');
    }
    if (DIAGNOSTIC_ACTIONS.has(action) && !settings.diagnosticsEnabled) {
      throw new Error('Agent browser diagnostics are off. Enable them in Settings > Browser.');
    }
    if (request.url !== undefined) exactHttpOrigin(request.url);
    if (action !== 'close' && !AUTONOMY_LEVELS.has(request.autonomy)) {
      throw new Error('Agent browser request is missing its current autonomy level.');
    }
    if (action === 'open') await this.authorizeAgentOrigin(request.url, request.autonomy);
    return true;
  }

  validateRequest(request) {
    const action = validateAgentRequest(request);
    if (request.url !== undefined) exactHttpOrigin(request.url);
    return action;
  }

  async authorizeAgentOrigin(url, autonomy) {
    const origin = exactHttpOrigin(url);
    const settings = this.requireSettings();
    if (!settings.agentAccessEnabled) {
      throw new Error('Agent browser access is off. Enable it in Settings > Browser.');
    }
    const approval = effectiveNavigationApproval(settings.navigationApproval, autonomy);
    if (approval === 'never_ask') return true;
    if (approval === 'new_sites' && settings.approvedAgentOrigins.includes(origin)) return true;
    const mayPersistGrant = approval === 'new_sites';
    const response = await this.showMessageBox({
      type: 'question',
      buttons: mayPersistGrant
        ? ['Allow once', 'Always allow this site', 'Cancel']
        : ['Allow once', 'Cancel'],
      defaultId: mayPersistGrant ? 2 : 1,
      cancelId: mayPersistGrant ? 2 : 1,
      title: 'Allow agent website access?',
      message: `Allow the agent to open ${origin}?`,
      detail:
        'Approval applies to this exact website origin. Passwords and cookie values remain hidden from the agent.',
    });
    if (response.response === (mayPersistGrant ? 2 : 1)) {
      throw new Error(`Agent website access was denied for ${origin}.`);
    }
    if (mayPersistGrant && response.response === 1) {
      await this.queueSettingsMutation((current) => ({
        ...current,
        approvedAgentOrigins: addExactOrigin(current.approvedAgentOrigins, origin),
      }));
    }
    return true;
  }

  async authorizeAuthenticationAction(intent) {
    const origin = validateExactOrigin(intent?.origin);
    const labels = {
      signup: 'create an account',
      signin: 'submit a sign-in',
      oauth: 'start an OAuth sign-in',
      passkey: 'start a passkey flow',
    };
    const action = labels[intent?.kind];
    if (!action) throw new Error('Unknown browser authentication action.');
    const response = await this.showMessageBox({
      type: 'question',
      buttons: ['Approve once', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Approve DROIDEX authentication action?',
      message: `Allow DROIDEX to ${action} on ${origin}?`,
      detail:
        'This approval is single-use. Passwords remain protected, and any supported OS passkey or provider consent sheet stays under your control.',
    });
    if (response.response !== 0) throw new Error(`Authentication action was denied for ${origin}.`);
    return true;
  }

  async captureCredential({ url, username, password, isStillValid = () => true }) {
    return this.credentials.capture({ url, username, password, isStillValid });
  }

  async credentialForAgent(url) {
    const settings = this.requireSettings();
    if (settings.loginFillApproval === 'never') {
      throw new Error('Saved-login filling is off in Settings > Browser.');
    }
    return this.credentials.credentialForAgent(url);
  }

  async deleteCredential(origin) {
    await this.credentials.delete(origin);
    return this.snapshot();
  }

  async revokeSiteGrant(kind, origin) {
    origin = validateExactOrigin(origin);
    if (kind === 'camera' || kind === 'microphone') {
      const mediaType = kind === 'camera' ? 'video' : 'audio';
      await this.permissions.setSiteDecision(origin, [mediaType], 'ask');
      return this.snapshot();
    }
    if (kind !== 'agent_navigation') throw new Error('Unknown browser site grant.');
    await this.queueSettingsMutation((current) => ({
      ...current,
      approvedAgentOrigins: current.approvedAgentOrigins.filter(
        (candidate) => candidate !== origin,
      ),
    }));
    return this.snapshot();
  }

  async importCookies() {
    return withSerializedImportFailure(() => this.cookieImports.importFile());
  }

  recordCookieImport(receipt) {
    const validated = createCookieImportReceipt(
      receipt,
      this.options.now ? this.options.now() : Date.now(),
    );
    return this.queueSettingsMutation((current) => ({
      ...current,
      lastCookieImport: validated,
    }));
  }

  discoverCookieProfiles() {
    return this.cookieImports.discoverProfiles();
  }

  prepareCookieProfileImport(profileId) {
    return this.cookieImports.prepareProfile(profileId);
  }

  commitCookieProfileImport(planId) {
    return withSerializedImportFailure(() => this.cookieImports.commitProfile(planId));
  }

  discardCookieProfileImport(planId) {
    return this.cookieImports.discardProfile(planId);
  }

  async clearBrowsingData() {
    this.cookieImports.discardAll();
    this.options.closeBrowsers();
    const browserSession = this.options.getSession();
    await browserSession.clearStorageData({
      storages: ['cookies', 'localstorage', 'indexdb', 'serviceworkers', 'cachestorage'],
    });
    await browserSession.clearCache();
    if (typeof browserSession.clearAuthCache === 'function') await browserSession.clearAuthCache();
    return this.snapshot();
  }

  async chooseDownloadDirectory() {
    const result = await this.showOpenDialog({
      title: 'Choose browser download folder',
      buttonLabel: 'Choose',
      properties: ['openDirectory', 'createDirectory', 'dontAddToRecent'],
    });
    if (!result.canceled && result.filePaths[0]) {
      const selected = path.resolve(result.filePaths[0]);
      await this.queueSettingsMutation((current) => ({
        ...current,
        downloadDirectory: selected,
      }));
    }
    return this.snapshot();
  }

  prepareDownload(item) {
    const settings = this.requireSettings();
    if (settings.askDownloadLocation) return;
    fs.mkdirSync(settings.downloadDirectory, { recursive: true });
    const savePath = reserveDownloadPath(
      settings.downloadDirectory,
      item.getFilename(),
      this.reservedDownloadPaths,
    );
    item.once('done', () => this.reservedDownloadPaths.delete(downloadReservationKey(savePath)));
    item.setSavePath(savePath);
  }

  canAccessPermission(contents, permission, requestingOrigin, details) {
    if (this.requireSettings().sitePermissionMode !== 'ask') return false;
    return this.permissions.canAccess(contents, permission, requestingOrigin, details);
  }

  handlePermissionRequest(contents, permission, callback, details) {
    if (this.requireSettings().sitePermissionMode !== 'ask') return callback(false);
    this.permissions.handleRequest(contents, permission, callback, details);
  }

  getSitePermissionDecision(origin, mediaType) {
    const settings = this.requireSettings();
    if (settings.sitePermissionMode !== 'ask') return 'deny';
    const rule = settings.sitePermissions.find((candidate) => candidate.origin === origin);
    return rule?.[mediaType === 'audio' ? 'microphone' : 'camera'] ?? 'ask';
  }

  persistSitePermissionDecision({ origin, mediaTypes, decision }) {
    return this.queueSettingsMutation((current) => ({
      ...current,
      sitePermissions: updateSitePermissions(current.sitePermissions, {
        origin,
        mediaTypes,
        decision,
      }),
    }));
  }

  async requestSitePermission({ promptId, origin, mediaTypes, signal }) {
    const label =
      mediaTypes.length === 2
        ? 'camera and microphone'
        : mediaTypes[0] === 'video'
          ? 'camera'
          : 'microphone';
    const response = await this.showMessageBox(
      {
        type: 'question',
        buttons: ['Allow once', 'Always allow this site', 'Block once', 'Always block this site'],
        defaultId: 2,
        cancelId: 2,
        title: `Allow ${label}?`,
        message: `${origin} wants to use your ${label}.`,
        detail:
          'This applies only to this exact website. macOS may also show its required first-use privacy confirmation.',
      },
      { signal },
    );
    const decisions = ['allow_once', 'allow_always', 'deny_once', 'deny_always'];
    return { promptId, decision: decisions[response.response] ?? 'deny_once' };
  }

  revokePermissionsForNavigation(contents) {
    this.permissions.revokeForNavigation(contents);
  }

  revokePermissionsForContents(contents) {
    this.permissions.revokeForContents(contents);
  }

  agentCursorStyle() {
    return this.requireSettings().agentCursorStyle;
  }

  agentCursorSize() {
    return this.requireSettings().agentCursorSize;
  }

  areDiagnosticsEnabled() {
    const settings = this.requireSettings();
    return settings.agentAccessEnabled && settings.diagnosticsEnabled;
  }

  homePage() {
    return this.requireSettings().homePage;
  }

  defaultSettings() {
    return createDefaultBrowserSettings(this.options.downloadsPath);
  }

  requireSettings() {
    if (!this.settings) throw new Error('Browser settings are not initialized.');
    return this.settings;
  }

  queueSettingsMutation(update) {
    const run = this.settingsWriteQueue.then(async () => {
      const next = validateSettings(update(this.requireSettings()), this.defaultSettings());
      await writeSettings(this.settingsPath, next);
      this.settings = next;
      return next;
    });
    this.settingsWriteQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  showMessageBox(options, requestOptions) {
    return this.options.showPrompt(browserPromptFromDialogOptions(options), requestOptions);
  }

  showOpenDialog(options) {
    const owner = this.options.getWindow();
    return owner
      ? this.options.dialog.showOpenDialog(owner, options)
      : this.options.dialog.showOpenDialog(options);
  }
}

async function withSerializedImportFailure(run) {
  try {
    return await run();
  } catch (error) {
    throw serializeCookieImportFailure(error);
  }
}

module.exports = {
  createBrowserSettingsController,
  exactHttpOrigin,
  validateSettings,
  validateSettingsPatch,
};
