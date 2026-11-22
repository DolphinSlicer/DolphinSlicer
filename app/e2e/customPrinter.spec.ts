// Custom printers as desktop's Create Printer dialog makes them: a printer with no parent, saved as
// it is; children of it that only keep what they change; deleting.
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, type Page, test } from '@playwright/test';
import { answer } from './confirm';
import { choose, options } from './select';

async function start(page: Page) {
  await page.goto('/');
  await expect(page.getByTestId('app')).toHaveAttribute('data-engine-ready', 'yes');
  await expect(page.getByTestId('printer')).toHaveAttribute('data-value', 'MyKlipper 0.4 nozzle');
}

async function field(page: Page, key: string) {
  return page.locator(`.settings .field[data-key="${key}"]`);
}

test('create a printer from a template; save it as it is; a child keeps only what it changes', async ({ page }) => {
  await start(page);
  await choose(page.getByTestId('printer'), { label: 'Add or remove printers…' });
  const wizard = page.getByTestId('wizard');
  // "Custom Printer" offers to create one.
  await wizard.getByRole('button', { name: 'Custom Printer' }).click();
  await wizard.locator('.wizard-create-card').getByRole('button', { name: 'Create Printer' }).click();

  // Page 1: the printer.
  const form = page.getByTestId('create-printer');
  await form.getByTestId('create-next').click();
  await expect(form.getByTestId('create-error')).toContainText('vendor and model');
  // A name that cannot be a file name, and a size that is no plain number, are refused.
  await form.getByTestId('create-vendor').fill('Acme/Co');
  await form.getByTestId('create-model').fill('Cube');
  await form.getByTestId('create-next').click();
  await expect(form.getByTestId('create-error')).toContainText('Use letters, numbers and spaces in the name.');
  await form.getByTestId('create-vendor').fill('Acme');
  await form.getByTestId('create-size-x').fill('0x10');
  await form.getByTestId('create-next').click();
  await expect(form.getByTestId('create-error')).toContainText('Please check bed printable shape and origin input.');
  await form.getByTestId('create-nozzle').fill('0.6');
  await form.getByTestId('create-size-x').fill('220');
  await form.getByTestId('create-size-y').fill('230');
  await form.getByTestId('create-height').fill('240');
  await form.getByTestId('create-next').click();

  // Page 2: a template printer, and which of its presets to copy.
  await choose(form.getByTestId('create-tpl-vendor'), { label: 'Custom Printer' });
  await choose(form.getByTestId('create-tpl-model'), 'Generic Klipper Printer');
  await choose(form.getByTestId('create-tpl-nozzle'), 'MyKlipper 0.4 nozzle');
  await expect(form.getByTestId('create-processes').getByRole('checkbox').first()).toBeVisible();
  await form.getByTestId('create-submit').click();
  await expect(form.getByTestId('create-error')).toContainText('at least one filament preset');
  await form.getByTestId('create-filaments').getByRole('searchbox').fill('Generic PLA @');
  await form.getByTestId('create-filaments').getByRole('checkbox', { name: 'Generic PLA @System' }).check();
  await form.getByTestId('create-processes').getByRole('button', { name: 'Select All', exact: true }).click();
  await page.screenshot({ path: test.info().outputPath('create-page2.png'), animations: 'disabled' });
  await form.getByTestId('create-submit').click();

  // It is selected, with its own print settings and filament.
  await expect(wizard).toHaveCount(0);
  await expect(page.getByTestId('printer')).toHaveAttribute('data-value', 'Acme Cube 0.6 nozzle');
  await expect(page.getByTestId('process')).toHaveAttribute('data-value', /@Acme Cube 0\.6 nozzle$/);
  await expect(page.getByTestId('filament')).toHaveAttribute('data-value', 'Generic PLA @Acme Cube 0.6 nozzle');

  // Settings: no parent; Save writes it in place.
  await page.getByTestId('edit-printer').click();
  await expect(page.getByTestId('settings-preset')).toHaveAttribute('data-value', 'Acme Cube 0.6 nozzle');
  await expect(page.getByTestId('settings-based-on')).toHaveCount(0);
  await page.getByTestId('settings-search').fill('printable height');
  const height = (await field(page, 'printable_height')).locator('input');
  await expect(height).toHaveValue('240');
  await height.fill('250');
  await height.press('Enter');
  await page.getByTestId('settings-save').click();
  await expect(page.getByTestId('settings-preset')).toHaveAttribute('data-value', 'Acme Cube 0.6 nozzle');
  await expect(page.getByTestId('settings-save')).toBeDisabled();

  // Save as: a child based on it, keeping only the nozzle it changes.
  await page.getByTestId('settings-search').fill('nozzle diameter');
  const nozzle = (await field(page, 'nozzle_diameter')).locator('input');
  await nozzle.fill('0.8');
  await nozzle.press('Enter');
  await page.getByRole('button', { name: 'Save as…' }).click();
  await page.getByTestId('settings-name').fill('Acme Cube 0.8');
  await page.getByRole('button', { name: 'Save', exact: true }).last().click();
  await expect(page.getByTestId('settings-preset')).toHaveAttribute('data-value', 'Acme Cube 0.8');
  await expect(page.getByTestId('settings-based-on')).toHaveText('Based on Acme Cube 0.6 nozzle');
  // It has the print settings made for its parent.
  await page.getByRole('tab', { name: 'Prepare' }).click();
  await expect(page.getByTestId('process')).toHaveAttribute('data-value', /@Acme Cube 0\.6 nozzle$/);

  // Kept across reloads; the wizard lists both.
  await page.reload();
  await expect(page.getByTestId('app')).toHaveAttribute('data-engine-ready', 'yes');
  await expect(page.getByTestId('printer')).toHaveAttribute('data-value', 'Acme Cube 0.8');
  await choose(page.getByTestId('printer'), { label: 'Add or remove printers…' });
  await expect(page.getByTestId('wizard-my-printers')).toContainText('Acme Cube 0.6 nozzle');
  await expect(page.getByTestId('wizard-my-printers')).toContainText('Based on Acme Cube 0.6 nozzle');
  await page.keyboard.press('Escape');

  // The printer dropdown lists custom printers apart from presets based on a vendor's printer: a
  // printer made from scratch by its model (its variants beside it), a copy by its name.
  expect(await options(page.getByTestId('printer'), { group: 'Custom printers' })).toEqual(['Acme Cube', 'Acme Cube 0.8']);

  // Rename: brand and model; its own presets and its child follow.
  await choose(page.getByTestId('printer'), 'Acme Cube 0.6 nozzle');
  await page.getByTestId('edit-printer').click();
  await page.getByTestId('settings-rename').click();
  await expect(page.getByTestId('rename-vendor')).toHaveValue('Acme');
  await expect(page.getByTestId('rename-model')).toHaveValue('Cube');
  await page.getByTestId('rename-vendor').fill('Zeta');
  await page.getByTestId('rename-model').fill('Box');
  await page.getByRole('button', { name: 'Rename', exact: true }).click();
  await expect(page.getByTestId('settings-preset')).toHaveAttribute('data-value', 'Zeta Box 0.6 nozzle');
  await page.getByRole('tab', { name: 'Prepare' }).click();
  await expect(page.getByTestId('process')).toHaveAttribute('data-value', /@Zeta Box 0\.6 nozzle$/);
  await expect.poll(() => options(page.getByTestId('process'))).not.toContain('Acme');
  await choose(page.getByTestId('printer'), 'Acme Cube 0.8');
  await page.getByTestId('edit-printer').click();
  await expect(page.getByTestId('settings-based-on')).toHaveText('Based on Zeta Box 0.6 nozzle');
  await expect(page.getByTestId('settings-rename')).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('app')).toHaveAttribute('data-engine-ready', 'yes');
  await expect.poll(() => options(page.getByTestId('printer'))).toContain('Zeta Box');

  // Deleting: the parent is kept while a child is based on it.
  await choose(page.getByTestId('printer'), 'Zeta Box 0.6 nozzle');
  await page.getByTestId('edit-printer').click();
  await page.getByTestId('settings').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByTestId('notice-warning')).toContainText('Acme Cube 0.8');
  await choose(page.getByTestId('settings-preset'), 'Acme Cube 0.8');
  await page.getByTestId('settings').getByRole('button', { name: 'Delete', exact: true }).click();
  await answer(page, 'Delete');
  await expect.poll(() => options(page.getByTestId('settings-preset'))).not.toContain('Acme Cube 0.8');
  await choose(page.getByTestId('settings-preset'), 'Zeta Box 0.6 nozzle');
  // The printer takes its own print settings and filament along.
  await page.getByTestId('settings').getByRole('button', { name: 'Delete', exact: true }).click();
  await answer(page, 'Delete', 'print settings and filaments made for it');
  await page.getByRole('tab', { name: 'Prepare' }).click();
  expect((await options(page.getByTestId('printer'))).filter((o) => /Acme|Zeta/.test(o))).toEqual([]);
  expect((await options(page.getByTestId('process'))).filter((o) => /Acme|Zeta/.test(o))).toEqual([]);
});

