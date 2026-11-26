// The printer and filament wizard: first start, what the pickers show, importing presets.
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, type Page, test } from '@playwright/test';
import { boxStl } from './models';
import { choose, options } from './select';

// A fresh browser: no library saved yet.
test.use({ storageState: { cookies: [], origins: [] } });

const wizard = (page: Page) => page.getByTestId('wizard');

async function start(page: Page) {
  await page.goto('/');
  await expect(page.getByTestId('app')).toHaveAttribute('data-engine-ready', 'yes');
  await expect(page.getByTestId('printer')).toHaveAttribute('data-value', 'MyKlipper 0.4 nozzle');
}

test('first start opens the wizard; only added printers and filaments are listed', { tag: '@browser' }, async ({ page }) => {
  await start(page);
  await expect(wizard(page)).toBeVisible();
  await expect(page.getByTestId('vendor')).toHaveCount(0);

  await page.getByTestId('wizard-search').fill('X1 Carbon');
  await wizard(page).locator('[data-model="Bambu Lab X1 Carbon"]').getByRole('button', { name: '0.4 mm' }).click();
  await page.getByTestId('wizard-next').click();
  // The printer's default filaments come along.
  await expect(wizard(page).getByRole('checkbox', { name: 'Bambu PLA Basic' })).toBeChecked();
  await page.getByTestId('wizard-done').click();
  await expect(wizard(page)).toHaveCount(0);

  const printer = page.getByTestId('printer');
  await expect(printer).toHaveAttribute('data-value', 'Bambu Lab X1 Carbon 0.4 nozzle');
  const names = await options(printer);
  // By model, as desktop's sidebar (the variant beside it).
  expect(names).toEqual(['Bambu Lab X1 Carbon', 'Generic Klipper Printer', 'Add or remove printers…']);
  const filaments = await options(page.getByTestId('filament'));
  expect(filaments.length).toBeLessThan(30);
  expect(filaments).toContain('Bambu PLA Basic @BBL X1C');

  // Kept: no wizard after a reload.
  await page.reload();
  await expect(page.getByTestId('app')).toHaveAttribute('data-engine-ready', 'yes');
  await expect(page.getByTestId('printer')).toHaveAttribute('data-value', 'Bambu Lab X1 Carbon 0.4 nozzle');
  await expect(wizard(page)).toHaveCount(0);

  // The pickers' last entry opens the wizard again.
  await choose(page.getByTestId('filament'), { label: 'Add or remove filaments…' });
  await expect(wizard(page).getByRole('button', { name: /Filaments/ })).toHaveAttribute('aria-current', 'true');
  await wizard(page).getByRole('checkbox', { name: 'Bambu PETG HF' }).check();
  await page.getByTestId('wizard-done').click();
  // Nothing to reload (same printer, no new vendor): the pickers are ready again.
  for (const id of ['printer', 'filament', 'process']) await expect(page.getByTestId(id)).toBeEnabled();
  await expect.poll(() => options(page.getByTestId('filament'))).toContain('Bambu PETG HF @BBL X1C');
});

test('a Bambu Studio preset imports, loading the profiles it builds on', async ({ page }) => {
  await start(page);
  await wizard(page)
    .getByRole('button', { name: /Import/ })
    .click();
  // The format Bambu Studio writes for a user filament preset.
  const preset = {
    from: 'User',
    inherits: 'Bambu PLA Basic @BBL X1C',
    name: 'My Bambu PLA',
    filament_settings_id: ['My Bambu PLA'],
    nozzle_temperature: ['215'],
    version: '2.0.0.0',
  };
  await page
    .getByTestId('wizard-import-input')
    .setInputFiles({ name: 'My Bambu PLA.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(preset)) });
  await expect(page.getByTestId('wizard-import-result')).toContainText('My Bambu PLA');
});

test('a PrusaSlicer config is converted, with notes on what is not 1:1, and slices', { tag: '@engine' }, async ({ page }) => {
  const { readFileSync } = await import('node:fs');
  const { boxStl } = await import('./models');
  await start(page);
  await wizard(page)
    .getByRole('button', { name: /Import/ })
    .click();
  await page.getByTestId('wizard-import-input').setInputFiles({
    name: 'MK4.ini',
    mimeType: 'text/plain',
    buffer: readFileSync(new URL('../test/fixtures/prusaslicer-mk4.ini', import.meta.url)),
  });
  const result = page.getByTestId('wizard-import-result');
  await expect(result).toContainText('Original Prusa MK4 0.4 nozzle');
  await expect(page.getByTestId('wizard-converted')).toHaveCount(3);
  const printer = page.getByTestId('wizard-converted').filter({ hasText: 'Original Prusa MK4 0.4 nozzle' });
  await printer.locator('summary').click();
  await expect(printer).toContainText('filament_abrasive');
  await page.getByTestId('wizard-done').click();

  await choose(page.getByTestId('printer'), 'Original Prusa MK4 0.4 nozzle');
  await choose(page.getByTestId('process'), '0.20mm QUALITY @MK4 0.4');
  await choose(page.getByTestId('filament'), 'Prusament PLA');
  await page.getByTestId('file-input').setInputFiles({ name: 'box.stl', mimeType: 'model/stl', buffer: boxStl(20, 20, 4) });
  await page.getByTestId('slice').click();
  await expect(page.getByTestId('preview-legend')).toContainText('Outer wall');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('download').click()]);
  const g = (await (await download.createReadStream()).toArray().then((c) => Buffer.concat(c))).toString('utf8');
  expect(g).toContain('M862.3 P "MK4"');
  expect(g).toMatch(/^M104 S215\b|^M109 S215\b/m);
  expect(g).toContain('; wall_loops = 2');
  expect(g).toContain('; outer_wall_speed = 25');
  expect(g).toContain('; printable_area = 0x0,250x0,250x210,0x210');
});

