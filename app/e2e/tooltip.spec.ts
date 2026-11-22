// Tooltips are the app's own (tooltip.ts), not the browser's slow ones.
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '@playwright/test';

test('tooltips show soon after the pointer rests, also on disabled buttons', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('app')).toHaveAttribute('data-engine-ready', 'yes');
  expect(await page.locator('[title]').count()).toBe(0);
  const tip = page.getByRole('tooltip');
  await page.getByTestId('open-preferences').hover();
  await expect(tip).toHaveText('Preferences', { timeout: 1000 });
  // Inside the window, below the button.
  const box = (await tip.boundingBox())!,
    btn = (await page.getByTestId('open-preferences').boundingBox())!;
  expect(box.y).toBeGreaterThan(btn.y + btn.height);
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  // A disabled button (nothing on the plate).
  await page.getByRole('button', { name: 'Arrange' }).hover({ force: true });
  await expect(tip).toHaveText('Arrange (A)', { timeout: 1000 });
  await page.mouse.move(600, 500);
  await expect(tip).toBeHidden();
  // A click closes it, until the pointer comes again.
  await page.getByTestId('edit-print').hover();
  await expect(tip).toBeVisible({ timeout: 1000 });
  await page.getByTestId('edit-print').click();
  await expect(tip).toBeHidden();
  // A setting's description, inside the window.
  await page.locator('.settings .field[data-key="layer_height"]').locator('.field-label .help').hover();
  await expect(tip).toContainText('layer', { timeout: 1000 });
  const long = (await tip.boundingBox())!;
  expect(long.width).toBeLessThanOrEqual(342);
  await page.keyboard.press('Escape');
  await expect(tip).toBeHidden();
});