test('create a filament as desktop does: from a filament, or copying a preset per printer', async ({ page }) => {
  await start(page);
  await choose(page.getByTestId('filament'), { label: 'Add or remove filaments…' });
  await page.getByTestId('wizard-create-filament').click();
  const form = page.getByTestId('create-filament');
  await form.getByTestId('filament-create').click();
  await expect(form.getByTestId('create-error')).toHaveText('Vendor is not selected; please reselect vendor.');
  await form.getByTestId('filament-vendor-custom').check();
  await form.getByTestId('filament-custom-vendor').fill('Generic');
  await form.getByTestId('filament-create').click();
  await expect(form.getByTestId('create-error')).toContainText('cannot be used as a Vendor');
  await form.getByTestId('filament-custom-vendor').fill('Acme');
  await choose(form.getByTestId('filament-type'), 'PLA');
  await form.getByTestId('filament-serial').fill('Matte');
  // Based on a filament: the printers its presets fit.
  await choose(form.getByTestId('filament-base'), { label: 'Generic PLA' });
  await form.getByTestId('filament-create').click();
  await expect(form.getByTestId('create-error')).toContainText('select at least one');
  await form.getByTestId('filament-printers').getByRole('checkbox', { name: 'MyKlipper 0.4 nozzle' }).check();
  await page.screenshot({ path: test.info().outputPath('create-filament.png'), animations: 'disabled' });
  await form.getByTestId('filament-create').click();
  // As desktop, the dialog closes; the new filament is used (it fits the selected printer).
  await expect(page.getByTestId('notice-info')).toContainText('Acme PLA Matte @MyKlipper 0.4 nozzle');
  await expect(page.getByTestId('wizard')).toHaveCount(0);
  await expect(page.getByTestId('filament')).toHaveAttribute('data-value', 'Acme PLA Matte @MyKlipper 0.4 nozzle');
  await page.getByTestId('notice-info').getByRole('button', { name: 'Dismiss' }).click();

  // Copying a preset per printer.
  await choose(page.getByTestId('filament'), { label: 'Add or remove filaments…' });
  await page.getByTestId('wizard-create-filament').click();
  await form.getByTestId('filament-vendor-custom').check();
  await form.getByTestId('filament-custom-vendor').fill('Acme');
  await choose(form.getByTestId('filament-type'), 'PLA');
  await form.getByTestId('filament-serial').fill('Silk');
  await form.getByRole('radio', { name: 'Copy Current Filament Preset' }).check();
  const row = form.getByTestId('filament-presets').locator('li', { hasText: 'MyKlipper 0.4 nozzle' });
  await choose(row.getByRole('combobox'), 'Acme PLA Matte @MyKlipper 0.4 nozzle');
  await expect(row.getByRole('checkbox')).toBeChecked();
  await form.getByTestId('filament-create').click();
  await expect(page.getByTestId('notice-info').last()).toContainText('Acme PLA Silk @MyKlipper 0.4 nozzle');
  await expect(page.getByTestId('wizard')).toHaveCount(0);

  // Both show under "My presets", for that printer; the vendor is set.
  expect(await options(page.getByTestId('filament'), { group: 'My presets' })).toEqual([
    'Acme PLA Matte @MyKlipper 0.4 nozzle',
    'Acme PLA Silk @MyKlipper 0.4 nozzle',
  ]);
  await choose(page.getByTestId('filament'), 'Acme PLA Silk @MyKlipper 0.4 nozzle');
  await page.getByTestId('edit-filament').click();
  await page.getByTestId('settings-search').fill('vendor');
  await expect((await field(page, 'filament_vendor')).locator('input')).toHaveValue('Acme');
});

