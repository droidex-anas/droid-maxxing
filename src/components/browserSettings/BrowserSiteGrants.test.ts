import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BrowserSettingsSnapshot } from '../../lib/browserSettings.js';
import { BrowserSiteGrants } from './BrowserSiteGrants.js';

const snapshot: BrowserSettingsSnapshot = {
  agentAccessEnabled: true,
  navigationApproval: 'new_sites',
  loginFillApproval: 'always_ask',
  diagnosticsEnabled: false,
  sitePermissionMode: 'ask',
  askDownloadLocation: true,
  showAgentCursor: true,
  agentCursorStyle: 'droidex',
  homePage: 'https://www.google.com/',
  downloadDirectoryLabel: 'System Downloads folder',
  cookieCount: 0,
  credentialOrigins: [],
  approvedAgentOrigins: ['https://agent.example'],
  sitePermissionRules: [
    {
      origin: 'https://meet.example',
      camera: 'deny',
      microphone: 'allow',
    },
  ],
  keychainAvailable: true,
  touchIdAvailable: true,
  webAuthn: {
    accountSelectionAvailable: true,
    touchIdPasskeysAvailable: true,
    touchIdPasskeysReason: 'available',
  },
  platform: 'darwin',
  permissionSummary: { camera: 'ask', microphone: 'ask', devices: 'blocked' },
};

test('exact-site grants expose persisted camera and microphone preferences', () => {
  const html = renderToStaticMarkup(
    createElement(BrowserSiteGrants, {
      snapshot,
      disabled: false,
      onRevoke: () => undefined,
    }),
  );

  assert.match(html, /Agent website access/);
  assert.match(html, /Allowed microphone/);
  assert.match(html, /Blocked camera/);
  assert.match(html, /https:\/\/meet\.example/);
  assert.match(html, /Remembered exact-site choices/);
});
