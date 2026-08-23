const assert = require('node:assert/strict');
const test = require('node:test');
const { createBrowserCookieImports } = require('./browserCookieImports.cjs');

const preview = Object.freeze({
  source: 'chrome',
  importMethod: 'profile',
  profileId: 'Default',
  profileLabel: 'Personal',
  importCount: 2,
  skippedCount: 0,
  replacementCount: 1,
  domainCount: 1,
  affectedDomains: Object.freeze(['example.com']),
  keychainApproved: true,
});

function fixture(response = 0, prepareErrorCode, overrides = {}) {
  const calls = [];
  const receipts = [];
  let latestReceipt = null;
  const plan = Object.freeze({ preview });
  const controller = createBrowserCookieImports({
    platform: 'darwin',
    getCookieStore: () => ({ get: async () => [], set: async () => undefined }),
    showPrompt: async () => ({ response }),
    showOpenDialog: overrides.showOpenDialog ?? (async () => ({ canceled: true, filePaths: [] })),
    snapshot:
      overrides.snapshot ??
      (async () => ({
        cookieCount: 2,
        ...(latestReceipt ? { lastCookieImport: latestReceipt } : {}),
      })),
    recordReceipt: async (receipt) => {
      receipts.push(receipt);
      latestReceipt = receipt;
      if (overrides.recordReceipt) return overrides.recordReceipt(receipt);
    },
    beforeCommit: overrides.beforeCommit,
    afterCommit: overrides.afterCommit,
    nextPlanId: () => 'opaque-plan-1',
    setTimeout: () => ({ id: 'timer' }),
    clearTimeout: () => undefined,
    profileImport: {
      discoverBrowserCookieProfiles: async () => ({ chrome: { status: 'available' } }),
      createChromeProfileCookieImportPlan: async ({ profileId }) => {
        calls.push(`prepare:${profileId}`);
        if (prepareErrorCode) {
          const error = new Error('private host detail');
          error.code = prepareErrorCode;
          throw error;
        }
        return plan;
      },
      commitChromeProfileCookieImport: async (candidate) => {
        assert.equal(candidate, plan);
        calls.push('commit');
        if (overrides.profileCommit) return overrides.profileCommit();
        return { ...preview, importedCount: 2, failedCount: 0 };
      },
      discardChromeProfileCookieImportPlan: (candidate) => {
        assert.equal(candidate, plan);
        calls.push('discard');
        return true;
      },
    },
  });
  return { calls, controller, receipts };
}

test('file recovery is explicitly Chrome-only and has no browser source selector', async () => {
  let dialogOptions;
  const { controller } = fixture(0, undefined, {
    showOpenDialog: async (options) => {
      dialogOptions = options;
      return { canceled: true, filePaths: [] };
    },
  });

  assert.deepEqual(await controller.importFile(), {
    source: 'chrome',
    canceled: true,
    snapshot: { cookieCount: 2 },
  });
  assert.match(dialogOptions.title, /Chrome cookie export/);
  assert.doesNotMatch(JSON.stringify(dialogOptions), /Safari/i);
});

test('Chrome profile preparation requires app approval and returns only an opaque plan id', async () => {
  const denied = fixture(1);
  assert.deepEqual(await denied.controller.prepareProfile('Default'), { status: 'canceled' });
  assert.deepEqual(denied.calls, []);

  const approved = fixture(0);
  const result = await approved.controller.prepareProfile('Default');
  assert.deepEqual(result, { status: 'ready', planId: 'opaque-plan-1', preview });
  assert.equal(JSON.stringify(result).includes('cookie-value'), false);
});

test('Chrome preparation exposes only a sanitized recovery reason', async () => {
  const cases = [
    ['CHROME_KEYCHAIN_ACCESS_DENIED', 'keychain_denied'],
    ['CHROME_PROFILE_NOT_FOUND', 'profile_missing'],
    ['CHROME_COOKIE_SCHEMA_UNSUPPORTED', 'schema_unsupported'],
    ['CHROME_COOKIE_DATABASE_UNAVAILABLE', 'database_unavailable'],
    ['CHROME_PROFILE_HAS_NO_IMPORTABLE_COOKIES', 'no_importable_cookies'],
    ['CHROME_PROFILE_COOKIE_LIMIT_EXCEEDED', 'cookie_limit_exceeded'],
    ['UNEXPECTED_PRIVATE_FAILURE', 'database_unavailable'],
  ];

  for (const [hostCode, reason] of cases) {
    const { controller } = fixture(0, hostCode);
    assert.deepEqual(await controller.prepareProfile('Default'), { status: 'failed', reason });
  }
});

