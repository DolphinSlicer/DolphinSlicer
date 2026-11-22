// Sending G-code to real printer servers and controlling the print: Klipper through Moonraker
// (on a simulated printer) and OctoPrint (its virtual printer), both in Docker. Start them with
// e2e/printers/start.sh, then run with PRINTER_E2E=1.
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, type Page, test } from '@playwright/test';
import { answer } from './confirm';
import { boxStl } from './models';
import { choose } from './select';

const MOONRAKER = process.env.MOONRAKER_URL ?? 'http://localhost:7125';
const OCTOPRINT = process.env.OCTOPRINT_URL ?? 'http://localhost:5050';
const OCTO_KEY = process.env.OCTOPRINT_KEY ?? 'DOLPHINTESTKEY0123456789';

test.skip(!process.env.PRINTER_E2E, 'needs the printer servers from e2e/printers/start.sh (PRINTER_E2E=1)');
test.skip(({ browserName }) => browserName !== 'chromium', 'Chrome only');

async function sliced(page: Page, size = 20) {
  await page.goto('/');
  await expect(page.getByTestId('app')).toHaveAttribute('data-engine-ready', 'yes');
  await expect(page.getByTestId('process')).not.toHaveAttribute('data-value', '');
  await page.getByTestId('file-input').setInputFiles({ name: 'cube.stl', mimeType: 'model/stl', buffer: boxStl(size, size, size) });
  await expect(page.getByTestId('object-list')).toContainText('cube.stl');
  await page.getByTestId('slice').click();
  await expect(page.getByTestId('download')).toBeEnabled();
}

/** Fill in the printer form and save it, or with `test`, only test the connection. */
async function addPrinter(page: Page, kind: 'moonraker' | 'octoprint', url: string, key = '', name = '', button: 'save' | 'test' = 'save') {
  await page.getByTestId(`printer-kind-${kind}`).click();
  await page.getByTestId('printer-url').fill(url);
  await page.getByTestId('printer-key').fill(key);
  await page.getByTestId('printer-name').fill(name);
  await page.getByTestId(`printer-${button}`).click();
}

const moonraker = async (path: string, init?: RequestInit) => (await fetch(`${MOONRAKER}${path}`, init)).json();

