const os = require('node:os');
const { commitCookieBatch } = require('./browserCookieImport.cjs');
const {
  clearNormalizedCookies,
  discoverChromeProfiles,
  readChromeProfileCookies,
} = require('./browserProfileCookieImportMac.cjs');

const PLAN_SECRETS = new WeakMap();
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

const SAFARI_SIGN_IN_RESULT = Object.freeze({
  status: 'unavailable',
  profiles: Object.freeze([]),
  message: 'Direct Safari cookie import is unavailable because macOS protects Safari website data.',
  recovery: 'Sign in to Safari sites directly inside DROIDEX when you need those accounts.',
});

class BrowserProfileCookieImportError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BrowserProfileCookieImportError';
    this.code = code;
  }
}

class BrowserProfileCookieImportCommitError extends Error {
  constructor(result) {
    super(
      result.importedCount > 0
        ? `Cookie import completed partially: ${result.importedCount} stored and ${result.failedCount} failed.`
        : `Cookie import failed for ${result.failedCount} cookies.`,
    );
    this.name = 'BrowserProfileCookieImportCommitError';
    this.code =
      result.importedCount > 0
        ? 'BROWSER_PROFILE_COOKIE_IMPORT_PARTIAL'
        : 'BROWSER_PROFILE_COOKIE_IMPORT_FAILED';
    this.result = result;
  }
}

async function discoverBrowserCookieProfiles({
  platform = process.platform,
  homeDir = os.homedir(),
} = {}) {
  if (platform !== 'darwin') {
    return freezeDiscovery({
      chrome: unavailableChrome(
        'Direct Chrome profile import is currently available on macOS only.',
      ),
    });
  }

  const profiles = publicChromeProfiles(await discoverChromeProfiles(homeDir));
  return freezeDiscovery({
    chrome:
      profiles.length > 0
        ? {
            status: 'available',
            profiles,
            message: 'Chrome profiles are ready to import with macOS Keychain approval.',
            recovery: null,
          }
        : unavailableChrome('No readable Chrome profiles with a current cookie store were found.'),
  });
}

async function createChromeProfileCookieImportPlan(
  { profileId, cookieStore, platform = process.platform, homeDir = os.homedir(), now = Date.now },
  dependencies = {},
) {
  if (platform !== 'darwin') {
    throw new BrowserProfileCookieImportError(
      'CHROME_PROFILE_IMPORT_UNSUPPORTED_PLATFORM',
      'Direct Chrome profile import is currently available on macOS only.',
    );
  }

  let importedProfile;
  try {
    importedProfile = await readChromeProfileCookies(
      { profileId, homeDir, nowMs: now() },
      dependencies,
    );
  } catch (error) {
    if (error?.code && typeof error.message === 'string') {
      throw new BrowserProfileCookieImportError(error.code, error.message);
    }
    throw new BrowserProfileCookieImportError(
      'CHROME_COOKIE_DATABASE_UNAVAILABLE',
      'Chrome cookies could not be read. Quit Chrome and retry, or use a cookie export.',
    );
  }

  if (importedProfile.cookies.length === 0) {
    throw new BrowserProfileCookieImportError(
      'CHROME_PROFILE_HAS_NO_IMPORTABLE_COOKIES',
      'The selected Chrome profile has no valid, unexpired cookies DROIDEX can import.',
    );
  }
  const affectedDomains = Object.freeze(
    [...new Set(importedProfile.cookies.map((cookie) => cookie.hostname))].sort(),
  );
  const replacementKeys = await findReplacementKeys(cookieStore, importedProfile.cookies);
  const replacementCount = replacementKeys?.size ?? null;
  const preview = Object.freeze({
    source: 'chrome',
    importMethod: 'profile',
    profileId: importedProfile.profile.id,
    profileLabel: importedProfile.profile.label,
    importCount: importedProfile.cookies.length,
    skippedCount: importedProfile.skippedCount,
    replacementCount,
    domainCount: affectedDomains.length,
    affectedDomains,
    keychainApproved: importedProfile.keychainApproved,
  });
  const plan = Object.freeze({ preview });
  PLAN_SECRETS.set(plan, { cookies: importedProfile.cookies, replacementKeys });
  return plan;
}

