import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '@playwright/test';

// Exercise the real desktop-only entry. Screen acquisition/IPC are mocked;
// image decoding, detection, selection and keyboard interactions are real.
const server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox'],
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : {}),
  });
  const page = await browser.newPage({ viewport: { width: 600, height: 132 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    window.captureDesktopSmoke = { ready: 0, shown: 0, cancelled: 0, selected: [], modes: [] };
    window.desktopCapture = {
      ready: async () => {
        window.captureDesktopSmoke.ready++;
        return { theme: { '--droid-accent': '#e9973f' } };
      },
      choose: async (mode) => {
        window.captureDesktopSmoke.modes.push(mode);
        if (mode !== 'smart') return null;
        const canvas = document.createElement('canvas');
        canvas.width = 1600;
        canvas.height = 960;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#f2f2f2';
        ctx.fillRect(0, 0, 1600, 960);
        ctx.fillStyle = '#202020';
        ctx.fillRect(0, 0, 400, 960);
        ctx.fillStyle = '#606060';
        ctx.fillRect(0, 240, 400, 160);
        ctx.fillStyle = '#111111';
        ctx.font = '28px sans-serif';
        ctx.fillText('A browser page outside Droidex', 480, 150);
        return { source: canvas.toDataURL(), width: 1600, height: 960, smartSelection: true };
      },
      selectionReady: async () => {
        window.captureDesktopSmoke.shown++;
      },
      select: async (rect) => {
        window.captureDesktopSmoke.selected.push(rect);
      },
      cancel: async () => {
        window.captureDesktopSmoke.cancelled++;
      },
    };
  });
  const url = new URL('capture.html', server.resolvedUrls.local[0]).href;
  await page.goto(url);
  await page.waitForFunction(() => window.captureDesktopSmoke.ready === 1);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.captureDesktopSmoke.cancelled === 1);
  assert.equal(await page.getByRole('toolbar').count(), 1);
  assert.equal(
    await page.locator('.desktop-toolbar').evaluate((el) => el.scrollWidth > el.clientWidth),
    false,
  );
  if (process.env.CAPTURE_SCREENSHOT_DIR)
    await page.screenshot({
      path: process.env.CAPTURE_SCREENSHOT_DIR + '/desktop-toolbar.png',
      omitBackground: true,
    });

  await page.getByRole('button', { name: 'Smart area', exact: true }).click();
  await page.setViewportSize({ width: 800, height: 480 });
  await page.waitForFunction(() => window.captureDesktopSmoke.shown === 1);
  await page.mouse.move(90, 150);
  await page.waitForSelector('.desktop-selection-outline');
  if (process.env.CAPTURE_SCREENSHOT_DIR)
    await page.screenshot({
      path: process.env.CAPTURE_SCREENSHOT_DIR + '/desktop-smart-selection.png',
    });
  await page.mouse.click(90, 150);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.captureDesktopSmoke.selected.length === 1);
  const suggested = await page.evaluate(() => window.captureDesktopSmoke.selected[0]);
  assert.ok(
    suggested.width <= 410 && suggested.height < 960,
    'hover proposes a nested external panel, not the whole display',
  );

  await page.reload();
  await page.getByRole('button', { name: 'Smart area', exact: true }).click();
  await page.waitForFunction(() => window.captureDesktopSmoke.shown === 1);
  await page.keyboard.down('Alt');
  await page.mouse.move(320, 40);
  await page.mouse.down();
  await page.mouse.move(620, 240);
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.captureDesktopSmoke.selected.length === 1);
  assert.deepEqual(await page.evaluate(() => window.captureDesktopSmoke.selected[0]), {
    x: 640,
    y: 80,
    width: 600,
    height: 400,
  });

  await page.reload();
  await page.getByRole('button', { name: 'Smart area', exact: true }).click();
  await page.waitForFunction(() => window.captureDesktopSmoke.shown === 1);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.captureDesktopSmoke.cancelled === 1);
  assert.equal(await page.evaluate(() => window.captureDesktopSmoke.selected.length), 0);
  assert.deepEqual(errors, []);
  console.log(
    'Desktop toolbar, external region suggestions, Retina-coordinate free crop, and Escape checks passed.',
  );
} finally {
  await browser?.close();
  await server.close();
}
