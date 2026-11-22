// Settings editing, user presets (save, reload, export, delete) and import.
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, type Page, test } from '@playwright/test';
import { answer } from './confirm';
import { boxStl } from './models';
import { choose, options, value } from './select';

async function ready(page: Page) {
  await page.goto('/');
  await expect(page.getByTestId('app')).toHaveAttribute('data-engine-ready', 'yes');
  await expect(page.getByTestId('process')).toHaveAttribute('data-value', '0.20mm Standard @MyKlipper');
}

async function field(page: Page, key: string) {
  return page.locator(`.settings .field[data-key="${key}"]`);
}

async function sliceText(page: Page): Promise<string> {
  await page.getByTestId('slice').click();
  await expect(page.getByTestId('preview-legend')).toContainText('Outer wall');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('download').click()]);
  return (await download.createReadStream()).toArray().then((c) => Buffer.concat(c).toString('utf8'));
}

test('settings is its own tab, opened at the right preset type by the edit buttons', async ({ page }) => {
  await ready(page);
  await page.getByTestId('tab-settings').click();
  await expect(page.getByTestId('settings').getByRole('tab', { name: 'Print settings' })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: 'Prepare' }).click();
  await expect(page.getByTestId('settings')).toBeHidden();
  await page.getByTestId('edit-printer').click();
  await expect(page.getByTestId('tab-settings')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('settings').getByRole('tab', { name: 'Printer' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('settings-preset')).toHaveAttribute('data-value', 'MyKlipper 0.4 nozzle');
});

test('each preset type keeps its settings page, as desktop’s tabs', async ({ page }) => {
  await ready(page);
  await page.getByTestId('tab-settings').click();
  const tabs = page.getByTestId('settings');
  const current = page.locator('.settings-pages button[aria-current="true"]');
  // Simple mode lists only the pages with simple settings.
  await page.getByTestId('settings-mode').getByRole('radio', { name: 'Advanced' }).click();
  await page.locator('.settings-pages button', { hasText: 'Speed' }).click();
  await tabs.getByRole('tab', { name: 'Filament' }).click();
  await expect(current).toHaveText('Filament');
  await page.locator('.settings-pages button', { hasText: 'Cooling' }).click();
  await tabs.getByRole('tab', { name: 'Print settings' }).click();
  await expect(current).toHaveText('Speed');
  await tabs.getByRole('tab', { name: 'Filament' }).click();
  await expect(current).toHaveText('Cooling');
});

test('an edited setting is used by the next slice, and can be reset to the system value', async ({ page }) => {
  await ready(page);
  await page.getByTestId('file-input').setInputFiles({ name: 'box.stl', mimeType: 'model/stl', buffer: boxStl(20, 20, 10) });
  await page.getByTestId('edit-print').click();
  const lh = await field(page, 'layer_height');
  await lh.locator('input').fill('0.25');
  await lh.locator('input').press('Enter');
  await expect(lh).toHaveClass(/dirty/);
  await expect(page.getByTestId('settings-preset')).toHaveText(/\(modified\)$/);
  await page.getByRole('tab', { name: 'Prepare' }).click();

  const g = await sliceText(page);
  expect(g).toContain('; layer_height = 0.25');
  expect(g.match(/^;LAYER_CHANGE$/gm)).toHaveLength(40);

  await page.getByTestId('edit-print').click();
  await (await field(page, 'layer_height')).getByRole('button', { name: /Reset Layer height/ }).click();
  await expect((await field(page, 'layer_height')).locator('input')).toHaveValue('0.2');
  await expect(page.getByTestId('settings-preset')).not.toHaveText(/modified/);
});

test('settings that do not apply are hidden or greyed out, as on desktop', async ({ page }) => {
  await ready(page);
  await page.getByTestId('edit-print').click();
  await page.getByTestId('settings-search').fill('ironing');
  await expect(await field(page, 'ironing_type')).toBeVisible();
  await expect(await field(page, 'ironing_flow')).toHaveCount(0);
  await choose((await field(page, 'ironing_type')).getByRole('combobox'), 'top');
  await expect(await field(page, 'ironing_flow')).toBeVisible();

  await page.getByTestId('settings-search').fill('wall loops');
  const loops = (await field(page, 'wall_loops')).locator('input');
  await loops.fill('0');
  await loops.press('Enter');
  await page.getByTestId('settings-search').fill('seam position');
  const seam = await field(page, 'seam_position');
  await expect(seam).toHaveClass(/\boff\b/);
  await expect(seam.getByRole('combobox')).toBeDisabled();
  // Why it doesn't apply, then what it does, behind its "?".
  const help = seam.locator('.field-label .help');
  await expect(help).toHaveAttribute('data-tip', /wall loops[\s\S]*\n\n\S/i);
  await help.hover();
  await expect(page.getByRole('tooltip')).toContainText(/wall loops/i, { timeout: 1000 });
});

test('a setting’s description shows from its name, by pointer, in both themes', async ({ page }) => {
  await ready(page);
  await page.getByTestId('edit-print').click();
  const lh = await field(page, 'layer_height');
  const help = lh.locator('.field-label .help');
  const tip = page.getByRole('tooltip');
  await help.hover();
  await expect(tip).toContainText('height for each layer', { timeout: 1000 });
  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => {
      document.documentElement.dataset.theme = t;
    }, theme);
    await page.mouse.move(5, 5);
    await expect(tip).toBeHidden();
    await help.hover();
    await expect(tip).toBeVisible({ timeout: 1000 });
  }
  // Without a wiki page, a click shows the description in the documentation panel.
  await page.mouse.move(5, 5);
  await (await field(page, 'enable_mixed_color_sublayer')).locator('.field-label .help').click();
  const docs = page.getByTestId('docs-panel');
  await expect(docs.getByRole('heading', { level: 2 })).toHaveText('Mixed color sublayer');
  await expect(docs.locator('.docs-text')).not.toBeEmpty();
  await expect(docs.getByRole('link', { name: 'Open in the wiki' })).toHaveCount(0);
});