test('without a printer the wizard can import or close (dropping the changes), not go on', async ({ page }) => {
  await start(page);
  await expect(wizard(page)).toBeVisible();
  // Remove the printers the wizard starts with.
  for (const chip of await wizard(page).locator('.chip[aria-pressed="true"]').all()) await chip.click();
  await page.getByTestId('wizard-next').click();
  await expect(page.getByTestId('wizard-hint')).toHaveText('Pick at least one printer.');
  await page.getByTestId('wizard-search').fill('X1 Carbon');
  await wizard(page).locator('[data-model="Bambu Lab X1 Carbon"]').getByRole('button', { name: '0.4 mm' }).click();
  await expect(page.getByTestId('wizard-hint')).toHaveCount(0);
  await wizard(page).locator('[data-model="Bambu Lab X1 Carbon"]').getByRole('button', { name: '0.4 mm' }).click();

  await wizard(page).getByRole('button', { name: 'Import' }).click();
  await expect(wizard(page).getByText('OrcaSlicer', { exact: false }).first()).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(wizard(page)).toHaveCount(0);
  await expect(page.getByTestId('printer')).toHaveAttribute('data-value', 'MyKlipper 0.4 nozzle');
});

test('notices show above dialogs', async ({ page }) => {
  await start(page);
  await expect(wizard(page)).toBeVisible();
  await page.evaluate(() =>
    (globalThis as unknown as { __orca: { store: { setState: (s: object) => void } } }).__orca.store.setState({
      notices: [{ id: 999, kind: 'warning', title: 'Test', message: 'Above the wizard' }],
    }),
  );
  const notice = page.getByTestId('notice-warning');
  // A click only lands when nothing covers the notice.
  await notice.getByRole('button', { name: 'Dismiss' }).click({ timeout: 5000 });
  await expect(notice).toHaveCount(0);
});

test('print settings name their compatible printers, as the filament’s Dependencies page', async ({ page }) => {
  await start(page);
  await page.getByTestId('wizard-search').fill('X1 Carbon');
  await wizard(page).locator('[data-model="Bambu Lab X1 Carbon"]').getByRole('button', { name: '0.4 mm' }).click();
  await page.getByTestId('wizard-next').click();
  await page.getByTestId('wizard-done').click();
  await choose(page.getByTestId('printer'), 'MyKlipper 0.4 nozzle');
  await expect(page.getByTestId('printer')).toHaveAttribute('data-value', 'MyKlipper 0.4 nozzle');

  // A print preset of its own, for MyKlipper only (as its system parent).
  await page.getByTestId('edit-print').click();
  await page.getByRole('button', { name: 'Save as…' }).click();
  await page.getByTestId('settings-name').fill('Mine');
  await page.getByRole('button', { name: 'Save', exact: true }).last().click();
  await expect(page.getByTestId('settings-preset')).toHaveAttribute('data-value', 'Mine');
  await page.getByTestId('settings-mode-advanced').click();
  await page.locator('.settings-pages button', { hasText: 'Dependencies' }).click();
  const edit = page.getByTestId('compatible-edit');
  const dialog = page.getByTestId('compatible-dialog');
  const all = dialog.getByTestId('compatible-all');
  await expect(edit).toHaveText('MyKlipper 0.4 nozzle, MyKlipper 0.6 nozzle, MyKlipper 0.8 nozzle');
  const condition = page.locator('.settings .field[data-key="compatible_printers_condition"]');
  await expect(condition).toHaveClass(/\boff\b/);

  // All printers: the condition applies, and the X1 Carbon offers it too.
  await edit.click();
  await expect(all).not.toBeChecked();
  await all.click();
  await dialog.getByTestId('compatible-apply').click();
  await expect(edit).toHaveText('All');
  await expect(condition).not.toHaveClass(/\boff\b/);
  await page.getByTestId('settings-save').click();
  await expect(page.getByTestId('settings-save')).toBeDisabled();
  await page.getByRole('tab', { name: 'Prepare' }).click();
  await choose(page.getByTestId('printer'), 'Bambu Lab X1 Carbon 0.4 nozzle');
  await expect(page.getByTestId('printer')).toHaveAttribute('data-value', 'Bambu Lab X1 Carbon 0.4 nozzle');
  expect(await options(page.getByTestId('process'))).toContain('Mine');

  // Only MyKlipper, set while on the X1 Carbon: it stays selected, apart, as on desktop.
  await choose(page.getByTestId('process'), 'Mine');
  await page.getByTestId('edit-print').click();
  await edit.click();
  await all.click();
  await expect(dialog.getByRole('listitem')).toHaveCount(2);
  await dialog.getByRole('checkbox', { name: 'MyKlipper 0.4 nozzle' }).check();
  await dialog.getByTestId('compatible-apply').click();
  await expect(edit).toHaveText('MyKlipper 0.4 nozzle');
  await page.getByTestId('settings-save').click();
  await expect(page.getByTestId('settings-save')).toBeDisabled();
  await expect(page.getByTestId('settings-preset')).toHaveAttribute('data-value', 'Mine');
  expect(await options(page.getByTestId('settings-preset'), { group: 'Unsupported presets' })).toEqual(['Mine']);

  // Another printer and back: MyKlipper offers it, the X1 Carbon no longer does.
  await page.getByRole('tab', { name: 'Prepare' }).click();
  await choose(page.getByTestId('printer'), 'MyKlipper 0.4 nozzle');
  await expect(page.getByTestId('printer')).toHaveAttribute('data-value', 'MyKlipper 0.4 nozzle');
  expect(await options(page.getByTestId('process'))).toContain('Mine');
  await choose(page.getByTestId('printer'), 'Bambu Lab X1 Carbon 0.4 nozzle');
  await expect(page.getByTestId('process')).not.toHaveAttribute('data-value', 'Mine');
  expect(await options(page.getByTestId('process'))).not.toContain('Mine');
});

