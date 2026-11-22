// Printers are linked to printer presets (desktop's physical printers): G-code goes only to the
// printers of the preset it was sliced with. Optionally synced through Google Drive. The printer
// is a fake Moonraker.
// SPDX-License-Identifier: AGPL-3.0-or-later
import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import { FakeDrive } from './fakeDrive';
import { boxStl } from './models';
import { choose, options } from './select';

/** A Moonraker that answers everything: ready, nothing printing, uploads taken. */
async function fakePrinters(context: BrowserContext) {
  await context.route(/^http:\/\/printer-[a-z]\.test\//, (route) =>
    route.fulfill({
      status: 200,
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        result: { moonraker_version: 'v0.9', status: { webhooks: { state: 'ready' }, print_stats: { state: 'standby' } } },
      }),
    }),
  );
}

async function open(page: Page) {
  await page.goto('/');
  await expect(page.getByTestId('app')).toHaveAttribute('data-engine-ready', 'yes');
  await expect(page.getByTestId('process')).not.toHaveAttribute('data-value', '');
}

test('G-code goes only to the printers of its preset', async ({ page, context }) => {
  await fakePrinters(context);
  await open(page);
  const preset = (await page.getByTestId('printer').getAttribute('data-value'))!;
  await page.evaluate(
    (preset) =>
      localStorage.setItem(
        'dolphin-slicer.printers.v1',
        JSON.stringify({
          printers: [
            { id: 'a', name: 'Printer A', kind: 'moonraker', url: 'http://printer-a.test', presets: [preset] },
            { id: 'b', name: 'Printer B', kind: 'moonraker', url: 'http://printer-b.test', presets: ['Some other printer'] },
          ],
        }),
      ),
    preset,
  );
  await open(page);
  await page.getByTestId('file-input').setInputFiles({ name: 'cube.stl', mimeType: 'model/stl', buffer: boxStl() });
  await page.getByTestId('slice').click();
  await expect(page.getByTestId('download')).toBeEnabled();

  // Printer B has another preset: it can't be chosen.
  await page.getByTestId('send').click();
  const dialog = page.getByTestId('send-dialog');
  await expect(dialog.getByTestId('send-printer')).toContainText('Printer A');
  await expect(dialog.getByTestId('send-fits')).toContainText(`Sliced for ${preset}.`);
  expect(await options(dialog.getByTestId('send-printer'))).toEqual(['Printer A']);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');

  // Link B to this preset too (one preset at least).
  await page.getByTestId('open-printers').click();
  await page.getByTestId('printer-edit').nth(1).click();
  const presets = page.getByTestId('printer-presets');
  await expect(presets.getByRole('checkbox', { name: 'Some other printer' })).toBeChecked();
  await expect(presets.getByRole('checkbox', { name: preset })).not.toBeChecked();
  await presets.getByRole('checkbox', { name: 'Some other printer' }).uncheck();
  await page.getByTestId('printer-save').click();
  await expect(page.getByTestId('printer-result')).toHaveText('Choose at least one printer preset.');
  await expect(page.getByTestId('printer-result')).toHaveClass(/error/);
  await presets.getByRole('checkbox', { name: preset }).check();
  // Not signed in to Drive: nothing to sync with.
  await expect(page.getByTestId('printer-sync')).toHaveCount(0);
  await page.getByTestId('printer-save').click();
  await expect(page.getByTestId('printer-list')).toBeVisible();
  await page.keyboard.press('Escape');

  await page.getByTestId('send').click();
  await expect(dialog.getByTestId('send-fits')).toHaveCount(0);
  expect(await options(dialog.getByTestId('send-printer'))).toEqual(['Printer A', 'Printer B']);

  // A new printer starts with the preset the G-code is for.
  await dialog.getByRole('button', { name: 'Add printer' }).click();
  await expect(dialog.getByTestId('printer-presets').getByRole('checkbox', { name: preset })).toBeChecked();
});

test('a new variant of a printer goes to the printers linked to it', async ({ page }) => {
  await open(page);
  const preset = (await page.getByTestId('printer').getAttribute('data-value'))!;
  await page.evaluate(
    (preset) =>
      localStorage.setItem(
        'dolphin-slicer.printers.v1',
        JSON.stringify({
          printers: [
            { id: 'a', name: 'Printer A', kind: 'moonraker', url: 'http://printer-a.test', presets: [preset] },
            { id: 'b', name: 'Printer B', kind: 'moonraker', url: 'http://printer-b.test', presets: ['Some other printer'] },
          ],
        }),
      ),
    preset,
  );
  await open(page);
  await choose(page.getByTestId('nozzle'), { label: 'Create variant…' });
  const form = page.getByTestId('wizard');
  await form.getByTestId('create-nozzle').fill('0.3');
  await form.getByTestId('create-next').click();
  await form.getByTestId('create-submit').click();
  await expect(form).toHaveCount(0);
  const variant = (await page.getByTestId('printer').getAttribute('data-value'))!;
  expect(variant).toMatch(/0\.3 nozzle$/);

  await page.getByTestId('open-printers').click();
  await page.getByTestId('printer-edit').first().click();
  const presets = page.getByTestId('printer-presets');
  await expect(presets.getByRole('checkbox', { name: preset })).toBeChecked();
  await expect(presets.getByRole('checkbox', { name: variant })).toBeChecked();
  // Printer B has none of the model's presets.
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('dolphin-slicer.printers.v1')!));
  expect(saved.printers.map((p: { presets: string[] }) => p.presets)).toEqual([[preset, variant], ['Some other printer']]);
});