test('settings fill the window, and the preset name switches presets', async ({ page }) => {
  await ready(page);
  await page.getByTestId('edit-print').click();
  await expect(page.getByTestId('viewport')).toBeHidden();
  const box = (await page.getByTestId('settings').boundingBox())!;
  expect(box.x).toBe(0);
  const header = page.getByTestId('settings-preset');
  const other = (await options(header, { values: true })).find((v) => v !== '0.20mm Standard @MyKlipper');
  await choose(header, other!);
  await expect(page.getByTestId('process')).toHaveAttribute('data-value', other!);
  await expect(page.getByTestId('settings-preset')).toHaveAttribute('data-value', other!);
  const lh = (await field(page, 'layer_height')).locator('input');
  const expected = /(\d\.\d+)mm/.exec(other!)?.[1];
  if (expected) await expect(lh).toHaveValue(String(Number(expected)));
  await page.getByRole('tab', { name: 'Prepare' }).click();
  await expect(page.getByTestId('viewport')).toBeVisible();
});

test('switching to another process asks before discarding unsaved edits', async ({ page }) => {
  await ready(page);
  await page.getByTestId('edit-print').click();
  const lh = (await field(page, 'layer_height')).locator('input');
  await lh.fill('0.25');
  await lh.press('Enter');
  await expect(page.getByTestId('settings-preset')).toHaveText(/\(modified\)$/);
  await page.getByRole('tab', { name: 'Prepare' }).click();

  // Another filament does not touch the process edits, so nothing is asked.
  const filament = page.getByTestId('filament');
  const current = await value(filament);
  const otherFilament = (await options(filament, { values: true })).find((v) => v && v !== current);
  await choose(filament, otherFilament!);
  await expect(filament).toHaveAttribute('data-value', otherFilament!);
  await expect(page.getByTestId('confirm')).toHaveCount(0);

  const process = page.getByTestId('process');
  const other = (await options(process, { values: true })).find((v) => v !== '0.20mm Standard @MyKlipper');
  await choose(process, other!);
  await answer(page, 'Cancel', 'Discard unsaved changes to 0.20mm Standard @MyKlipper?');
  await expect(process).toHaveAttribute('data-value', '0.20mm Standard @MyKlipper');
  await page.getByTestId('edit-print').click();
  await expect((await field(page, 'layer_height')).locator('input')).toHaveValue('0.25');

  await page.getByRole('tab', { name: 'Prepare' }).click();
  await choose(process, other!);
  await answer(page, 'Discard');
  await expect(process).toHaveAttribute('data-value', other!);
});

