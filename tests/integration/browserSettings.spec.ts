import { expect, test } from '@playwright/test';
import type { BrowserSettingsSnapshot } from '../../src/lib/browserSettings';

test('cursor size commits when a drag ends outside the slider', async ({ page }) => {
  await page.routeWebSocket(/.*/, (socket) => socket.close());
  await page.goto('/');
  const snapshot: BrowserSettingsSnapshot = {
    agentAccessEnabled: true,
    navigationApproval: 'new_sites',
    loginFillApproval: 'always_ask',
    diagnosticsEnabled: false,
    sitePermissionMode: 'ask',
    askDownloadLocation: true,
    showAgentCursor: true,
    agentCursorStyle: 'droidex',
    agentCursorSize: 36,
    homePage: 'https://www.google.com/',
    downloadDirectoryLabel: 'Downloads',
    cookieCount: 0,
    credentialOrigins: [],
    approvedAgentOrigins: [],
    sitePermissionRules: [],
    keychainAvailable: false,
    touchIdAvailable: false,
    webAuthn: {
      accountSelectionAvailable: false,
      touchIdPasskeysAvailable: false,
      touchIdPasskeysReason: 'runtime_unsupported',
    },
    platform: 'linux',
    permissionSummary: { camera: 'ask', microphone: 'ask', devices: 'blocked' },
    lastCookieImport: null,
  };
  const sizes: number[] = [];
  await page.exposeFunction('recordCursorSize', (size: number) => sizes.push(size));
  await page.evaluate((initial) => {
    let snapshot = initial;
    Reflect.set(window, 'droidControl', {
      browserSettingsGet: async () => snapshot,
      browserSettingsUpdate: async (patch: { agentCursorSize: number }) => {
        Reflect.get(window, 'recordCursorSize')(patch.agentCursorSize);
        snapshot = { ...snapshot, ...patch };
        return snapshot;
      },
    });
  }, snapshot);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Browser', exact: true }).click();
  const slider = page.getByRole('slider', { name: 'Agent cursor size' });
  await slider.scrollIntoViewIfNeeded();
  const box = await slider.boundingBox();
  if (!box) throw new Error('The cursor size slider is not visible.');
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width + 30, box.y - 30, { steps: 5 });
  expect(sizes).toEqual([]);
  await page.mouse.up();
  await expect.poll(() => sizes).toEqual([64]);
  await expect(slider).toHaveValue('64');
});