test('profile plans commit or discard exactly once through their opaque id', async () => {
  const { calls, controller, receipts } = fixture(0);
  await controller.prepareProfile('Default');
  const result = await controller.commitProfile('opaque-plan-1');
  assert.equal(result.importedCount, 2);
  assert.deepEqual(result.snapshot, { cookieCount: 2, lastCookieImport: receipts[0] });
  assert.deepEqual(receipts, [
    {
      source: 'chrome',
      importMethod: 'profile',
      profileLabel: 'Personal',
      importedCount: 2,
      replacementCount: 1,
      skippedCount: 0,
      failedCount: 0,
      domainCount: 1,
    },
  ]);
  assert.equal('affectedDomains' in receipts[0], false);
  await assert.rejects(controller.commitProfile('opaque-plan-1'), /invalid or expired/);
  assert.deepEqual(calls, ['prepare:Default', 'commit']);

  const discarded = fixture(0);
  await discarded.controller.prepareProfile('Default');
  assert.equal(discarded.controller.discardProfile('opaque-plan-1'), true);
  assert.equal(discarded.controller.discardProfile('opaque-plan-1'), false);
  assert.deepEqual(discarded.calls, ['prepare:Default', 'discard']);
});

test('partial profile commits record failed counts before returning the sanitized error', async () => {
  const partialResult = {
    ...preview,
    importedCount: 1,
    failedCount: 1,
  };
  const partialError = new Error('private failure details');
  partialError.result = partialResult;
  const { controller, receipts } = fixture(0, undefined, {
    profileCommit: () => {
      throw partialError;
    },
  });
  await controller.prepareProfile('Default');

  await assert.rejects(controller.commitProfile('opaque-plan-1'), partialError);
  assert.deepEqual(receipts, [
    {
      source: 'chrome',
      importMethod: 'profile',
      profileLabel: 'Personal',
      importedCount: 1,
      replacementCount: 1,
      skippedCount: 0,
      failedCount: 1,
      domainCount: 1,
    },
  ]);
  assert.doesNotMatch(JSON.stringify(receipts), /example\.com|private failure details/);
});

test('cookie commits close live browser views before mutation and flush storage afterward', async () => {
  const calls = [];
  const { controller } = fixture(0, undefined, {
    beforeCommit: async () => calls.push('close'),
    profileCommit: () => {
      calls.push('write');
      return { ...preview, importedCount: 2, failedCount: 0 };
    },
    afterCommit: async () => calls.push('flush'),
  });
  await controller.prepareProfile('Default');
  await controller.commitProfile('opaque-plan-1');
  assert.deepEqual(calls, ['close', 'write', 'flush']);
});

test('a committed import records its receipt once before a storage flush failure', async () => {
  const { controller, receipts } = fixture(0, undefined, {
    afterCommit: async () => {
      throw new Error('private flush detail');
    },
  });
  await controller.prepareProfile('Default');

  let error;
  try {
    await controller.commitProfile('opaque-plan-1');
  } catch (caught) {
    error = caught;
  }

  assert.equal(error?.code, 'BROWSER_COOKIE_IMPORT_FINALIZE_FAILED');
  assert.equal(error?.result?.importedCount, 2);
  assert.equal(error?.result?.failedCount, 0);
  assert.equal(error?.snapshot, undefined);
  assert.equal(receipts.length, 1);
  assert.doesNotMatch(error.message, /private flush detail/);
});

test('successful commits persist, flush, then build the authoritative IPC snapshot', async () => {
  const calls = [];
  const snapshot = { cookieCount: 2, lastCookieImport: { importedCount: 2 } };
  const { controller } = fixture(0, undefined, {
    afterCommit: async () => calls.push('flush'),
    recordReceipt: async () => calls.push('receipt'),
    snapshot: async () => {
      calls.push('snapshot');
      return snapshot;
    },
  });
  await controller.prepareProfile('Default');

  const result = await controller.commitProfile('opaque-plan-1');

  assert.deepEqual(calls, ['receipt', 'flush', 'snapshot']);
  assert.equal(result.snapshot, snapshot);
});