test('another nozzle keeps unsaved print settings that fit it', async ({ page }) => {
  await ready(page);
  await page.getByTestId('edit-print').click();
  const lh = (await field(page, 'layer_height')).locator('input');
  await lh.fill('0.25');
  await lh.press('Enter');
  await page.getByRole('tab', { name: 'Prepare' }).click();

  const nozzle = page.getByTestId('nozzle');
  await choose(nozzle, '0.6');
  await expect(nozzle).toHaveAttribute('data-value', '0.6');
  await expect(page.getByTestId('confirm')).toHaveCount(0);
  await page.getByTestId('edit-print').click();
  await expect((await field(page, 'layer_height')).locator('input')).toHaveValue('0.25');

  // 0.20mm Standard is not for a 0.2 nozzle: its edits would be lost.
  await page.getByRole('tab', { name: 'Prepare' }).click();
  await choose(nozzle, '0.2');
  await answer(page, 'Discard', 'Discard unsaved changes to 0.20mm Standard @MyKlipper?');
  await expect(nozzle).toHaveAttribute('data-value', '0.2');
  await expect(page.getByTestId('process')).not.toHaveAttribute('data-value', '0.20mm Standard @MyKlipper');
});

test('save as a user preset, keep it across reloads, export and delete it', async ({ page }) => {
  await ready(page);
  await page.getByTestId('edit-print').click();
  const density = await field(page, 'sparse_infill_density');
  await page.getByTestId('settings-search').fill('sparse infill density');
  await density.locator('input').fill('30%');
  await density.locator('input').press('Enter');
  await expect(density).toHaveClass(/dirty/);
  await page.getByRole('button', { name: 'Save as…' }).click();
  await page.getByTestId('settings-name').fill('My strong process');
  await page.getByRole('button', { name: 'Save', exact: true }).last().click();
  await expect(page.getByTestId('settings-preset')).toHaveAttribute('data-value', 'My strong process');
  await expect(page.getByTestId('process')).toHaveAttribute('data-value', 'My strong process');

  await page.reload();
  await expect(page.getByTestId('app')).toHaveAttribute('data-engine-ready', 'yes');
  await expect(page.getByTestId('process')).toHaveAttribute('data-value', 'My strong process');

  await page.getByTestId('edit-print').click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('settings').getByRole('button', { name: 'Export', exact: true }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('My strong process.json');
  const json = JSON.parse(await (await download.createReadStream()).toArray().then((c) => Buffer.concat(c).toString('utf8')));
  expect(json).toMatchObject({
    from: 'User',
    inherits: '0.20mm Standard @MyKlipper',
    name: 'My strong process',
    sparse_infill_density: '30%',
  });

  await page.getByTestId('settings').getByRole('button', { name: 'Delete', exact: true }).click();
  await answer(page, 'Delete');
  await expect(page.getByTestId('settings-preset')).not.toHaveAttribute('data-value', 'My strong process');
  // The header lists the same presets as the hidden Prepare dropdown.
  await expect.poll(() => options(page.getByTestId('settings-preset'))).not.toContain('My strong process');
});

test('a desktop user preset file can be imported and sliced with', async ({ page }) => {
  await ready(page);
  // The format desktop OrcaSlicer writes for a user process preset.
  const preset = {
    from: 'User',
    inherits: '0.20mm Standard @MyKlipper',
    name: 'Desktop fine',
    layer_height: '0.12',
    print_settings_id: 'Desktop fine',
    version: '2.5.0.0',
  };
  await page.getByTestId('edit-print').click();
  await page
    .getByTestId('settings-import')
    .setInputFiles({ name: 'Desktop fine.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(preset, null, 4)) });
  await expect(page.getByTestId('notice-info')).toContainText('Desktop fine');
  await page.getByRole('tab', { name: 'Prepare' }).click();
  await choose(page.getByTestId('process'), 'Desktop fine');
  await expect(page.getByTestId('process')).toHaveAttribute('data-value', 'Desktop fine');
  await page.getByTestId('file-input').setInputFiles({ name: 'box.stl', mimeType: 'model/stl', buffer: boxStl(20, 20, 6) });
  const g = await sliceText(page);
  expect(g).toContain('; layer_height = 0.12');
  expect(g).toContain('; print_settings_id = Desktop fine');
});

test('bed shape, excluded area and collision volumes are edited visually', async ({ page }) => {
  await ready(page);
  await page.getByTestId('edit-printer').click();
  await page.getByTestId('settings-search').fill('area');

  // Bed shape: rectangle → round.
  await expect(page.getByTestId('edit-printable_area')).toContainText('250 × 250 mm');
  await page.getByTestId('edit-printable_area').click();
  // The preview follows a typed number once it is entered, not on every keystroke.
  const dims = page.locator('.bed-dims text').first();
  await page.getByTestId('bed-width').fill('300');
  await expect(dims).toHaveText('250 mm');
  await page.getByTestId('bed-width').press('Enter');
  await expect(dims).toHaveText('300 mm');
  await page.getByRole('radio', { name: 'Round' }).click();
  await page.getByTestId('bed-diameter').fill('220');
  await page.getByTestId('bed-apply').click();
  await expect(page.getByTestId('edit-printable_area')).toContainText('Round, Ø 220 mm');
  await expect(await field(page, 'printable_area')).toHaveClass(/dirty/);

  // Excluded area: a rectangle.
  await page.getByTestId('edit-bed_exclude_area').click();
  await page.getByRole('radio', { name: 'Rectangle' }).click();
  await page.getByTestId('bed-apply').click();
  await expect(page.getByTestId('edit-bed_exclude_area')).toContainText(/mm at /);

  // Collision volumes: one, limited in height.
  await page.getByTestId('settings-search').fill('collision');
  await page.getByTestId('edit-bed_exclude_volumes').click();
  await page.getByTestId('bed-add-volume').click();
  await page.getByRole('radio', { name: 'Height range' }).click();
  await page.getByTestId('bed-apply').click();
  await expect(page.getByTestId('edit-bed_exclude_volumes')).toContainText('1 volume');

  // The composed config the next slice uses, in desktop's formats.
  const cfg = await page.evaluate(() =>
    JSON.parse(
      (window as unknown as { __orca: { store: { getState(): { presets: { config: string } } } } }).__orca.store.getState().presets.config,
    ),
  );
  expect(cfg.printable_area).toHaveLength(72);
  // Desktop's own arithmetic, serialized the same way (110·sin 2π is not exactly 0).
  expect(cfg.printable_area[71]).toBe('110x-2.69422e-14');
  expect(cfg.bed_exclude_area).toEqual(['-110x-110', '-66x-110', '-66x-66', '-110x-66']);
  expect(cfg.bed_exclude_volumes).toBe('0..250;-110x-110, -66x-110, -66x-66, -110x-66');
});

test('G-code is edited as lines, and saved with escaped line breaks like desktop', async ({ page }) => {
  await ready(page);
  await page.getByTestId('edit-printer').click();
  await page.getByTestId('settings-search').fill('start g-code');
  const box = (await field(page, 'machine_start_gcode')).locator('textarea');
  await expect(box).toBeVisible();
  const text = await box.inputValue();
  expect(text).toContain('\n');
  expect(text).not.toContain('\\n');
  await box.fill('G28 ; home\nM104 S[nozzle_temperature_initial_layer] ; a\\b');
  await box.blur();
  await page.getByRole('tab', { name: 'Prepare' }).click();
  await page.getByTestId('edit-printer').click();
  await page.getByTestId('settings-search').fill('start g-code');
  await expect(page.locator('.settings .field[data-key="machine_start_gcode"] .hl-cmd').first()).toHaveText('G28');
  await expect((await field(page, 'machine_start_gcode')).locator('textarea')).toHaveValue(
    'G28 ; home\nM104 S[nozzle_temperature_initial_layer] ; a\\b',
  );
});

test('options desktop shows in one row carry the row’s label; a hidden row hides all of them', async ({ page }) => {
  await ready(page);
  await page.getByTestId('edit-filament').click();
  // Only the printer's bed type (no multiple bed types): one plate, both of its temperatures,
  // without the plate's name.
  const bed = page
    .locator('.settings-group', { has: page.locator('.field[data-key="hot_plate_temp"]') })
    .locator('.field .field-label .name');
  await expect(bed).toHaveText(['First layer', 'Other layers']);
  await expect((await field(page, 'nozzle_temperature')).locator('.field-label .name')).toHaveText('Nozzle – Other layers');
  // With multiple bed types, every plate's row, by name.
  const tabs = page.getByTestId('settings');
  await tabs.getByRole('tab', { name: 'Printer' }).click();
  await page.getByTestId('settings-search').fill('support_multi_bed_types');
  const multi = (await field(page, 'support_multi_bed_types')).locator('input');
  await multi.click();
  await expect(multi).toBeChecked();
  await page.getByTestId('settings-search').fill('');
  await tabs.getByRole('tab', { name: 'Filament' }).click();
  await expect(bed).toHaveCount(12);
  await expect(bed.nth(8)).toHaveText('Smooth PEI Plate / High Temp Plate – First layer');
});

test('information closes by itself after a few seconds, not while the pointer is on it', async ({ page }) => {
  await ready(page);
  await page.getByTestId('edit-print').click();
  const preset = {
    from: 'User',
    inherits: '0.20mm Standard @MyKlipper',
    name: 'Timed',
    layer_height: '0.12',
    print_settings_id: 'Timed',
    version: '2.5.0.0',
  };
  await page
    .getByTestId('settings-import')
    .setInputFiles({ name: 'Timed.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(preset)) });
  const notice = page.getByTestId('notice-info');
  await expect(notice.locator('.notice-timer')).toBeVisible();
  await notice.hover();
  await page.waitForTimeout(6000);
  await expect(notice).toBeVisible();
  await page.mouse.move(5, 5);
  await expect(notice).toBeHidden({ timeout: 7000 });
});

test('clicking a setting’s name opens the setting’s section of the OrcaSlicer wiki beside the settings', async ({ page }) => {
  // A stand-in for the wiki page (the app fetches it from GitHub when shown).
  const md = [
    '# Seam',
    'Intro.',
    '- [Seam Position](#seam-position)',
    '## Seam Position',
    '[Mode](option_mode): `Simple`.  ',
    '[Variable](built_in_placeholders_variables): `seam_position`.  ',
    'Where seams go. See [modes](option_mode) and [Aligned](#aligned).',
    '![pic](https://github.com/OrcaSlicer/OrcaSlicer_WIKI/blob/main/images/seam/seam-aligned.png?raw=true)',
    '> [!NOTE]',
    '> Painted seams win.',
    '### Aligned',
    'Lines up seams.',
    '## Modifiers',
    'Not this part.',
  ].join('\n');
  await page.route('https://raw.githubusercontent.com/OrcaSlicer/OrcaSlicer_WIKI/**/*.md', (r) =>
    r.request().url().endsWith('quality_settings_seam.md')
      ? r.fulfill({ body: md, contentType: 'text/plain', headers: { 'Access-Control-Allow-Origin': '*' } })
      : r.fulfill({ status: 404, headers: { 'Access-Control-Allow-Origin': '*' } }),
  );
  await page.route('https://github.com/OrcaSlicer/OrcaSlicer_WIKI/**', (r) => r.fulfill({ status: 404 }));
  await ready(page);
  await page.getByTestId('edit-print').click();
  await page.getByTestId('settings-search').fill('seam position');
  await (await field(page, 'seam_position')).locator('.field-label .help').click();
  const docs = page.getByTestId('docs-panel');
  await expect(docs.getByRole('heading', { level: 2 })).toHaveText('Seam Position');
  // Its section only, with the subsections; pictures and callouts kept.
  await expect(docs).toContainText('Where seams go.');
  await expect(docs).toContainText('Lines up seams.');
  await expect(docs).not.toContainText('Not this part.');
  // The option's reference (mode, variable, …) folded into a "Details" after the text.
  const ref = docs.locator('details.docs-ref');
  await expect(ref.locator('summary')).toHaveText('Details');
  await expect(ref.locator('td').first()).toBeHidden();
  await expect(docs.locator('.docs-text > p').first()).toContainText('Where seams go.');
  await ref.locator('summary').click();
  await expect(ref.locator('tr')).toHaveText(['ModeSimple', 'Variableseam_position']);
  await expect(docs.locator('img')).toHaveAttribute(
    'src',
    'https://raw.githubusercontent.com/OrcaSlicer/OrcaSlicer_WIKI/main/images/seam/seam-aligned.png',
  );
  await expect(docs.locator('blockquote.callout.note')).toContainText('Painted seams win.');
  await expect(docs.getByRole('link', { name: 'Open in the wiki' })).toHaveAttribute(
    'href',
    'https://www.orcaslicer.com/wiki/quality_settings_seam#seam-position',
  );
  // A link within the page opens here, with a way back.
  await docs.getByRole('link', { name: 'Aligned' }).click();
  await expect(docs.getByRole('heading', { level: 2 })).toHaveText('Aligned');
  await docs.getByRole('button', { name: 'Back' }).click();
  await expect(docs.getByRole('heading', { level: 2 })).toHaveText('Seam Position');
  // Other wiki pages open here too; only other sites leave.
  await expect(docs.getByRole('link', { name: 'modes' })).toHaveAttribute('data-doc', 'option_mode');
  // A page the wiki doesn't answer for.
  await page.getByTestId('settings-search').fill('');
  await (await field(page, 'layer_height')).locator('.field-label .help').click();
  await expect(docs).toContainText('Could not load the documentation.');
  await docs.press('Escape');
  await expect(docs).toBeHidden();
});

test('a percentage shows as its number beside the % unit, as desktop', async ({ page }) => {
  await ready(page);
  await page.getByTestId('edit-print').click();
  await page.getByTestId('settings-search').fill('sparse infill density');
  const input = (await field(page, 'sparse_infill_density')).locator('input');
  await expect(input).toHaveValue(/^\d+$/);
  const stored = () =>
    page.evaluate(
      () =>
        JSON.parse(
          (window as unknown as { __orca: { store: { getState(): { presets: { config: string } } } } }).__orca.store.getState().presets
            .config,
        ).sparse_infill_density,
    );
  await input.fill('25');
  await input.press('Enter');
  await expect.poll(stored).toBe('25%');
  await expect(input).toHaveValue('25');
  // Typed with its sign, too.
  await input.fill('30%');
  await input.press('Enter');
  await expect.poll(stored).toBe('30%');
  await expect(input).toHaveValue('30');
});

test('the settings mode shows simple, advanced or expert settings, as on desktop', async ({ page }) => {
  await ready(page);
  await page.getByTestId('tab-settings').click();
  const mode = page.getByTestId('settings-mode');
  // Quality: line widths are advanced, Z contouring expert.
  await expect(mode.getByRole('radio', { name: 'Simple' })).toBeChecked();
  await expect(await field(page, 'layer_height')).toBeVisible();
  await expect(await field(page, 'line_width')).toHaveCount(0);
  await mode.getByRole('radio', { name: 'Advanced' }).click();
  await expect(await field(page, 'line_width')).toBeVisible();
  await expect(await field(page, 'zaa_enabled')).toHaveCount(0);
  await mode.getByRole('radio', { name: 'Expert' }).click();
  await expect(await field(page, 'zaa_enabled')).toBeVisible();
  await expect(mode.getByRole('radio', { name: 'Expert' })).toHaveAttribute('data-tip', 'Expert settings');

  // Kept for next time.
  await page.reload();
  await expect(page.getByTestId('app')).toHaveAttribute('data-engine-ready', 'yes');
  await page.getByTestId('tab-settings').click();
  await expect(mode.getByRole('radio', { name: 'Expert' })).toBeChecked();
  await mode.getByRole('radio', { name: 'Simple' }).click();

  // A search finds the settings of every mode.
  await page.getByTestId('settings-search').fill('zaa_enabled');
  await expect(await field(page, 'zaa_enabled')).toBeVisible();
});

test('a number out of range or not a number is refused, as on desktop; a decimal comma is read', async ({ page }) => {
  await ready(page);
  await page.getByTestId('edit-print').click();
  const row = await field(page, 'layer_height');
  const lh = row.locator('input');
  for (const [typed, message] of [
    ['-1', 'Value is out of range.'],
    ['0', 'Value is out of range.'],
    ['abc', 'Invalid numeric.'],
  ] as const) {
    await lh.fill(typed);
    await lh.press('Enter');
    await expect(row).toContainText(message);
    await expect(row).not.toHaveClass(/dirty/);
  }
  await lh.fill('0,24');
  await lh.press('Enter');
  await expect(lh).toHaveValue('0.24');
  await expect(row).toHaveClass(/dirty/);

  await page.getByRole('tab', { name: 'Prepare' }).click();
  await page.getByTestId('file-input').setInputFiles({ name: 'box.stl', mimeType: 'model/stl', buffer: boxStl(20, 20, 5) });
  expect(await sliceText(page)).toMatch(/^; layer_height = 0\.24$/m);
});

test('a changed setting of the extruder is marked and can be undone', async ({ page }) => {
  await ready(page);
  await page.getByTestId('edit-printer').click();
  await page.getByTestId('settings-search').fill('retraction_length');
  const row = (await field(page, 'retraction_length')).first();
  const input = row.locator('input').first();
  const saved = await input.inputValue();
  await input.fill('1.3');
  await input.press('Enter');
  await expect(row).toHaveClass(/dirty/);
  await row.getByRole('button', { name: /^Undo/ }).click();
  await expect(input).toHaveValue(saved);
  await expect(row).not.toHaveClass(/dirty/);
});

test('only a filament’s overrides can be handed back to the printer', async ({ page }) => {
  await ready(page);
  await page.getByTestId('edit-print').click();
  await page.getByTestId('settings-mode-expert').click();
  const handBack = page.getByTestId('settings').getByRole('button', { name: 'Remove override' });
  const override = page.getByTestId('settings').getByRole('button', { name: 'Override', exact: true });
  const pages = page.locator('.settings-pages button');
  for (const type of ['Print settings', 'Printer']) {
    await page.getByTestId('settings').getByRole('tab', { name: type }).click();
    for (let i = 0; i < (await pages.count()); i++) {
      await pages.nth(i).click();
      await expect(handBack).toHaveCount(0);
    }
  }
  await page.getByTestId('settings').getByRole('tab', { name: 'Filament' }).click();
  await page.locator('.settings-pages button', { hasText: 'Setting Overrides' }).click();
  expect((await handBack.count()) + (await override.count())).toBeGreaterThan(0);
});

test('a preset name that cannot be saved is said by the field; Escape closes the form', async ({ page }) => {
  await ready(page);
  await page.getByTestId('edit-print').click();
  await page.getByRole('button', { name: 'Save as…' }).click();
  const name = page.getByTestId('settings-name');
  await name.fill('a/b');
  await name.press('Enter');
  await expect(page.getByTestId('save-as-error')).toHaveText('Use letters, numbers and spaces in the name.');
  await name.fill('x'.repeat(300));
  await name.press('Enter');
  await expect(page.getByTestId('save-as-error')).toHaveText('The name is too long.');
  await expect(page.getByTestId('settings-preset')).toHaveAttribute('data-value', '0.20mm Standard @MyKlipper');
  await name.press('Escape');
  await expect(page.getByTestId('save-as-form')).toHaveCount(0);
  await expect(page.getByTestId('settings')).toBeVisible();

  // Saving over another preset of the user asks first.
  for (const preset of ['First', 'Second']) {
    await page.getByRole('button', { name: 'Save as…' }).click();
    await name.fill(preset);
    await name.press('Enter');
    await expect(page.getByTestId('settings-preset')).toHaveAttribute('data-value', preset);
  }
  await page.getByRole('button', { name: 'Save as…' }).click();
  await name.fill('First');
  await name.press('Enter');
  await answer(page, 'Cancel', 'These presets exist already: First. Replace them?');
  await expect(page.getByTestId('save-as-form')).toBeVisible();
  await expect(page.getByTestId('settings-preset')).toHaveAttribute('data-value', 'Second');

  // The form belongs to its preset type.
  await page.getByTestId('settings').getByRole('tab', { name: 'Filament' }).click();
  await expect(page.getByTestId('save-as-form')).toHaveCount(0);
});

test('renaming a preset asks before the unsaved edits of the others are lost', async ({ page }) => {
  await ready(page);
  await page.getByTestId('edit-print').click();
  await page.getByRole('button', { name: 'Save as…' }).click();
  await page.getByTestId('settings-name').fill('My process');
  await page.getByTestId('settings-name').press('Enter');
  await expect(page.getByTestId('settings-preset')).toHaveAttribute('data-value', 'My process');

  await page.getByTestId('settings').getByRole('tab', { name: 'Filament' }).click();
  await page.getByTestId('settings-search').fill('filament_cost');
  const cost = (await field(page, 'filament_cost')).locator('input').first();
  await cost.fill('77');
  await cost.press('Enter');
  await page.getByTestId('settings-search').fill('');

  await page.getByTestId('settings').getByRole('tab', { name: 'Print settings' }).click();
  await page.getByTestId('settings-rename').click();
  await page.getByTestId('rename-name').fill('Renamed process');
  await page.getByRole('button', { name: 'Rename', exact: true }).click();
  await answer(page, 'Cancel', /Discard unsaved changes to /);
  await expect(page.getByTestId('settings-preset')).toHaveAttribute('data-value', 'My process');
  await page.getByTestId('settings').getByRole('tab', { name: 'Filament' }).click();
  await page.getByTestId('settings-search').fill('filament_cost');
  await expect((await field(page, 'filament_cost')).locator('input').first()).toHaveValue('77');
});

test('the user’s own print settings and filaments can be renamed', async ({ page }) => {
  await ready(page);
  await page.getByTestId('edit-print').click();
  // A system preset has no rename.
  await expect(page.getByTestId('settings-rename')).toHaveCount(0);
  await page.getByRole('button', { name: 'Save as…' }).click();
  await page.getByTestId('settings-name').fill('My process');
  await page.getByRole('button', { name: 'Save', exact: true }).last().click();
  await expect(page.getByTestId('settings-preset')).toHaveAttribute('data-value', 'My process');

  // A name in use: said by the field, the form stays.
  await page.getByTestId('settings-rename').click();
  await page.getByTestId('rename-name').fill('0.20mm Standard @MyKlipper');
  await page.getByRole('button', { name: 'Rename', exact: true }).click();
  await expect(page.getByTestId('rename-error')).toHaveText('A preset with this name exists already.');
  await page.getByTestId('rename-name').fill('Renamed process');
  await page.getByRole('button', { name: 'Rename', exact: true }).click();
  await expect(page.getByTestId('settings-preset')).toHaveAttribute('data-value', 'Renamed process');
  await expect(page.getByTestId('rename-preset-form')).toHaveCount(0);

  // A filament may have the same name; it is renamed apart.
  await page.getByTestId('settings').getByRole('tab', { name: 'Filament' }).click();
  await page.getByRole('button', { name: 'Save as…' }).click();
  await page.getByTestId('settings-name').fill('My PLA');
  await page.getByRole('button', { name: 'Save', exact: true }).last().click();
  await page.getByTestId('settings-rename').click();
  await page.getByTestId('rename-name').fill('Renamed process');
  await page.getByRole('button', { name: 'Rename', exact: true }).click();
  await expect(page.getByTestId('settings-preset')).toHaveAttribute('data-value', 'Renamed process');

  // Kept across reloads, still selected.
  await page.reload();
  await expect(page.getByTestId('app')).toHaveAttribute('data-engine-ready', 'yes');
  await expect(page.getByTestId('process')).toHaveAttribute('data-value', 'Renamed process');
  await expect(page.getByTestId('filament')).toHaveAttribute('data-value', 'Renamed process');
  expect(await options(page.getByTestId('process'))).not.toContain('My process');
});

test('compare presets side by side: the other preset’s values beside these, and taken over with a click', async ({ page }) => {
  await ready(page);
  await page.getByTestId('tab-settings').click();
  await page.getByTestId('settings-compare').click();
  await choose(page.getByTestId('settings-compare-with'), '0.12mm Fine @MyKlipper');
  const lh = await field(page, 'layer_height');
  await expect(lh.getByTestId('other-value')).toContainText('0.12');
  await expect(lh).toHaveClass(/differs/);
  // One setting taken over: an unsaved edit of the selected preset.
  await lh.getByTestId('use-other').click();
  await expect(lh.locator('input')).toHaveValue('0.12');
  await expect(lh).not.toHaveClass(/differs/);
  await expect(page.getByTestId('settings-preset')).toHaveAttribute('data-value', '0.20mm Standard @MyKlipper');
  await expect(page.getByTestId('settings-save')).toBeEnabled();
  // Only the differences, from every page; then all of them taken over.
  await page.getByTestId('settings-only-diff').check();
  await expect(page.locator('.settings .field[data-key="wall_loops"]')).toBeVisible();
  await expect(page.locator('.settings .field[data-key="layer_height"]')).toHaveCount(0);
  await page.getByTestId('settings-copy-all').click();
  await expect(page.getByText('No matching settings.')).toBeVisible();
  await expect(page.getByTestId('settings-copy-all')).toBeDisabled();
  // Every preset of the type, also those for other printers.
  await page.getByTestId('settings-compare-all').check();
  await choose(page.getByTestId('settings-compare-with'), '0.12mm Fine @MyMarlin');
  await expect(page.getByTestId('settings-compare-with')).toHaveAttribute('data-value', '0.12mm Fine @MyMarlin');
  // Still comparing on another tab. A printer of a vendor that is not loaded: its profiles are loaded aside.
  await page.getByRole('tab', { name: 'Printer' }).click();
  await expect(page.getByTestId('settings-compare-bar')).toBeVisible();
  await choose(page.getByTestId('settings-compare-with'), 'Anker M5 0.4 nozzle');
  await expect(page.locator('.settings .field.differs').first()).toBeVisible();
  await expect(page.getByTestId('settings-preset')).toHaveAttribute('data-value', 'MyKlipper 0.4 nozzle');
});