test('a printer that is off can still be saved', async ({ page }) => {
  await open(page);
  await page.getByTestId('open-printers').click();
  await page.getByTestId('printer-url').fill('http://printer-off.invalid');
  await page.getByTestId('printer-name').fill('Off');
  await page.getByTestId('printer-test').click();
  await expect(page.getByTestId('printer-result')).toContainText('Could not reach the printer');
  await page.getByTestId('printer-save').click();
  const row = page.getByTestId('printer-row');
  await expect(row).toContainText('Off');
  await expect(row.getByTestId('printer-state')).toHaveText('Unreachable');
});

test('G-code opened from a file goes to the printers of the preset it names', async ({ page }) => {
  await open(page);
  await page.evaluate(() =>
    localStorage.setItem(
      'dolphin-slicer.printers.v1',
      JSON.stringify({
        printers: [
          { id: 'a', name: 'Printer A', kind: 'moonraker', url: 'http://printer-a.test', presets: ['Voron 2.4 350 0.4 nozzle'] },
          { id: 'b', name: 'Printer B', kind: 'moonraker', url: 'http://printer-b.test', presets: ['Prusa MK4 0.4 nozzle'] },
        ],
      }),
    ),
  );
  await open(page);
  const gcode =
    'G1 Z0.2 F600\nG1 X10 Y10 E1 F1200\n; CONFIG_BLOCK_START\n; printer_settings_id = Prusa MK4 0.4 nozzle\n; CONFIG_BLOCK_END\n';
  await page.getByTestId('gcode-input').setInputFiles({ name: 'part.gcode', mimeType: 'text/plain', buffer: Buffer.from(gcode) });
  await page.getByTestId('send').click();
  const dialog = page.getByTestId('send-dialog');
  await expect(dialog.getByTestId('send-printer')).toContainText('Printer B');
  await expect(dialog.getByTestId('send-fits')).toContainText('Sliced for Prusa MK4 0.4 nozzle.');
});

test('a printer can be synced through Google Drive, API key included', async ({ browser, baseURL }) => {
  test.skip(test.info().project.name !== 'mt', 'once is enough');
  const drive = new FakeDrive();
  const device = async () => {
    const context = await browser.newContext({ baseURL, storageState: test.info().project.use.storageState });
    await drive.attach(context, new URL(baseURL!).origin);
    await fakePrinters(context);
    const page = await context.newPage();
    await open(page);
    await page.getByTestId('open-preferences').click();
    const popup = page.waitForEvent('popup');
    await page.getByTestId('drive-connect').click();
    await expect.poll(async () => (await popup).isClosed()).toBe(true);
    await expect(page.getByTestId('drive-status')).toContainText('Synced');
    await page.keyboard.press('Escape');
    return page;
  };
  const a = await device();
  await a.getByTestId('open-printers').click();
  await a.getByTestId('printer-url').fill('http://printer-a.test');
  await a.getByTestId('printer-name').fill('Synced');
  await a.getByTestId('printer-key').fill('SECRET');
  await expect(a.getByTestId('printer-sync-key')).toHaveCount(0);
  await a.getByTestId('printer-sync').check();
  await expect(a.getByTestId('printer-sync-key')).toHaveText('The API key is stored in Google Drive too.');
  await a.getByTestId('printer-save').click();
  await expect.poll(() => drive.printersFile()?.printers[0]?.printer).toMatchObject({ name: 'Synced', apiKey: 'SECRET' });

  // Another device gets it.
  const b = await device();
  await b.getByTestId('open-printers').click();
  await expect(b.getByTestId('printer-row')).toContainText('Synced');

  // Sync turned off there: only the id stays in Drive.
  await b.getByTestId('printer-edit').click();
  await expect(b.getByTestId('printer-key')).toHaveValue('SECRET');
  await b.getByTestId('printer-sync').uncheck();
  await b.getByTestId('printer-save').click();
  await expect.poll(() => drive.printersFile()?.printers[0]).toEqual({ id: expect.any(String), modified: expect.any(Number) });
  await expect(b.getByTestId('printer-row')).toContainText('Synced');
});
