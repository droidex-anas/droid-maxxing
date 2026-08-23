import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  commitBrowserSettingsPatch,
  formatCookieImportSummary,
  getBrowserSettings,
  type BrowserSettingsSnapshot,
} from '../lib/browserSettings.js';
import { BrowserSettings } from './BrowserSettings.js';
import { BrowserSettingsCard } from './browserSettings/BrowserSettingsPrimitives.js';
import { BrowserSettingsView } from './browserSettings/BrowserSettingsView.js';

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
  cookieCount: 4,
  credentialOrigins: ['https://accounts.example.com'],
  approvedAgentOrigins: ['https://docs.example.com'],
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

const noop = () => undefined;

test('BrowserSettings starts with a visible loading state', () => {
  const html = renderToStaticMarkup(createElement(BrowserSettings));
  assert.match(html, /Loading browser settings/);
  assert.match(html, /role="status"/);
});

test('getBrowserSettings rejects instead of synchronously throwing when Electron preload is stale', async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { droidControl: {} },
  });
  try {
    let request: Promise<BrowserSettingsSnapshot> | undefined;
    try {
      request = getBrowserSettings();
    } catch {
      assert.fail('stale preload errors must be delivered as a rejected promise');
    }
    assert.ok(request);
    await assert.rejects(request, /browserSettingsGet/);
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('BrowserSettingsView renders real safety controls without unexpected secrets', () => {
  const snapshotWithUnexpectedSecret = { ...SNAPSHOT, password: 'should-never-render' };
  const html = renderToStaticMarkup(
    createElement(BrowserSettingsView, {
      snapshot: snapshotWithUnexpectedSecret,
      disabled: false,
      onPatch: noop,
      onImport: noop,
      onClearData: noop,
      onDeleteCredential: noop,
      onRevoke: noop,
      onChooseDownloadDirectory: noop,
    }),
  );

  assert.match(html, /Agent browser access/);
  assert.match(html, /Import/);
  assert.match(html, /Chrome profile import/);
  assert.match(html, /Safari sign-ins must be completed once inside DROIDEX/);
  assert.doesNotMatch(html, /Safari exports/);
  assert.match(html, /Encrypted with macOS Keychain/);
  assert.match(html, /Touch ID confirmation is available when DROIDEX asks/);
  assert.match(html, /Home and search page/);
  assert.match(html, /https:\/\/www\.google\.com\//);
  assert.match(html, /Show DROIDEX agent cursor/);
  assert.match(html, /aria-label="Agent cursor style"/);
  assert.match(html, />DROIDEX</);
  assert.match(html, /translate\(6 2\)/);
  assert.match(html, /Signups, OAuth, and passkeys/);
  assert.match(html, /Touch ID passkeys are available in this signed DROIDEX build/);
  assert.match(html, /https:\/\/docs\.example\.com/);
  assert.match(html, /This does not enable raw CDP access/);
  assert.doesNotMatch(html, /should-never-render/);
});

test('Browser settings cards do not clip dropdown options outside their rows', () => {
  const html = renderToStaticMarkup(
    createElement(BrowserSettingsCard, null, createElement('div', null, 'settings row')),
  );

  assert.doesNotMatch(html, /overflow-hidden/);
});

test('BrowserSettingsView does not claim Touch ID passkeys in development builds', () => {
  const html = renderToStaticMarkup(
    createElement(BrowserSettingsView, {
      snapshot: {
        ...SNAPSHOT,
        webAuthn: {
          accountSelectionAvailable: true,
          touchIdPasskeysAvailable: false,
          touchIdPasskeysReason: 'signed_release_required',
        },
      },
      disabled: false,
      onPatch: noop,
      onImport: noop,
      onClearData: noop,
      onDeleteCredential: noop,
      onRevoke: noop,
      onChooseDownloadDirectory: noop,
    }),
  );

  assert.match(html, /Touch ID passkeys require a signed DROIDEX release/);
  assert.doesNotMatch(html, /Touch ID passkeys are available/);
});

test('BrowserSettingsView keeps a persistent secret-free Chrome import receipt visible', () => {
  const html = renderToStaticMarkup(
    createElement(BrowserSettingsView, {
      snapshot: {
        ...SNAPSHOT,
        lastCookieImport: {
          importedAt: '2026-08-16T12:34:56.000Z',
          source: 'chrome',
          importMethod: 'profile',
          profileLabel: 'Personal',
          importedCount: 42,
          replacementCount: 6,
          skippedCount: 3,
          failedCount: 0,
          domainCount: 8,
        },
      },
      disabled: false,
      onPatch: noop,
      onImport: noop,
      onClearData: noop,
      onDeleteCredential: noop,
      onRevoke: noop,
      onChooseDownloadDirectory: noop,
    }),
  );

  assert.match(html, /Last Chrome import/);
  assert.match(html, /Personal profile/);
  assert.match(html, /42 imported/);
  assert.match(html, /3 skipped/);
  assert.match(html, /8 sites/);
  assert.doesNotMatch(html, /cookieValue|cookieName|affectedDomains/);
});

test('commitBrowserSettingsPatch rolls back an optimistic change on failure', async () => {
  const published: BrowserSettingsSnapshot[] = [];
  await assert.rejects(
    commitBrowserSettingsPatch(
      SNAPSHOT,
      { diagnosticsEnabled: true },
      (snapshot) => published.push(snapshot),
      async () => {
        throw new Error('host unavailable');
      },
    ),
  );
  assert.equal(published.length, 2);
  assert.equal(published[0]?.diagnosticsEnabled, true);
  assert.deepEqual(published[1], SNAPSHOT);
});

test('commitBrowserSettingsPatch publishes the authoritative saved mutation', async () => {
  const published: BrowserSettingsSnapshot[] = [];
  const authoritative = { ...SNAPSHOT, askDownloadLocation: false, cookieCount: 5 };
  await commitBrowserSettingsPatch(
    SNAPSHOT,
    { askDownloadLocation: false },
    (snapshot) => published.push(snapshot),
    async () => authoritative,
  );
  assert.equal(published[0]?.askDownloadLocation, false);
  assert.deepEqual(published[1], authoritative);
});

test('cookie import result reports counts without exposing cookie values', () => {
  const summary = formatCookieImportSummary({
    canceled: false,
    source: 'chrome',
    importedCount: 3,
    skippedCount: 1,
    affectedDomains: ['example.com'],
    snapshot: SNAPSHOT,
  });
  assert.equal(summary, 'Imported 3 cookies from Chrome; 1 skipped.');
  assert.doesNotMatch(summary, /token|value|secret/i);
  assert.equal(formatCookieImportSummary({ canceled: true }), '');
});