test('Klipper: send, print, pause, resume, stop', async ({ page }) => {
  // Nothing printing from an earlier run.
  await fetch(`${MOONRAKER}/printer/print/cancel`, { method: 'POST' }).catch(() => {});
  await sliced(page, 30);

  // No printer yet: Send asks for one; Test connection checks it.
  await page.getByTestId('send').click();
  const dialog = page.getByTestId('send-dialog');
  await addPrinter(page, 'moonraker', 'localhost:9', '', 'Nowhere', 'test');
  await expect(dialog.getByTestId('printer-result')).toContainText('Could not reach the printer');
  await addPrinter(page, 'moonraker', MOONRAKER.replace(/^http:\/\//, ''), '', 'Voron');

  // Upload without printing first.
  const name = `dolphin-e2e-${Date.now()}.gcode`;
  await choose(dialog.getByTestId('send-printer'), { label: 'Voron' });
  await dialog.getByTestId('send-file').fill(name);
  await dialog.getByTestId('send-start').uncheck();
  await dialog.getByTestId('send-submit').click();
  await expect(page.getByTestId('notice-info')).toContainText('Sent to Voron');
  const files = (await moonraker('/server/files/list?root=gcodes')) as { result: { path: string; size: number }[] };
  const uploaded = files.result.find((f) => f.path === name);
  expect(uploaded?.size).toBeGreaterThan(1000);
  expect((await moonraker('/printer/objects/query?print_stats')).result.status.print_stats.state).not.toBe('printing');

  // Now print it.
  await page.getByTestId('send').click();
  await dialog.getByTestId('send-file').fill(name);
  await expect(dialog.getByTestId('send-printer')).toHaveAttribute('data-value', /.+/);
  await expect(dialog.getByTestId('send-start')).toBeChecked();
  await dialog.getByTestId('send-submit').click();
  await expect(page.getByTestId('notice-info').last()).toContainText('Printing on Voron');

  // The printer list shows it printing, with controls.
  await page.getByTestId('open-printers').click();
  const row = page.getByTestId('printer-row').filter({ hasText: 'Voron' });
  await expect(row).toHaveAttribute('data-state', 'printing', { timeout: 90_000 });
  await expect(row).toContainText(name);
  await expect(row).toContainText('Nozzle');
  // Sending it again while it prints: Moonraker refuses (403), and says why, not "API key".
  await page.keyboard.press('Escape');
  await page.getByTestId('send').click();
  await dialog.getByTestId('send-file').fill(name);
  await dialog.getByTestId('send-start').uncheck();
  await dialog.getByTestId('send-submit').click();
  await expect(page.getByTestId('notice-error')).toContainText('This file is being printed. Use another file name.');
  await page.keyboard.press('Escape');
  await page.getByTestId('open-printers').click();
  await row.getByTestId('printer-pause').click();
  await expect(row).toHaveAttribute('data-state', 'paused', { timeout: 90_000 });
  await row.getByTestId('printer-resume').click();
  await expect(row).toHaveAttribute('data-state', 'printing', { timeout: 90_000 });
  await row.getByTestId('printer-cancel').click();
  await answer(page, 'Stop');
  await expect(row).toHaveAttribute('data-state', 'cancelled', { timeout: 90_000 });

  // The unreachable one was only tested, not saved.
  const nowhere = page.getByTestId('printer-row').filter({ hasText: 'Nowhere' });
  await expect(nowhere).toHaveCount(0);

  await fetch(`${MOONRAKER}/server/files/gcodes/${encodeURIComponent(name)}`, { method: 'DELETE' });
});

test('OctoPrint: API key, send, print, pause, resume, stop', async ({ page }) => {
  await fetch(`${OCTOPRINT}/api/job`, {
    method: 'POST',
    headers: { 'X-Api-Key': OCTO_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ command: 'cancel' }),
  }).catch(() => {});
  await sliced(page, 40);
  await page.getByTestId('open-printers').click();
  const dialog = page.getByTestId('printers');
  // Test connection catches a wrong key.
  await addPrinter(page, 'octoprint', OCTOPRINT, 'wrong-key', 'Prusa', 'test');
  await expect(dialog.getByTestId('printer-result')).toContainText('refused the API key');
  await addPrinter(page, 'octoprint', OCTOPRINT, OCTO_KEY, 'Prusa');
  const row = dialog.getByTestId('printer-row').filter({ hasText: 'Prusa' });
  await expect(row).toHaveAttribute('data-state', /ready|done|cancelled/);
  await page.keyboard.press('Escape');

  const name = `dolphin-e2e-${Date.now()}.gcode`;
  await page.getByTestId('send').click();
  const send = page.getByTestId('send-dialog');
  await choose(send.getByTestId('send-printer'), { label: 'Prusa' });
  await send.getByTestId('send-file').fill(name);
  await send.getByTestId('send-submit').click();
  await expect(page.getByTestId('notice-info')).toContainText('Printing on Prusa');

  await page.getByTestId('open-printers').click();
  await expect(row).toHaveAttribute('data-state', 'printing', { timeout: 90_000 });
  await expect(row).toContainText(name);
  await row.getByTestId('printer-pause').click();
  await expect(row).toHaveAttribute('data-state', 'paused', { timeout: 90_000 });
  await row.getByTestId('printer-resume').click();
  await expect(row).toHaveAttribute('data-state', 'printing', { timeout: 90_000 });
  await row.getByTestId('printer-cancel').click();
  await answer(page, 'Stop');
  await expect(row).toHaveAttribute('data-state', /ready|cancelled/, { timeout: 90_000 });

  const files = (await (await fetch(`${OCTOPRINT}/api/files/local`, { headers: { 'X-Api-Key': OCTO_KEY } })).json()) as {
    files: { name: string }[];
  };
  expect(files.files.map((f) => f.name)).toContain(name);
  await fetch(`${OCTOPRINT}/api/files/local/${encodeURIComponent(name)}`, { method: 'DELETE', headers: { 'X-Api-Key': OCTO_KEY } });
});
