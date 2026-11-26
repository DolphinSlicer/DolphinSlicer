// Desktop's Calibration menu: a test replaces the plate with its model, changes the presets for it,
// and its G-code has the test (here the temperature tower, stepping from 230 down to 190 °C).
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '@playwright/test';

test('the temperature tower: its model, the filament changed for it, its temperatures', { tag: '@engine' }, async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('app')).toHaveAttribute('data-engine-ready', 'yes');
  await expect(page.getByTestId('process')).not.toHaveAttribute('data-value', '');
  await page.getByTestId('open-calibration').click();
  await page.getByTestId('calibration-menu').getByRole('menuitem', { name: 'Temperature' }).click();
  const dialog = page.getByTestId('calib-dialog');
  // Desktop's checks of the range (the end, rounded down to steps of 5, must be 5 below the start).
  await dialog.getByRole('textbox', { name: 'End temp' }).fill('230');
  await dialog.getByTestId('calib-ok').click();
  await expect(dialog.getByRole('alert')).toContainText('Start temp >= End temp + 5');
  await dialog.getByRole('radio', { name: 'PETG' }).check();
  await expect(dialog.getByRole('textbox', { name: 'Start temp' })).toHaveValue('250');
  await dialog.getByRole('radio', { name: 'PLA' }).check();
  await dialog.getByTestId('calib-ok').click();

  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('object-list')).toContainText('temperature_tower.drc');
  await expect(page.getByTestId('object-list')).toContainText('custom settings');
  await page.getByTestId('slice').click();
  await expect(page.getByTestId('download')).toBeEnabled();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('download').click()]);
  const gcode = await (await download.createReadStream()).toArray().then((c) => Buffer.concat(c).toString('utf8'));
  const temps = [...new Set([...gcode.matchAll(/^M104 S(\d+)/gm)].map((m) => Number(m[1])))];
  expect(temps).toEqual([230, 225, 220, 215, 210, 205, 200, 195, 190]);
});
