// Preferences: theme, language, currency and units; kept across reloads.
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, type Page, test } from '@playwright/test';
import { boxStl } from './models';
import { choose } from './select';

async function ready(page: Page) {
  await page.goto('/');
  await expect(page.getByTestId('app')).toHaveAttribute('data-engine-ready', 'yes');
  await expect(page.getByTestId('process')).toHaveAttribute('data-value', '0.20mm Standard @MyKlipper');
}
const prefs = (page: Page) => page.getByTestId('preferences');

test('theme switches the page and is kept after a reload', async ({ page }) => {
  await ready(page);
  await page.getByTestId('open-preferences').click();
  await prefs(page).getByRole('radio', { name: 'Dark' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  // A dark background (any shade of the dark theme).
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const channels = bg.match(/\d+/g)!.slice(0, 3).map(Number);
  expect(Math.max(...channels), bg).toBeLessThan(60);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByTestId('open-preferences').click();
  await prefs(page).getByRole('radio', { name: 'System' }).click();
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', /./);
});

test('language changes the app and the settings text, and is kept', async ({ page }) => {
  await ready(page);
  await page.getByTestId('open-preferences').click();
  await choose(page.getByTestId('pref-language'), 'de');
  await expect(page.locator('html')).toHaveAttribute('lang', 'de');
  await prefs(page).getByRole('button').last().click();
  await expect(page.getByRole('tab', { name: 'Vorbereiten' })).toBeVisible();
  // Setting names come from desktop OrcaSlicer's German translation.
  await page.getByTestId('edit-print').click();
  await expect(page.locator('.settings .field[data-key="layer_height"] .field-label .name')).toHaveText('Schichthöhe');
  await page.reload();
  await expect(page.getByTestId('app')).toHaveAttribute('data-engine-ready', 'yes');
  await expect(page.getByTestId('slice')).toContainText('slicen');
  await page.getByTestId('open-preferences').click();
  await choose(page.getByTestId('pref-language'), 'en');
  await expect(page.getByTestId('slice')).toHaveText('Slice plate');
});

test('currency and units are used for costs, filament and layer heights', async ({ page }) => {
  await ready(page);
  await page.getByTestId('open-preferences').click();
  await choose(page.getByTestId('pref-currency'), 'EUR');
  await prefs(page).getByRole('radio', { name: 'Imperial' }).click();
  await page.keyboard.press('Escape');

  await page.getByTestId('edit-filament').click();
  await page.getByTestId('settings-search').fill('cost');
  await expect(page.locator('.settings .field[data-key="filament_cost"] .sidetext')).toHaveText('€/kg');
  const cost = page.locator('.settings .field[data-key="filament_cost"] input');
  await cost.fill('20');
  await cost.press('Enter');
  await page.getByRole('tab', { name: 'Prepare' }).click();

  await page.getByTestId('file-input').setInputFiles({ name: 'box.stl', mimeType: 'model/stl', buffer: boxStl(20, 20, 10) });
  await page.getByTestId('slice').click();
  const legend = page.getByTestId('preview-legend');
  await expect(legend).toContainText('Outer wall');
  await expect(legend.locator('dd').nth(1)).toHaveText(/^\d+\.\d\d in · \d+\.\d\d oz$/);
  await expect(legend.locator('dd').nth(2)).toHaveText(/^€\d+\.\d\d$/);
  await expect(page.getByTestId('layer-slider')).toContainText(' in');
});
