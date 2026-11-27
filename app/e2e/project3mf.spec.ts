// Plates saved as project 3MFs (OrcaSlicer's format): downloaded, or added to the library, and
// opened again with their objects, support blockers and settings.
// SPDX-License-Identifier: AGPL-3.0-or-later
import { type Browser, expect, type Page, test } from '@playwright/test';
import { boxStl } from './models';
import { choose } from './select';

async function fresh(browser: Browser, baseURL: string): Promise<Page> {
  const page = await (await browser.newContext({ baseURL, storageState: test.info().project.use.storageState })).newPage();
  await page.goto('/');
  await expect(page.getByTestId('app')).toHaveAttribute('data-engine-ready', 'yes');
  await expect(page.getByTestId('process')).toHaveAttribute('data-value', '0.20mm Standard @MyKlipper');
  return page;
}

test('a plate downloaded as 3MF opens with its objects, support blocker and settings', { tag: '@browser' }, async ({
  browser,
  baseURL,
}) => {
  const a = await fresh(browser, baseURL!);
  await a.getByTestId('file-input').setInputFiles({ name: 'box.stl', mimeType: 'model/stl', buffer: boxStl() });
  const row = a.getByTestId('object-list').locator('li').first();
  await row.click({ button: 'right' });
  await a.getByTestId('menu-add-blocker').hover();
  await a.getByTestId('menu-blocker-cylinder').click();
  // Other print settings, an edit of them and of the printer's start G-code.
  await choose(a.getByTestId('process'), '0.12mm Fine @MyKlipper');
  await a.getByTestId('edit-print').click();
  await a.getByTestId('settings-search').fill('sparse infill density');
  const density = a.locator('.settings .field[data-key="sparse_infill_density"] input');
  await density.fill('37');
  await density.press('Enter');
  await a.getByTestId('settings').getByRole('tab', { name: 'Printer' }).click();
  await a.getByTestId('settings-search').fill('start g-code');
  const start = a.locator('.settings .field[data-key="machine_start_gcode"] textarea');
  await start.fill('G28 ; from the project');
  await start.blur();
  await a.getByRole('tab', { name: 'Prepare' }).click();

  const [download] = await Promise.all([a.waitForEvent('download'), a.getByTestId('download-3mf').click()]);
  expect(download.suggestedFilename()).toBe('box.3mf');
  const bytes = Buffer.concat(await (await download.createReadStream()).toArray());

  // Another browser: the settings in use are its own until the project comes.
  const b = await fresh(browser, baseURL!);
  await b.getByTestId('file-input').setInputFiles({ name: 'box.3mf', mimeType: 'model/3mf', buffer: bytes });
  await expect(b.getByTestId('volume-row')).toHaveCount(1);
  await expect(b.getByTestId('volume-row')).toContainText('Support Blocker');
  await expect(b.getByTestId('process')).toHaveAttribute('data-value', '0.12mm Fine @MyKlipper');
  await expect(b.getByTestId('process')).toContainText('(modified)');
  // Its G-code is pointed out, to be checked before printing.
  await expect(b.getByTestId('notice-warning')).toContainText('Start G-code');
  await b.getByTestId('edit-print').click();
  await b.getByTestId('settings-search').fill('sparse infill density');
  await expect(b.locator('.settings .field[data-key="sparse_infill_density"] input')).toHaveValue('37');
});

test('“Add to library” keeps the plate as one 3MF, opened again as the plate', { tag: '@browser' }, async ({ browser, baseURL }) => {
  const page = await fresh(browser, baseURL!);
  await page.getByTestId('file-input').setInputFiles([
    { name: 'one.stl', mimeType: 'model/stl', buffer: boxStl(10, 10, 10) },
    { name: 'two.stl', mimeType: 'model/stl', buffer: boxStl(20, 10, 5) },
  ]);
  await expect(page.getByTestId('object-list').locator('li')).toHaveCount(2);
  await choose(page.getByTestId('process'), '0.12mm Fine @MyKlipper');
  await page.getByTestId('save-to-library').click();
  await page.getByTestId('tab-library').click();
  const card = page.getByTestId('library-card');
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('3MF');

  // On an empty plate with other settings: both objects and the settings come back.
  await page.getByRole('tab', { name: 'Prepare' }).click();
  await page.getByTestId('object-list').locator('li').first().click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a');
  await page.keyboard.press('Delete');
  await choose(page.getByTestId('process'), '0.20mm Standard @MyKlipper');
  await page.getByTestId('tab-library').click();
  await page
    .getByRole('button', { name: /^Open / })
    .first()
    .click();
  await expect(page.getByTestId('object-list').locator('li')).toHaveCount(2);
  await expect(page.getByTestId('process')).toHaveAttribute('data-value', '0.12mm Fine @MyKlipper');
});
