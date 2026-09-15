import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

const bannerPath = resolve('electron/mobile/RemoteArtwork/banner.html');

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 208 });
  await page.setContent(await readFile(bannerPath, 'utf8'));
  await expect(page.locator('html')).toHaveAttribute('data-ready', 'true');
});

test('chapters are keyboard reachable and settle on the correct vector geometry', async ({ page }) => {
  const widths = [21.9, 57.9, 60.9, 31.9];
  for (const [index, width] of widths.entries()) {
    const chapter = page.getByRole('button', { name: new RegExp(`^Step ${index + 1}:`) });
    await chapter.focus();
    await page.keyboard.press('Enter');
    await expect(chapter).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator(`.caption.chapter-${index}`)).toHaveCSS('opacity', '1');
    await expect(page.locator('.morph-panel')).toHaveCSS('width', `${width}px`);
    await expect(page.locator('html')).toHaveAttribute('data-playing', 'false');
  }
  await page.getByRole('button', { name: 'Replay walkthrough', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-playing', 'true');
  await page.getByRole('button', { name: 'Pause walkthrough', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-playing', 'false');
});

test('Reduce Motion preserves explicit chapter navigation without starting motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.getByRole('button', { name: 'Animation disabled by Reduce Motion' })).toBeDisabled();
  await page.getByRole('button', { name: /^Step 3:/ }).click();
  await expect(page.locator('.caption.chapter-2')).toHaveCSS('opacity', '1');
  await page.getByRole('button', { name: 'Replay walkthrough', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-playing', 'false');
});

test('inactive hosts and fixed chapters cannot accidentally restart the guide', async ({ page }) => {
  await page.evaluate(() => window.postMessage({ type: 'droidex.remote-artwork', active: false }, '*'));
  await expect(page.locator('html')).toHaveAttribute('data-playing', 'false');
  await page.getByRole('button', { name: 'Replay walkthrough', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-playing', 'false');
  await page.evaluate(() => window.postMessage({ type: 'droidex.remote-artwork', active: true, step: 2 }, '*'));
  await expect(page.locator('.caption.chapter-2')).toHaveCSS('opacity', '1');
  await expect(page.getByRole('button', { name: 'Replay walkthrough', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: /^Step 1:/ })).toBeDisabled();
});

test('the compact banner fits without clipping or external requests', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  await page.setContent(await readFile(bannerPath, 'utf8'));
  for (const width of [264, 280, 320, 375, 430, 640]) {
    await page.setViewportSize({ width, height: 208 });
    const bounds = await page.evaluate(() => ({
      width: document.documentElement.scrollWidth,
      height: document.documentElement.scrollHeight,
    }));
    expect(bounds.width).toBeLessThanOrEqual(width);
    expect(bounds.height).toBeLessThanOrEqual(208);
  }
  expect(requests).toEqual([]);
});
