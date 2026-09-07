const crypto = require('node:crypto');
const {
  commitBrowserCookieImport,
  createBrowserCookieImportPlan,
  discardBrowserCookieImportPlan,
} = require('./browserCookieImport.cjs');
const defaultProfileImport = require('./browserProfileCookieImport.cjs');

const PROFILE_PLAN_TTL_MS = 120_000;

class BrowserCookieImportFinalizeError extends Error {
  constructor(result) {
    super(
      'Cookies were imported, but browser storage could not be finalized. Restart DROIDEX before relying on the imported session.',
    );
    this.name = 'BrowserCookieImportFinalizeError';
    this.code = 'BROWSER_COOKIE_IMPORT_FINALIZE_FAILED';
    this.result = result;
  }
}

function createBrowserCookieImports(options) {
  const profileImport = options.profileImport ?? defaultProfileImport;
  let preparedProfile = null;

  async function discoverProfiles() {
    return profileImport.discoverBrowserCookieProfiles({
      platform: options.platform,
      homeDir: options.homeDir,
    });
  }

  async function prepareProfile(profileId) {
    profileId = validateOpaqueId(profileId, 'Chrome profile');
    const approval = await options.showPrompt({
      type: 'question',
      buttons: ['Continue', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Import Chrome sign-ins?',
      message: 'Allow DROIDEX to read cookies from the selected Chrome profile?',
      detail:
        'macOS may ask for Chrome Safe Storage access. Cookie values stay in Electron main memory and are never sent to the agent or settings page.',
    });
    if (approval.response !== 0) return { status: 'canceled' };

    discardPreparedProfile();
    let plan;
    try {
      plan = await profileImport.createChromeProfileCookieImportPlan({
        profileId,
        cookieStore: options.getCookieStore(),
        platform: options.platform,
        homeDir: options.homeDir,
      });
    } catch (error) {
      return { status: 'failed', reason: profilePreparationFailureReason(error) };
    }
    const planId = validateOpaqueId(
      (options.nextPlanId ?? crypto.randomUUID)(),
      'Cookie import plan',
    );
    const timer = (options.setTimeout ?? setTimeout)(
      () => discardProfile(planId),
      options.planTtlMs ?? PROFILE_PLAN_TTL_MS,
    );
    preparedProfile = { planId, plan, timer };
    return { status: 'ready', planId, preview: plan.preview };
  }

  async function commitProfile(planId) {
    const prepared = takePreparedProfile(planId);
    try {
      await options.beforeCommit?.();
    } catch (error) {
      profileImport.discardChromeProfileCookieImportPlan(prepared.plan);
      throw error;
    }
    const { imported, snapshot } = await commitAndFinalize('profile', () =>
      profileImport.commitChromeProfileCookieImport(prepared.plan, {
        cookieStore: options.getCookieStore(),
      }),
    );
    return { ...imported, snapshot };
  }

  function discardProfile(planId) {
    if (!preparedProfile || preparedProfile.planId !== planId) return false;
    const prepared = takePreparedProfile(planId);
    return profileImport.discardChromeProfileCookieImportPlan(prepared.plan);
  }

  function discardPreparedProfile() {
    if (!preparedProfile) return false;
    return discardProfile(preparedProfile.planId);
  }

  function takePreparedProfile(planId) {
    planId = validateOpaqueId(planId, 'Cookie import plan');
    if (!preparedProfile || preparedProfile.planId !== planId) {
      throw new Error('Cookie import plan is invalid or expired. Start the import again.');
    }
    const prepared = preparedProfile;
    preparedProfile = null;
    (options.clearTimeout ?? clearTimeout)(prepared.timer);
    return prepared;
  }

  async function importFile() {
    const result = await options.showOpenDialog({
      title: 'Recover from a Chrome cookie export',
      buttonLabel: 'Import Cookies',
      properties: ['openFile', 'dontAddToRecent'],
      filters: [
        { name: 'Cookie exports', extensions: ['json', 'txt', 'cookies'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (result.canceled || !result.filePaths[0]) {
      return { source: 'chrome', canceled: true, snapshot: await options.snapshot() };
    }
    const plan = await createBrowserCookieImportPlan({
      filePath: result.filePaths[0],
      cookieStore: options.getCookieStore(),
    });
    const preview = plan.preview;
    const replacementDetail =
      preview.replacementCount === null
        ? ''
        : ` ${String(preview.replacementCount)} existing ${preview.replacementCount === 1 ? 'cookie' : 'cookies'} will be replaced.`;
    const confirmation = await options.showPrompt({
      type: 'warning',
      buttons: ['Import cookies', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: `Import ${preview.profileLabel} cookies?`,
      message: `Import ${String(preview.importCount)} cookies for ${String(preview.domainCount)} domains?`,
      detail: `${preview.affectedDomains.slice(0, 12).join(', ')}.${replacementDetail} Cookie values stay inside Electron main. Open browser pages close before import so sites reload against the completed update.`,
    });
    if (confirmation.response !== 0) {
      discardBrowserCookieImportPlan(plan);
      return { source: 'chrome', canceled: true, snapshot: await options.snapshot() };
    }
    try {
      await options.beforeCommit?.();
    } catch (error) {
      discardBrowserCookieImportPlan(plan);
      throw error;
    }
    const { imported, snapshot } = await commitAndFinalize('file', () =>
      commitBrowserCookieImport(plan, {
        cookieStore: options.getCookieStore(),
      }),
    );
    return {
      ...imported,
      canceled: false,
      snapshot,
    };
  }

  async function commitAndFinalize(importMethod, commit) {
    let commitError;
    let imported;
    try {
      imported = await commit();
    } catch (error) {
      commitError = error;
      imported = error?.result;
    }

    let receiptError;
    if (imported) {
      try {
        await recordReceipt(importMethod, imported);
      } catch (error) {
        receiptError = error;
      }
    }

    let finalizeError;
    try {
      await options.afterCommit?.();
    } catch (error) {
      finalizeError = error;
    }

    if (commitError) {
      if (finalizeError) commitError.storageFlushFailed = true;
      if (receiptError) commitError.receiptPersistenceFailed = true;
      throw commitError;
    }
    if (receiptError) throw receiptError;
    if (finalizeError) throw new BrowserCookieImportFinalizeError(imported);
    const snapshot = await options.snapshot();
    return { imported, snapshot };
  }

  function recordReceipt(importMethod, result) {
    return options.recordReceipt({
      source: 'chrome',
      importMethod,
      profileLabel: result.profileLabel,
      importedCount: result.importedCount,
      replacementCount: result.replacementCount,
      skippedCount: result.skippedCount,
      failedCount: result.failedCount,
      domainCount: result.domainCount,
    });
  }

  return {
    commitProfile,
    discardAll: discardPreparedProfile,
    discardProfile,
    discoverProfiles,
    importFile,
    prepareProfile,
  };
}

function profilePreparationFailureReason(error) {
  switch (error?.code) {
    case 'CHROME_KEYCHAIN_ACCESS_DENIED':
      return 'keychain_denied';
    case 'CHROME_PROFILE_INVALID':
    case 'CHROME_PROFILE_NOT_FOUND':
      return 'profile_missing';
    case 'CHROME_COOKIE_SCHEMA_UNSUPPORTED':
      return 'schema_unsupported';
    case 'CHROME_PROFILE_HAS_NO_IMPORTABLE_COOKIES':
      return 'no_importable_cookies';
    case 'CHROME_PROFILE_COOKIE_LIMIT_EXCEEDED':
      return 'cookie_limit_exceeded';
    default:
      return 'database_unavailable';
  }
}

function validateOpaqueId(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\0\r\n]/.test(value)) {
    throw new Error(`${label} identifier is invalid.`);
  }
  return value;
}

module.exports = { createBrowserCookieImports };