async function commitChromeProfileCookieImport(plan, { cookieStore }) {
  assertCookieStore(cookieStore);
  const secret = PLAN_SECRETS.get(plan);
  if (!secret) throw new Error('Chrome cookie import plan is invalid, expired, or already used.');

  PLAN_SECRETS.delete(plan);
  let committed;
  try {
    committed = await commitCookieBatch(secret.cookies, {
      cookieKey: normalizedCookieKey,
      dispose: (cookie) => cookie.value.fill(0),
      domain: (cookie) => cookie.hostname,
      replacementKeys: secret.replacementKeys,
      write: (cookie) =>
        cookieStore.set({
          ...cookie.details,
          value: UTF8_DECODER.decode(cookie.value),
        }),
    });
  } finally {
    clearNormalizedCookies(secret.cookies);
    secret.replacementKeys?.clear();
  }

  const result = Object.freeze({
    source: 'chrome',
    importMethod: 'profile',
    profileId: plan.preview.profileId,
    profileLabel: plan.preview.profileLabel,
    importedCount: committed.importedCount,
    failedCount: committed.failedCount,
    skippedCount: plan.preview.skippedCount,
    replacementCount: committed.replacementCount,
    domainCount: committed.domainCount,
    affectedDomains: committed.affectedDomains,
  });
  if (committed.failedCount > 0) throw new BrowserProfileCookieImportCommitError(result);
  return result;
}

function discardChromeProfileCookieImportPlan(plan) {
  const secret = PLAN_SECRETS.get(plan);
  if (!secret) return false;
  clearNormalizedCookies(secret.cookies);
  secret.replacementKeys?.clear();
  PLAN_SECRETS.delete(plan);
  return true;
}

async function findReplacementKeys(cookieStore, cookies) {
  if (!cookieStore || typeof cookieStore.get !== 'function') return null;
  try {
    const existing = await cookieStore.get({});
    if (!Array.isArray(existing)) return null;
    const existingKeys = new Set(existing.map(existingCookieKey).filter(Boolean));
    return new Set(
      cookies.map(normalizedCookieKey).filter((cookieKey) => existingKeys.has(cookieKey)),
    );
  } catch {
    return null;
  }
}

function normalizedCookieKey(cookie) {
  return `${cookie.hostname}\0${cookie.details.path}\0${cookie.details.name}`;
}

function existingCookieKey(cookie) {
  if (!cookie || typeof cookie.name !== 'string' || typeof cookie.path !== 'string')
    return undefined;
  const hostname =
    typeof cookie.domain === 'string' ? cookie.domain.replace(/^\./, '').toLowerCase() : undefined;
  return hostname ? `${hostname}\0${cookie.path}\0${cookie.name}` : undefined;
}

function publicChromeProfiles(profiles) {
  return profiles.map((profile) =>
    Object.freeze({
      id: profile.id,
      label: profile.label,
      isLastUsed: profile.isLastUsed,
    }),
  );
}

function unavailableChrome(message) {
  return {
    status: 'unavailable',
    profiles: [],
    message,
    recovery: 'Open Chrome once and retry, or import a JSON/Netscape cookie export.',
  };
}

function freezeDiscovery(discovery) {
  return Object.freeze({
    chrome: Object.freeze({
      ...discovery.chrome,
      profiles: Object.freeze(discovery.chrome.profiles),
    }),
    safari: SAFARI_SIGN_IN_RESULT,
  });
}

function assertCookieStore(cookieStore) {
  if (!cookieStore || typeof cookieStore.set !== 'function') {
    throw new Error('Browser cookie storage is unavailable.');
  }
}

module.exports = {
  BrowserProfileCookieImportCommitError,
  BrowserProfileCookieImportError,
  commitChromeProfileCookieImport,
  createChromeProfileCookieImportPlan,
  discardChromeProfileCookieImportPlan,
  discoverBrowserCookieProfiles,
};
