// The app's dropdowns (src/ui/Select.tsx): keyboard, search and the action row.
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '@playwright/test';

test('dropdowns work with the keyboard, search long lists and run their actions', { tag: '@browser' }, async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('app')).toHaveAttribute('data-engine-ready', 'yes');
  const process = page.getByTestId('process');
  await expect(process).toHaveAttribute('data-value', '0.20mm Standard @MyKlipper');

  // Keyboard: open, move down one, choose.
  await process.focus();
  await page.keyboard.press('ArrowDown');
  await expect(process).toHaveAttribute('aria-expanded', 'true');
  const list = page.locator(`[id="${await process.getAttribute('aria-controls')}"]`);
  await expect(list.getByRole('option', { selected: true })).toHaveText('0.20mm Standard @MyKlipper');
  const values = await list.getByRole('option').evaluateAll((els) => els.map((e) => e.getAttribute('data-value')));
  const next = values[values.indexOf('0.20mm Standard @MyKlipper') + 1]!;
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(process).toHaveAttribute('aria-expanded', 'false');
  await expect(process).toHaveAttribute('data-value', next);
  await expect(process).toBeFocused();

  // Escape closes without changing anything.
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Escape');
  await expect(process).toHaveAttribute('aria-expanded', 'false');
  await expect(process).toHaveAttribute('data-value', next);

  // Long lists can be searched: typing on the closed dropdown starts the search.
  await page.getByTestId('open-preferences').click();
  const currency = page.getByTestId('pref-currency');
  await currency.press('s');
  const search = page.getByRole('searchbox', { name: 'Search' });
  await expect(search).toBeFocused();
  await expect(search).toHaveValue('s');
  await search.pressSequentially('wiss franc');
  const currencies = page.locator(`[id="${await currency.getAttribute('aria-controls')}"]`);
  await expect(currencies.getByRole('option')).toHaveText(['Swiss Franc (CHF)']);
  await page.keyboard.press('Enter');
  await expect(currency).toHaveAttribute('data-value', 'CHF');
  await expect(search).toHaveCount(0);
  await expect(currency).toBeFocused();
  await page.keyboard.press('Escape');

  // A click outside closes it.
  await process.click();
  await page.mouse.click(700, 400);
  await expect(process).toHaveAttribute('aria-expanded', 'false');

  // The action row opens the wizard.
  await page.getByTestId('filament').click();
  await page.getByRole('option', { name: 'Add or remove filaments…' }).click();
  await expect(page.getByTestId('wizard')).toBeVisible();
});
