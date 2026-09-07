import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  commitBrowserCookieProfileImport,
  discardBrowserCookieProfileImport,
  discoverBrowserCookieProfiles,
  formatCookieProfileImportSummary,
  prepareBrowserCookieProfileImport,
  type BrowserCookieProfileDiscovery,
  type BrowserCookieProfileImportPreview,
  type BrowserSettingsSnapshot,
} from '../../lib/browserSettings.js';
import {
  BrowserProfileImportPreview,
  BrowserProfileImportSelection,
} from './BrowserProfileImportContent.js';
import {
  browserCookieImportCommitFailureMessage,
  browserProfileImportFailureMessage,
} from './BrowserProfileImportDialog.js';

const noop = () => undefined;

const DISCOVERY: BrowserCookieProfileDiscovery = {
  chrome: {
    status: 'available',
    profiles: [
      { id: 'Default', label: 'Personal', isLastUsed: true },
      { id: 'Profile 1', label: 'Work', isLastUsed: false },
    ],
    message: 'Chrome profiles are ready to import with macOS Keychain approval.',
    recovery: null,
  },
  safari: {
    status: 'unavailable',
    profiles: [],
    message:
      'Direct Safari cookie import is unavailable because macOS protects Safari website data.',
    recovery: 'Sign in to Safari sites directly inside DROIDEX when you need those accounts.',
  },
};

const SNAPSHOT: BrowserSettingsSnapshot = {
  agentAccessEnabled: true,
  navigationApproval: 'new_sites',
  loginFillApproval: 'always_ask',
  diagnosticsEnabled: false,
  sitePermissionMode: 'ask',
  askDownloadLocation: true,
  showAgentCursor: true,
  agentCursorStyle: 'droidex',
  homePage: 'https://www.google.com/',
  downloadDirectoryLabel: 'Downloads',
  cookieCount: 8,
  credentialOrigins: [],
  approvedAgentOrigins: [],
  sitePermissionRules: [],
  keychainAvailable: true,
  touchIdAvailable: true,
  webAuthn: {
    accountSelectionAvailable: true,
    touchIdPasskeysAvailable: true,
    touchIdPasskeysReason: 'available',
  },
  platform: 'darwin',
  permissionSummary: { camera: 'ask', microphone: 'ask', devices: 'blocked' },
  lastCookieImport: null,
};

test('profile selection keeps Safari sign-in separate from Chrome file recovery', () => {
  const discoveryWithUnexpectedSecret = Object.assign({}, DISCOVERY, {
    cookieValue: 'never-render-this',
  });
  const html = renderToStaticMarkup(
    createElement(BrowserProfileImportSelection, {
      discovery: discoveryWithUnexpectedSecret,
      selectedProfileId: 'Default',
      disabled: false,
      onSelect: noop,
      onRetry: noop,
      onChromeRecovery: noop,
    }),
  );

  assert.match(html, /Chrome profiles/);
  assert.match(html, /Personal/);
  assert.match(html, /Last used in Chrome/);
  assert.match(html, /macOS Keychain approval/);
  assert.match(html, /Recovery/);
  assert.match(html, /Safari does not provide a cookie export/);
  assert.match(html, /Sign in to the site once inside DROIDEX/);
  assert.match(html, /Chrome file recovery/);
  assert.match(html, /Import Chrome cookie file/);
  assert.doesNotMatch(html, /never-render-this/);
});

test('unavailable profile recovery explains the next action instead of dumping users into Finder', () => {
  const discovery: BrowserCookieProfileDiscovery = {
    chrome: {
      status: 'unavailable',
      profiles: [],
      message: 'No readable Chrome profiles were found.',
      recovery: 'Open Chrome once and retry.',
    },
    safari: DISCOVERY.safari,
  };
  const html = renderToStaticMarkup(
    createElement(BrowserProfileImportSelection, {
      discovery,
      selectedProfileId: '',
      disabled: false,
      onSelect: noop,
      onRetry: noop,
      onChromeRecovery: noop,
    }),
  );

  assert.match(html, /Retry Chrome detection/);
  assert.match(html, /Safari does not provide a cookie export/);
  assert.match(html, /Only use a JSON or Netscape cookie file you already created/);
  assert.match(html, /Import Chrome cookie file/);
  assert.doesNotMatch(html, /Choose export/);
});

test('profile preview renders only confirmation metadata and truncates long domain lists', () => {
  const preview: BrowserCookieProfileImportPreview = {
    source: 'chrome',
    importMethod: 'profile',
    profileId: 'Default',
    profileLabel: 'Personal',
    importCount: 12,
    skippedCount: 3,
    replacementCount: 4,
    domainCount: 5,
    affectedDomains: ['a.example', 'b.example', 'c.example', 'd.example', 'e.example'],
    keychainApproved: true,
  };
  const previewWithUnexpectedSecret = Object.assign({}, preview, {
    cookieName: 'session',
    cookieValue: 'never-render-this',
  });

  const html = renderToStaticMarkup(
    createElement(BrowserProfileImportPreview, { preview: previewWithUnexpectedSecret }),
  );

  assert.match(html, /12 importable cookies across 5 domains/);
  assert.match(html, /Existing cookies replaced/);
  assert.match(html, />4</);
  assert.match(html, /Skipped safely/);
  assert.match(html, />3</);
  assert.match(html, /a\.example/);
  assert.match(html, /\+1 more/);
  assert.match(html, /Cookie names and values remain private to Electron main/);
  assert.match(html, /open browser pages close before import/);
  assert.doesNotMatch(html, /session|never-render-this/);
});

