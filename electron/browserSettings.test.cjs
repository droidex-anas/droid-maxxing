const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createBrowserSettingsController } = require('./browserSettings.cjs');

async function withController(run) {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'droidex-browser-settings-'));
  const prompts = [];
  const responses = [];
  const openDialogResponses = [];
  const cookies = [];
  const importLifecycle = [];
  const appliedCursorStyles = [];
  const appliedCursorSizes = [];
  const appliedCursorVisibility = [];
  const browserSession = {
    cookies: {
      get: async () => cookies,
      set: async (cookie) => cookies.push(cookie),
      flushStore: async () => importLifecycle.push('flush'),
    },
    clearStorageData: async () => undefined,
    clearCache: async () => undefined,
    clearAuthCache: async () => undefined,
  };
  const controller = createBrowserSettingsController({
    appName: 'DROIDEX',
    userDataPath,
    downloadsPath: path.join(userDataPath, 'Downloads'),
    platform: 'darwin',
    safeStorage: {
      isAsyncEncryptionAvailable: async () => true,
      encryptStringAsync: async (value) => Buffer.from(value),
      decryptStringAsync: async (value) => ({
        result: value.toString(),
        shouldReEncrypt: false,
      }),
    },
    systemPreferences: { canPromptTouchID: () => false },
    dialog: {
      showOpenDialog: async () => openDialogResponses.shift() ?? { canceled: true, filePaths: [] },
    },
    showPrompt: async (prompt) => {
      prompts.push(prompt);
      return { response: responses.shift() ?? prompt.cancelId };
    },
    getWindow: () => undefined,
    getSession: () => browserSession,
    closeBrowsers: () => importLifecycle.push('close'),
    suspendBrowsers: () => importLifecycle.push('suspend'),
    applyAgentCursorStyle: (style) => appliedCursorStyles.push(style),
    applyAgentCursorSize: (size) => appliedCursorSizes.push(size),
    applyAgentCursorVisibility: (isVisible) => appliedCursorVisibility.push(isVisible),
    getWebAuthnCapability: () => ({
      accountSelectionAvailable: true,
      touchIdPasskeysAvailable: true,
      touchIdPasskeysReason: 'available',
    }),
    isNativeBrowserContents: () => true,
    now: () => Date.UTC(2026, 7, 16, 12, 34, 56),
  });
  try {
    await controller.initialize();
    await run({
      browserSession,
      appliedCursorStyles,
      appliedCursorSizes,
      appliedCursorVisibility,
      controller,
      cookies,
      importLifecycle,
      openDialogResponses,
      prompts,
      responses,
      userDataPath,
    });
  } finally {
    await fs.rm(userDataPath, { recursive: true, force: true });
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

test('browser settings default to global autonomy policy, Google, and visible cursor', async () => {
  await withController(
    async ({ appliedCursorSizes, appliedCursorStyles, appliedCursorVisibility, controller }) => {
      const snapshot = await controller.snapshot();
      assert.equal(snapshot.navigationApproval, 'follow_autonomy');
      assert.equal(snapshot.homePage, 'https://www.google.com/');
      assert.equal(snapshot.showAgentCursor, true);
      assert.equal(snapshot.agentCursorStyle, 'droidex');
      assert.equal(snapshot.agentCursorSize, 36);
      assert.equal(controller.agentCursorStyle(), 'droidex');
      assert.equal(snapshot.loginFillApproval, 'always_ask');
      assert.equal(snapshot.keychainAvailable, true);
      assert.deepEqual(snapshot.webAuthn, {
        accountSelectionAvailable: true,
        touchIdPasskeysAvailable: true,
        touchIdPasskeysReason: 'available',
      });
      assert.equal(snapshot.lastCookieImport, null);
      assert.equal('approvedLoginOrigins' in snapshot, false);
      assert.deepEqual(appliedCursorStyles, ['droidex']);
      assert.deepEqual(appliedCursorSizes, [36]);
      assert.deepEqual(appliedCursorVisibility, [true]);
    },
  );
});

test('disabling the agent cursor immediately applies visibility to the live overlay', async () => {
  await withController(async ({ appliedCursorVisibility, controller }) => {
    await controller.update({ showAgentCursor: false });
    assert.deepEqual(appliedCursorVisibility, [true, false]);
  });
});

test('browser settings persist only trusted agent cursor styles', async () => {
  await withController(async ({ appliedCursorStyles, controller, userDataPath }) => {
    const snapshot = await controller.update({ agentCursorStyle: 'dark' });
    assert.equal(snapshot.agentCursorStyle, 'dark');
    assert.equal(controller.agentCursorStyle(), 'dark');
    assert.deepEqual(appliedCursorStyles, ['droidex', 'dark']);

    const persisted = JSON.parse(
      await fs.readFile(path.join(userDataPath, 'browser-settings.json'), 'utf8'),
    );
    assert.equal(persisted.version, 3);
    assert.equal(persisted.agentCursorStyle, 'dark');
    await assert.rejects(
      controller.update({ agentCursorStyle: 'url(https://page.example/cursor.svg)' }),
      /agentCursorStyle has an invalid value/,
    );
  });
});

test('browser settings persist only bounded agent cursor sizes', async () => {
  await withController(async ({ appliedCursorSizes, controller, userDataPath }) => {
    const snapshot = await controller.update({ agentCursorSize: 52 });
    assert.equal(snapshot.agentCursorSize, 52);
    assert.deepEqual(appliedCursorSizes, [36, 52]);

    const persisted = JSON.parse(
      await fs.readFile(path.join(userDataPath, 'browser-settings.json'), 'utf8'),
    );
    assert.equal(persisted.agentCursorSize, 52);
    await assert.rejects(
      controller.update({ agentCursorSize: 65 }),
      /agentCursorSize must be an integer from 24 to 64 pixels/,
    );
  });
});

test('successful Chrome recovery persists and restores a secret-free import receipt', async () => {
  await withController(
    async ({ controller, importLifecycle, openDialogResponses, responses, userDataPath }) => {
      const exportPath = path.join(userDataPath, 'chrome-cookies.json');
      await fs.writeFile(
        exportPath,
        JSON.stringify([
          {
            domain: 'private.example',
            name: 'session-secret-name',
            value: 'session-secret-value',
          },
        ]),
      );
      openDialogResponses.push({ canceled: false, filePaths: [exportPath] });
      responses.push(0);

      const result = await controller.importCookies();
      assert.deepEqual(importLifecycle, ['suspend', 'flush']);
      const expectedReceipt = {
        importedAt: '2026-08-16T12:34:56.000Z',
        source: 'chrome',
        importMethod: 'file',
        profileLabel: 'Chrome export',
        importedCount: 1,
        replacementCount: 0,
        skippedCount: 0,
        failedCount: 0,
        domainCount: 1,
      };

      assert.deepEqual(result.snapshot.lastCookieImport, expectedReceipt);
      const persisted = JSON.parse(
        await fs.readFile(path.join(userDataPath, 'browser-settings.json'), 'utf8'),
      );
      assert.deepEqual(persisted.lastCookieImport, expectedReceipt);
      assert.doesNotMatch(
        JSON.stringify(persisted.lastCookieImport),
        /private\.example|session-secret-name|session-secret-value/,
      );

      await controller.initialize();
      assert.deepEqual((await controller.snapshot()).lastCookieImport, expectedReceipt);
    },
  );
});

test('browser settings reject sensitive or unknown import receipt fields', async () => {
  await withController(async ({ controller, userDataPath }) => {
    await controller.update({ showAgentCursor: false });
    const settingsPath = path.join(userDataPath, 'browser-settings.json');
    const persisted = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
    persisted.lastCookieImport = {
      importedAt: '2026-08-16T12:34:56.000Z',
      source: 'chrome',
      importMethod: 'file',
      profileLabel: 'Chrome export',
      importedCount: 1,
      replacementCount: 0,
      skippedCount: 0,
      failedCount: 0,
      domainCount: 1,
      affectedDomains: ['private.example'],
    };
    await fs.writeFile(settingsPath, JSON.stringify(persisted));

    await assert.rejects(
      controller.initialize(),
      /cookie import receipt contains an unknown field/,
    );
  });
});

test('partial Chrome recovery persists imported and failed counts without cookie metadata', async () => {
  await withController(
    async ({
      browserSession,
      controller,
      cookies,
      openDialogResponses,
      responses,
      userDataPath,
    }) => {
      const exportPath = path.join(userDataPath, 'partial-chrome-cookies.json');
      await fs.writeFile(
        exportPath,
        JSON.stringify([
          { domain: 'first.private', name: 'first-secret-name', value: 'first-secret-value' },
          { domain: 'second.private', name: 'second-secret-name', value: 'second-secret-value' },
        ]),
      );
      browserSession.cookies.set = async (cookie) => {
        if (cookie.name === 'second-secret-name') throw new Error('private cookie failure');
        cookies.push(cookie);
      };
      cookies.push(
        { domain: 'first.private', path: '/', name: 'first-secret-name' },
        { domain: 'second.private', path: '/', name: 'second-secret-name' },
      );
      openDialogResponses.push({ canceled: false, filePaths: [exportPath] });
      responses.push(0);

      await assert.rejects(controller.importCookies(), /partially|stopped/i);
      const receipt = (await controller.snapshot()).lastCookieImport;
      assert.deepEqual(receipt, {
        importedAt: '2026-08-16T12:34:56.000Z',
        source: 'chrome',
        importMethod: 'file',
        profileLabel: 'Chrome export',
        importedCount: 1,
        replacementCount: 1,
        skippedCount: 0,
        failedCount: 1,
        domainCount: 1,
      });
      assert.doesNotMatch(
        JSON.stringify(receipt),
        /first\.private|second\.private|secret-name|secret-value|private cookie failure/,
      );
    },
  );
});

test('browser settings reject impossible cookie import receipt counts', async () => {
  await withController(async ({ controller, userDataPath }) => {
    await controller.recordCookieImport({
      source: 'chrome',
      importMethod: 'file',
      profileLabel: 'Chrome export',
      importedCount: 1,
      replacementCount: 0,
      skippedCount: 0,
      failedCount: 0,
      domainCount: 1,
    });
    const settingsPath = path.join(userDataPath, 'browser-settings.json');
    const persisted = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
    persisted.lastCookieImport.domainCount = 2;
    await fs.writeFile(settingsPath, JSON.stringify(persisted));

    await assert.rejects(controller.initialize(), /cookie import domain count is invalid/);
  });
});

test('browser settings reject replacement receipts that count failed writes', async () => {
  await withController(async ({ controller }) => {
    assert.throws(
      () =>
        controller.recordCookieImport({
          source: 'chrome',
          importMethod: 'file',
          profileLabel: 'Chrome export',
          importedCount: 1,
          replacementCount: 2,
          skippedCount: 0,
          failedCount: 1,
          domainCount: 1,
        }),
      /cookie import replacement count is invalid/,
    );
  });
});

test('follow-autonomy allows high site access but prompts low autonomy with cancel as default', async () => {
  await withController(async ({ controller, prompts }) => {
    await controller.authorizeAgentOrigin('https://example.com/path', 'high');
    assert.equal(prompts.length, 0);
    await assert.rejects(
      controller.authorizeAgentOrigin('https://example.com/path', 'low'),
      /denied/,
    );
    assert.deepEqual(prompts[0].buttons, ['Allow once', 'Cancel']);
    assert.equal(prompts[0].defaultId, 1);
  });
});

test('protection-reducing settings require a main-owned native confirmation', async () => {
  await withController(async ({ controller, prompts, responses }) => {
    let snapshot = await controller.update({ navigationApproval: 'never_ask' });
    assert.equal(snapshot.navigationApproval, 'follow_autonomy');
    assert.equal(prompts[0].defaultId, 1);
    responses.push(0);
    snapshot = await controller.update({ navigationApproval: 'never_ask' });
    assert.equal(snapshot.navigationApproval, 'never_ask');
  });
});

test('agent request validation binds identity, autonomy, master access, and diagnostics', async () => {
  await withController(async ({ controller, responses }) => {
    await assert.rejects(
      controller.authorizeAgentRequest({
        requestId: 'r1',
        appSessionId: 'a1',
        browserSessionId: 'b1',
        action: 'snapshot',
      }),
      /autonomy/,
    );
    await assert.rejects(
      controller.authorizeAgentRequest({
        requestId: 'r2',
        appSessionId: 'a1',
        browserSessionId: 'b1',
        action: 'network',
        autonomy: 'high',
      }),
      /diagnostics are off/,
    );
    await controller.update({ agentAccessEnabled: false });
    responses.push(0);
    await assert.rejects(
      controller.authorizeAgentRequest({
        requestId: 'r3',
        appSessionId: 'a1',
        browserSessionId: 'b1',
        action: 'snapshot',
        autonomy: 'high',
      }),
      /access is off/,
    );
  });
});

test('always-allow microphone permission persists for the exact site and can be revoked', async () => {
  await withController(async ({ controller, prompts, responses, userDataPath }) => {
    responses.push(0);
    await controller.update({ sitePermissionMode: 'ask' });
    responses.push(1);
    const contents = {
      getURL: () => 'https://meet.example/room',
      isDestroyed: () => false,
    };
    const allowed = await new Promise((resolve) => {
      controller.handlePermissionRequest(contents, 'media', resolve, {
        securityOrigin: 'https://meet.example',
        mediaTypes: ['audio'],
      });
    });

    assert.equal(allowed, true);
    assert.deepEqual((await controller.snapshot()).sitePermissionRules, [
      {
        origin: 'https://meet.example',
        camera: 'ask',
        microphone: 'allow',
      },
    ]);
    assert.equal(
      controller.canAccessPermission(contents, 'media', 'https://meet.example', {
        mediaType: 'audio',
      }),
      true,
    );
    assert.match(prompts.at(-1).title, /microphone/i);

    const persisted = JSON.parse(
      await fs.readFile(path.join(userDataPath, 'browser-settings.json'), 'utf8'),
    );
    assert.deepEqual(persisted.sitePermissions, [
      {
        origin: 'https://meet.example',
        camera: 'ask',
        microphone: 'allow',
      },
    ]);

    const revoked = await controller.revokeSiteGrant('microphone', 'https://meet.example');
    assert.deepEqual(revoked.sitePermissionRules, []);
  });
});

test('slow settings snapshots do not block exact-origin or permission persistence', async () => {
  await withController(async ({ browserSession, controller, responses, userDataPath }) => {
    await controller.update({ navigationApproval: 'new_sites' });
    const cookieRead = deferred();
    browserSession.cookies.get = () => cookieRead.promise;

    const rendererUpdate = controller.update({ askDownloadLocation: true });
    responses.push(1);
    await controller.authorizeAgentOrigin('https://trusted.example/path', 'medium');
    await controller.persistSitePermissionDecision({
      origin: 'https://trusted.example',
      mediaTypes: ['audio'],
      decision: 'allow',
    });

    const persisted = JSON.parse(
      await fs.readFile(path.join(userDataPath, 'browser-settings.json'), 'utf8'),
    );
    assert.equal(persisted.askDownloadLocation, true);
    assert.deepEqual(persisted.approvedAgentOrigins, ['https://trusted.example']);
    assert.deepEqual(persisted.sitePermissions, [
      {
        origin: 'https://trusted.example',
        camera: 'ask',
        microphone: 'allow',
      },
    ]);

    cookieRead.resolve([]);
    const snapshot = await rendererUpdate;
    assert.equal(snapshot.askDownloadLocation, true);
  });
});