test('the printer’s variant and plate type are picked under it, as desktop’s sidebar', async ({ page }) => {
  await start(page);
  await page.getByTestId('wizard-search').fill('X1 Carbon');
  await wizard(page).locator('[data-model="Bambu Lab X1 Carbon"]').getByRole('button', { name: '0.4 mm' }).click();
  await page.getByTestId('wizard-next').click();
  await page.getByTestId('wizard-done').click();

  // A Bambu Lab printer offers its plates; the plate decides the bed temperature sliced with.
  const bed = page.getByTestId('bed-type');
  await expect(bed).toHaveAttribute('data-value', 'Cool Plate');
  await page.getByTestId('file-input').setInputFiles({ name: 'cube.stl', mimeType: 'model/stl', buffer: boxStl(20, 20, 20) });
  await expect(page.getByTestId('object-list')).toContainText('cube.stl');
  const bedTemp = async () => {
    await page.getByTestId('slice').click();
    await expect(page.getByTestId('download')).toBeEnabled();
    const [d] = await Promise.all([page.waitForEvent('download'), page.getByTestId('download').click()]);
    const text = Buffer.concat(await (await d.createReadStream()).toArray()).toString('utf8');
    return /^M140 S(\d+)/m.exec(text)?.[1];
  };
  expect(await bedTemp()).toBe('35');
  await choose(bed, { label: 'Textured PEI Plate' });
  await expect(bed).toHaveAttribute('data-value', 'Textured PEI Plate');
  expect(await bedTemp()).toBe('55');

  // A printer with one bed type has no plate choice; its variant switches to the 0.6 printer.
  await choose(page.getByTestId('printer'), 'MyKlipper 0.4 nozzle');
  await expect(page.getByTestId('printer')).toHaveAttribute('data-value', 'MyKlipper 0.4 nozzle');
  await expect(bed).toHaveCount(0);
  const nozzle = page.getByTestId('nozzle');
  expect(await options(nozzle)).toEqual(['0.2', '0.4', '0.6', '0.8', 'Create variant…']);
  await choose(nozzle, { label: '0.6' });
  await expect(page.getByTestId('printer')).toHaveAttribute('data-value', 'MyKlipper 0.6 nozzle');
  // The printer dropdown names the model either way.
  await expect(page.getByTestId('printer')).toHaveText('Generic Klipper Printer');
  // "Create variant…" opens desktop's Create Nozzle for Existing Printer, for this printer.
  await choose(nozzle, { label: 'Create variant…' });
  await expect(wizard(page).getByRole('radio', { name: 'Create Nozzle for Existing Printer' })).toBeChecked();
  await expect(page.getByTestId('create-existing')).toHaveAttribute('data-value', /^MyKlipper /);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(wizard(page)).toHaveCount(0);

  // Back on the X1 Carbon: the plate picked for it.
  await choose(page.getByTestId('printer'), 'Bambu Lab X1 Carbon 0.4 nozzle');
  await expect(bed).toHaveAttribute('data-value', 'Textured PEI Plate');
});
