import { expect, test } from '@playwright/test';

const appUrl = process.env.DROIDEX_TEST_URL || '/';

test('the plus button offers plugins and Visualize joins the prompt as a selection', async ({
  page,
}) => {
  await page.goto(appUrl);
  const composer = page.locator('textarea').first();

  await page.getByTitle('Add files or a plugin').click();
  const menu = page.getByRole('menu');
  await expect(menu.getByText('Files', { exact: true })).toBeVisible();
  await menu.getByText('Visualize', { exact: true }).click();

  const removeChip = page.getByRole('button', { name: 'Remove Visualize' });
  await expect(removeChip).toBeVisible();
  await expect(menu).toHaveCount(0);
  // The plugin rides along as a selection: the draft stays the user's own words.
  await expect(composer).toHaveValue('');
  // The selection is the command, so it can be sent on its own.
  await expect(page.getByTitle(/Enter: send/)).toBeEnabled();

  // It sits on the draft's own first line, so that line starts after it and
  // typing continues from there.
  // The indent lands in a layout effect after the selection commits, so poll it.
  const indent = () =>
    composer.evaluate((el) => Number.parseFloat(getComputedStyle(el).textIndent));
  await expect.poll(indent).toBeGreaterThan(40);
  await composer.pressSequentially('a chart of the last week');
  await expect(composer).toHaveValue('a chart of the last week');
  await expect(removeChip).toBeVisible();

  // The row that added it takes it back off, and the line reclaims the space.
  await page.getByTitle('Add files or a plugin').click();
  await menu.getByRole('menuitemcheckbox', { name: /Visualize/ }).click();
  await expect(removeChip).toHaveCount(0);
  await expect.poll(indent).toBe(0);

  // One Backspace at the start of an empty draft takes the whole selection off.
  await page.getByTitle('Add files or a plugin').click();
  await menu.getByText('Visualize', { exact: true }).click();
  await composer.fill('');
  await composer.click();
  await composer.press('Backspace');
  await expect(removeChip).toHaveCount(0);
});

test('the slash menu keeps /visualize out of the draft text', async ({ page }) => {
  await page.goto(appUrl);
  const composer = page.locator('textarea').first();

  await composer.fill('/visual');
  await page.getByText('visualize', { exact: true }).click();

  await expect(page.getByRole('button', { name: 'Remove Visualize' })).toBeVisible();
  await expect(composer).toHaveValue('');
});

// /compaction and /compression stay accepted when typed in full, but neither
// matches the command's name, so the menu never offered a row for them and
// still doesn't. What it used to offer was three identical Compact rows.
test('the slash menu lists a single Compact row', async ({ page }) => {
  await page.goto(appUrl);
  const composer = page.locator('textarea').first();

  await composer.fill('/compact');
  await expect(page.getByRole('button').filter({ hasText: 'compact' })).toHaveCount(1);

  for (const alias of ['/compaction', '/compression']) {
    await composer.fill(alias);
    await expect(page.getByRole('button').filter({ hasText: 'compact' })).toHaveCount(0);
  }
});

// A selection wider than half the line would leave no room to type, so it stops
// indenting and takes a row of its own instead of pushing the draft off-screen.
test('a selection too wide for the first line moves above it', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(appUrl);
  const composer = page.locator('textarea').first();
  const indent = () =>
    composer.evaluate((el) => Number.parseFloat(getComputedStyle(el).textIndent));

  await page.getByTitle('Add files or a plugin').click();
  await page.getByRole('menu').getByText('Visualize', { exact: true }).click();
  await expect.poll(indent).toBeGreaterThan(40);

  await page.setViewportSize({ width: 420, height: 900 });
  await expect.poll(indent).toBe(0);
  // Still staged, still visible, and still removable.
  await expect(page.getByRole('button', { name: 'Remove Visualize' })).toBeVisible();
  await expect(composer).toBeVisible();
});

test('the plus menu is reachable by keyboard and on a narrow window', async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 900 });
  await page.goto(appUrl);

  const trigger = page.getByTitle('Add files or a plugin');
  await trigger.click();
  const menu = page.getByRole('menu');
  const box = (await menu.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(420);

  // Opening focuses the first row; the arrows walk between them.
  const focusedRow = () => page.evaluate(() => document.activeElement?.textContent ?? '');
  await expect.poll(focusedRow).toContain('Files');
  await page.keyboard.press('ArrowDown');
  await expect.poll(focusedRow).toContain('Visualize');
  await page.keyboard.press('ArrowDown');
  await expect.poll(focusedRow).toContain('Files');
  await page.keyboard.press('ArrowUp');
  await expect.poll(focusedRow).toContain('Visualize');

  // Escape closes it and hands focus back to the button that opened it.
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

// The composer grows with the draft, and the transcript above owns the space it
// takes. Remeasuring by collapsing the box to one line hands that space back for
// a layout pass, which clamps the transcript's scroll position off the bottom
// and, during a live turn, makes it jump on every keystroke. Growth needs no
// collapse, so typing forward must not produce one.
test('typing forward never collapses the composer to remeasure it', async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 900 });
  await page.goto(appUrl);
  const composer = page.locator('textarea').first();
  const height = () => composer.evaluate((el) => el.offsetHeight);

  const watchHeights = () =>
    composer.evaluate((el) => {
      const seen: string[] = [];
      new MutationObserver((records) => {
        for (const record of records) seen.push(record.oldValue ?? '');
      }).observe(el, { attributeFilter: ['style'], attributeOldValue: true });
      (window as unknown as { __draftStyles: string[] }).__draftStyles = seen;
    });
  const collapses = () =>
    page.evaluate(
      () =>
        (window as unknown as { __draftStyles: string[] }).__draftStyles.filter((style) =>
          style.includes('height: auto'),
        ).length,
    );

  const oneLine = await height();
  await composer.click();
  await watchHeights();
  await composer.pressSequentially(
    'a draft long enough to wrap the composer onto a second line, and then onto a third line, and a fourth one after that as well',
  );
  await expect.poll(height).toBeGreaterThan(oneLine);
  expect(await collapses()).toBe(0);

  // Deleting can need fewer lines than the box has, so it does collapse, and
  // the composer hands the transcript its space back.
  await watchHeights();
  await composer.fill('');
  await expect.poll(height).toBe(oneLine);
  expect(await collapses()).toBeGreaterThan(0);
});
