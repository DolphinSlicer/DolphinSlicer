// Chrome's Local Network Access: the app on a public https:// address reaching a printer's
// http:// API on a private IP. Runs in the 'lna' project (PRINTER_E2E=1, see playwright.config.ts).
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, type Page, test } from '@playwright/test';
import { KLIPPER_IP } from '../playwright.config';
import { boxStl } from './models';

const PRINTER = `http://${KLIPPER_IP}:7125`;

/** Fill in the printer form and save it, or with `test`, only test the connection. */
async function addMoonraker(page: Page, url: string, button: 'save' | 'test' = 'save') {
  await page.getByTestId('printer-kind-moonraker').click();
  await page.getByTestId('printer-url').fill(url);
  await page.getByTestId(`printer-${button}`).click();
}

async function open(page: Page) {
  await page.goto('/');
  await expect(page.getByTestId('app')).toHaveAttribute('data-engine-ready', 'yes');
  await expect(page.getByTestId('process')).not.toHaveAttribute('data-value', '');
  expect(await page.evaluate(() => location.protocol)).toBe('https:');
}

test('blocked until the user allows the local network', async ({ page, context }) => {
  await context.clearPermissions();
  await open(page);
  expect(await page.evaluate(async () => (await navigator.permissions.query({ name: 'local-network' as PermissionName })).state)).not.toBe(
    'granted',
  );
  await page.getByTestId('open-printers').click();
  await addMoonraker(page, PRINTER, 'test');
  // Headless Chrome answers the permission prompt with "block".
  await expect(page.getByTestId('printer-result')).toContainText('Access to your local network is blocked');
});

test('with the permission: an http:// printer by IP works from the https:// page', async ({ page, context }) => {
  await context.grantPermissions(['local-network-access']);
  await open(page);
  await page.getByTestId('file-input').setInputFiles({ name: 'cube.stl', mimeType: 'model/stl', buffer: boxStl() });
  await page.getByTestId('slice').click();
  await expect(page.getByTestId('download')).toBeEnabled();

  // A host name can't be used over http:// from https:// (Chrome lifts the block for IP
  // addresses and .local names only): the app says so.
  await page.getByTestId('send').click();
  await addMoonraker(page, 'http://klipper.test:7125', 'test');
  await expect(page.getByTestId('printer-result')).toContainText('IP address');

  await addMoonraker(page, PRINTER);
  const name = `dolphin-lna-${Date.now()}.gcode`;
  await page.getByTestId('send-file').fill(name);
  await page.getByTestId('send-start').uncheck();
  await page.getByTestId('send-submit').click();
  await expect(page.getByTestId('notice-info')).toContainText('Sent to');
  const files = (await (await fetch(`${PRINTER}/server/files/list?root=gcodes`)).json()) as { result: { path: string }[] };
  expect(files.result.map((f) => f.path)).toContain(name);
  await fetch(`${PRINTER}/server/files/gcodes/${encodeURIComponent(name)}`, { method: 'DELETE' });
});
