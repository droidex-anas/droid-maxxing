import { expect, test } from '@playwright/test';

const appUrl = process.env.DROIDEX_TEST_URL || '/';

test('the plus button offers plugins and Visualize joins the prompt as a chip', async ({
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
  // The plugin rides along as a chip: the draft stays the user's own words.
  await expect(composer).toHaveValue('');

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

test('the slash menu lists one Compact row for its three typed aliases', async ({ page }) => {
  await page.goto(appUrl);
  const composer = page.locator('textarea').first();

  await composer.fill('/compact');
  await expect(page.getByRole('button').filter({ hasText: 'compact' })).toHaveCount(1);
});
