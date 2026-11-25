// The self-hosted build (npm run build:pi) as served from a printer: plain http:// on a LAN
// address (not a secure context), under /dolphin/, next to Moonraker. Runs in the 'pi' project
// (PRINTER_E2E=1, after e2e/printers/start.sh and e2e/printers/pi.sh).
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '@playwright/test';
import { boxStl } from './models';

test('runs over plain http:// and prints on the printer it is served from', async ({ page }) => {
  // An empty storage folder (nginx deletes folders with everything in them).
  await fetch('http://localhost:8090/dolphin/storage/DolphinSlicer/', { method: 'DELETE' });
  // The address without the trailing slash leads to the app too.
  await page.goto('/dolphin');
  await expect(page).toHaveURL('http://pi.test:8090/dolphin/');
  await expect(page.getByTestId('app')).toHaveAttribute('data-engine-ready', 'yes', { timeout: 120_000 });
  expect(await page.evaluate(() => [location.protocol, window.isSecureContext])).toEqual(['http:', false]);
  // No SharedArrayBuffer without a secure context: the single-threaded engine.
  await expect(page.getByTestId('app')).toHaveAttribute('data-engine', 'st');
  await expect(page.getByTestId('process')).not.toHaveAttribute('data-value', '');

  // The server's storage folder takes the place of Google Drive (which needs https://).
  await page.getByTestId('open-preferences').click();
  await expect(page.getByTestId('server-storage')).toBeVisible();
  await expect(page.getByTestId('drive-connect')).toHaveCount(0);
  await expect(page.getByTestId('drive-status')).toContainText('Synced');
  await page.keyboard.press('Escape');

  // The model library works, and its models go to the storage folder.
  await page.getByTestId('tab-library').click();
  await page.getByTestId('library-input').setInputFiles({ name: 'pi cube.stl', mimeType: 'model/stl', buffer: boxStl() });
  await expect(page.getByTestId('library-card')).toHaveCount(1);
  const stored = async () => {
    const r = await fetch('http://localhost:8090/dolphin/storage/DolphinSlicer/Models/');
    return r.ok ? ((await r.json()) as { name: string }[]).map((f) => f.name).sort() : [];
  };
  await expect.poll(stored).toEqual(['library.json', 'pi cube.stl']);
  await page.getByRole('button', { name: 'Open pi cube' }).click();
  await expect(page.getByTestId('object-list')).toContainText('pi cube.stl');

  await page.getByTestId('slice').click();
  await expect(page.getByTestId('download')).toBeEnabled({ timeout: 120_000 });

  // The printer form starts with this address: Moonraker is on the same host.
  await page.getByTestId('send').click();
  await expect(page.getByTestId('printer-url')).toHaveValue('http://pi.test:8090');
  await page.getByTestId('printer-save').click();
  const name = `dolphin-pi-${Date.now()}.gcode`;
  await page.getByTestId('send-file').fill(name);
  await page.getByTestId('send-start').uncheck();
  await page.getByTestId('send-submit').click();
  await expect(page.getByTestId('notice-info')).toContainText('Sent to pi.test');
  const files = (await (await fetch('http://localhost:7125/server/files/list?root=gcodes')).json()) as { result: { path: string }[] };
  expect(files.result.map((f) => f.path)).toContain(name);
  await fetch(`http://localhost:7125/server/files/gcodes/${encodeURIComponent(name)}`, { method: 'DELETE' });
});
