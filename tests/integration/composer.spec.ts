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
  const indent = () =>
    composer.evaluate((el) => Number.parseFloat(getComputedStyle(el).textIndent));
  expect(await indent()).toBeGreaterThan(40);
  await composer.pressSequentially('a chart of the last week');
  await expect(composer).toHaveValue('a chart of the last week');
  await expect(removeChip).toBeVisible();

  // The row that added it takes it back off, and the line reclaims the space.
  await page.getByTitle('Add files or a plugin').click();
  await menu.getByRole('menuitemcheckbox', { name: /Visualize/ }).click();
  await expect(removeChip).toHaveCount(0);
  expect(await indent()).toBe(0);

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