test('profile import wrappers use the main-owned plan bridge without cookie data', async () => {
  const calls: string[] = [];
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      droidControl: {
        browserCookieProfilesDiscover: async () => {
          calls.push('discover');
          return DISCOVERY;
        },
        browserCookieProfileImportPrepare: async (profileId: string) => {
          calls.push(`prepare:${profileId}`);
          return {
            status: 'ready',
            planId: 'opaque-plan-id',
            preview: {
              source: 'chrome',
              importMethod: 'profile',
              profileId,
              profileLabel: 'Personal',
              importCount: 2,
              skippedCount: 0,
              replacementCount: 1,
              domainCount: 1,
              affectedDomains: ['example.com'],
              keychainApproved: true,
            },
          };
        },
        browserCookieProfileImportCommit: async (planId: string) => {
          calls.push(`commit:${planId}`);
          return {
            source: 'chrome',
            importMethod: 'profile',
            profileId: 'Default',
            profileLabel: 'Personal',
            importedCount: 2,
            failedCount: 0,
            skippedCount: 0,
            replacementCount: 1,
            domainCount: 1,
            affectedDomains: ['example.com'],
            snapshot: SNAPSHOT,
          };
        },
        browserCookieProfileImportDiscard: async (planId: string) => {
          calls.push(`discard:${planId}`);
          return true;
        },
      },
    },
  });
  try {
    assert.deepEqual(await discoverBrowserCookieProfiles(), DISCOVERY);
    const prepared = await prepareBrowserCookieProfileImport('Default');
    assert.equal(prepared.status, 'ready');
    if (prepared.status !== 'ready') throw new Error('expected prepared profile import');
    assert.deepEqual(Object.keys(prepared), ['status', 'planId', 'preview']);
    assert.doesNotMatch(JSON.stringify(prepared), /cookieValue|session|secret/);
    const result = await commitBrowserCookieProfileImport(prepared.planId);
    assert.equal(result.importedCount, 2);
    assert.equal(await discardBrowserCookieProfileImport(prepared.planId), true);
    assert.deepEqual(calls, [
      'discover',
      'prepare:Default',
      'commit:opaque-plan-id',
      'discard:opaque-plan-id',
    ]);
  } finally {
    Reflect.deleteProperty(globalThis, 'window');
  }
});

test('profile preparation failures show specific sanitized recovery without false Keychain blame', () => {
  assert.match(browserProfileImportFailureMessage('keychain_denied'), /macOS Keychain/);
  assert.match(browserProfileImportFailureMessage('profile_missing'), /no longer available/);
  assert.match(browserProfileImportFailureMessage('schema_unsupported'), /Update DROIDEX/);
  assert.match(browserProfileImportFailureMessage('database_unavailable'), /Quit Chrome/);
  assert.doesNotMatch(browserProfileImportFailureMessage('database_unavailable'), /Keychain/i);
  assert.match(browserProfileImportFailureMessage('no_importable_cookies'), /no valid, unexpired/);
  assert.match(browserProfileImportFailureMessage('cookie_limit_exceeded'), /5,000 cookies/);
});

test('post-commit import failures report completed cookies without exposing host errors', () => {
  const fallback = 'Some cookies may already be imported.';
  const completedImport = new Error(
    "Error invoking remote method 'browser-cookie-profile-import-commit': Error: Cookies were imported, but the import receipt could not be saved. Verify the imported sites before retrying; Settings may still show the previous import.",
  );
  const failedSnapshot = new Error(
    "Error invoking remote method 'browser-cookie-profile-import-commit': Error: Cookies were imported and recorded, but Settings could not be refreshed. Reopen Settings to verify the completed import.",
  );

  assert.equal(
    browserCookieImportCommitFailureMessage(completedImport, fallback),
    'Cookies were imported, but the import receipt could not be saved. Verify the imported sites before retrying; Settings may still show the previous import.',
  );
  assert.equal(
    browserCookieImportCommitFailureMessage(failedSnapshot, fallback),
    'Cookies were imported and recorded, but Settings could not be refreshed. Reopen Settings to verify the completed import.',
  );
  assert.equal(
    browserCookieImportCommitFailureMessage(
      new Error('Cookies were imported, but private settings path'),
      fallback,
    ),
    fallback,
  );
});

test('profile import completion summary never includes domains or secret fields', () => {
  const summary = formatCookieProfileImportSummary({
    source: 'chrome',
    importMethod: 'profile',
    profileId: 'Default',
    profileLabel: 'Personal',
    importedCount: 2,
    failedCount: 0,
    skippedCount: 1,
    replacementCount: 1,
    domainCount: 1,
    affectedDomains: ['private.example'],
    snapshot: SNAPSHOT,
  });

  assert.equal(summary, 'Imported 2 cookies from Personal; 1 skipped.');
  assert.doesNotMatch(summary, /private\.example|session|value|secret/);
});