test('a new variant shares its printer’s print settings and filaments, by choice', async ({ page }) => {
  await start(page);
  await choose(page.getByTestId('printer'), { label: 'Add or remove printers…' });
  const wizard = page.getByTestId('wizard');
  await wizard.getByRole('button', { name: 'Custom Printer' }).click();
  await wizard.locator('.wizard-create-card').getByRole('button', { name: 'Create Printer' }).click();
  const form = page.getByTestId('create-printer');
  await form.getByTestId('create-vendor').fill('Acme');
  await form.getByTestId('create-model').fill('Cube');
  await form.getByTestId('create-nozzle').fill('0.4');
  await form.getByTestId('create-next').click();
  await choose(form.getByTestId('create-tpl-vendor'), { label: 'Custom Printer' });
  await choose(form.getByTestId('create-tpl-model'), 'Generic Klipper Printer');
  await choose(form.getByTestId('create-tpl-nozzle'), 'MyKlipper 0.4 nozzle');
  for (const f of ['Generic PLA @System', 'Generic PETG @System'])
    await form.getByTestId('create-filaments').getByRole('checkbox', { name: f }).check();
  await form.getByTestId('create-processes').getByRole('button', { name: 'Select All', exact: true }).click();
  await form.getByTestId('create-submit').click();
  await expect(page.getByTestId('printer')).toHaveAttribute('data-value', 'Acme Cube 0.4 nozzle');
  const filaments = await options(page.getByTestId('filament'));
  const own = filaments.filter((f) => f.endsWith('@Acme Cube 0.4 nozzle'));
  expect(own).toEqual(['Generic PETG @Acme Cube 0.4 nozzle', 'Generic PLA @Acme Cube 0.4 nozzle']);

  // Create variant…: its printer's presets, all to be shared; one left out.
  await choose(page.getByTestId('nozzle'), { label: 'Create variant…' });
  await form.getByTestId('create-nozzle').fill('0.6');
  await form.getByTestId('create-next').click();
  const sharedFilaments = form.getByTestId('create-shared-filaments').getByRole('checkbox');
  await expect(sharedFilaments).toHaveCount(2);
  for (const c of await sharedFilaments.all()) await expect(c).toBeChecked();
  await expect(form.getByTestId('create-shared-processes').getByRole('checkbox').first()).toBeChecked();
  // Copies are optional now, and don't repeat the shared ones.
  await expect(form.getByTestId('create-filaments')).not.toContainText('@Acme Cube 0.4 nozzle');
  await form.getByTestId('create-shared-filaments').getByRole('checkbox', { name: 'Generic PETG @Acme Cube 0.4 nozzle' }).uncheck();
  await form.getByTestId('create-submit').click();

  // The variant uses the shared presets; the one left out stays with the 0.4.
  await expect(wizard).toHaveCount(0);
  await expect(page.getByTestId('printer')).toHaveAttribute('data-value', 'Acme Cube 0.6 nozzle');
  await expect(page.getByTestId('filament')).toHaveAttribute('data-value', 'Generic PLA @Acme Cube 0.4 nozzle');
  const shared = await options(page.getByTestId('filament'));
  expect(shared).toContain('Generic PLA @Acme Cube 0.4 nozzle');
  expect(shared).not.toContain('Generic PETG @Acme Cube 0.4 nozzle');
  expect(await options(page.getByTestId('process'))).toEqual(expect.arrayContaining([expect.stringMatching(/@Acme Cube 0\.4 nozzle$/)]));

  // Kept across reloads (the presets' files name the variant).
  await page.reload();
  await expect(page.getByTestId('app')).toHaveAttribute('data-engine-ready', 'yes');
  await expect(page.getByTestId('printer')).toHaveAttribute('data-value', 'Acme Cube 0.6 nozzle');
  expect(await options(page.getByTestId('filament'))).toContain('Generic PLA @Acme Cube 0.4 nozzle');
});
