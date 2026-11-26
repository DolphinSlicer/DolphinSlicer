// Google Drive sync of user presets between two devices (two browser profiles), against a fake
// Google sign-in and Drive.
// SPDX-License-Identifier: AGPL-3.0-or-later
import { type Browser, expect, type Page, test } from '@playwright/test';
import { answer } from './confirm';
import { FakeDrive } from './fakeDrive';
import { choose, options } from './select';

async function device(browser: Browser, drive: FakeDrive, baseURL: string, service = false): Promise<Page> {
  const context = await browser.newContext({ baseURL, storageState: test.info().project.use.storageState });
  await drive.attach(context, new URL(baseURL).origin);
  if (service) await drive.attachService(context, new URL(baseURL).origin);
  const page = await context.newPage();
  await page.goto('/');
  await expect(page.getByTestId('app')).toHaveAttribute('data-engine-ready', 'yes');
  await expect(page.getByTestId('process')).toHaveAttribute('data-value', '0.20mm Standard @MyKlipper');
  return page;
}

async function connect(page: Page) {
  await page.getByTestId('open-preferences').click();
  const popup = page.waitForEvent('popup');
  await page.getByTestId('drive-connect').click();
  // The sign-in window closes itself after handing over the token.
  await expect.poll(async () => (await popup).isClosed()).toBe(true);
  await expect(page.getByTestId('drive')).toContainText('tester@example.com');
  await expect(page.getByTestId('drive-status')).toContainText('Synced');
  await page.keyboard.press('Escape');
}

test('user presets sync between devices through Drive', { tag: '@browser' }, async ({ browser, baseURL }) => {
  const drive = new FakeDrive();
  const a = await device(browser, drive, baseURL!);
  await connect(a);

  // Device A saves a user preset; it is uploaded.
  await a.getByTestId('edit-print').click();
  await a.getByRole('button', { name: 'Save as…' }).click();
  await a.getByTestId('settings-name').fill('Synced process');
  await a.getByRole('button', { name: 'Save', exact: true }).last().click();
  await expect(a.getByTestId('process')).toHaveAttribute('data-value', 'Synced process');
  await expect.poll(() => Object.keys(drive.presetFiles())).toContain('process/Synced process.json');

  // Device B signs in and gets it.
  const b = await device(browser, drive, baseURL!);
  await expect.poll(() => options(b.getByTestId('process'))).not.toContain('Synced process');
  await connect(b);
  await expect.poll(() => options(b.getByTestId('process'))).toContain('Synced process');

  // Both change it: A first (uploaded), then B, which had not seen A's change. B's newer version
  // wins; A's is kept in the Conflicts folder.
  const edit = async (page: Page, density: string) => {
    await page.getByRole('tab', { name: 'Prepare' }).click();
    await choose(page.getByTestId('process'), 'Synced process');
    await page.getByTestId('edit-print').click();
    await page.getByTestId('settings-search').fill('sparse infill density');
    const input = page.locator('.settings .field[data-key="sparse_infill_density"] input');
    await input.fill(density);
    await input.press('Enter');
    await page.getByTestId('settings-save').click();
    await page.getByRole('tab', { name: 'Prepare' }).click();
  };
  // Hold B's next sync until A's change is in Drive.
  drive.token = 'held';
  await edit(a, '31%');
  await a.getByTestId('open-preferences').click();
  await expect(a.getByTestId('drive-signin')).toBeVisible();
  drive.token = 'fake-token';
  await a.getByTestId('drive-signin').click();
  await expect(a.getByTestId('drive-status')).toContainText('Synced');
  await a.keyboard.press('Escape');
  await expect.poll(() => drive.presetFiles()['process/Synced process.json']).toContain('31%');
  await edit(b, '42%');
  await expect(b.getByTestId('notice-warning')).toContainText('Synced process');
  await expect.poll(() => drive.presetFiles()['process/Synced process.json']).toContain('42%');
  expect(Object.entries(drive.conflictFiles()).some(([p, t]) => p.startsWith('process/Synced process.') && t.includes('31%'))).toBe(true);

  // B deletes it; it goes to the Drive trash, and A drops it on its next sync.
  await choose(b.getByTestId('process'), 'Synced process');
  await b.getByTestId('edit-print').click();
  await b.getByTestId('settings').getByRole('button', { name: 'Delete', exact: true }).click();
  await answer(b, 'Delete');
  await expect.poll(() => Object.keys(drive.presetFiles())).not.toContain('process/Synced process.json');

  await a.getByRole('tab', { name: 'Prepare' }).click();
  await a.getByTestId('open-preferences').click();
  await a.getByTestId('drive-sync').click();
  await expect(a.getByTestId('drive-status')).toContainText('Synced');
  await a.keyboard.press('Escape');
  await expect.poll(() => options(a.getByTestId('process'))).not.toContain('Synced process');
  await expect(a.getByTestId('process')).not.toHaveAttribute('data-value', 'Synced process');

  // Expired token: asks to sign in again instead of failing quietly.
  drive.token = 'new-token';
  await a.getByTestId('open-preferences').click();
  await a.getByTestId('drive-sync').click();
  await expect(a.getByTestId('drive-signin')).toBeVisible();
});

test('saving a preset again is not a conflict when Drive moves its version on by itself', async ({ browser, baseURL }) => {
  const drive = new FakeDrive();
  drive.bumpAfterUpload = true;
  const a = await device(browser, drive, baseURL!);
  await connect(a);
  await a.getByTestId('edit-print').click();
  await a.getByRole('button', { name: 'Save as…' }).click();
  await a.getByTestId('settings-name').fill('Often saved');
  await a.getByRole('button', { name: 'Save', exact: true }).last().click();
  await expect.poll(() => drive.presetFiles()['process/Often saved.json']).toBeTruthy();
  for (const density of ['21%', '22%', '23%']) {
    await a.getByTestId('settings-search').fill('sparse infill density');
    const input = a.locator('.settings .field[data-key="sparse_infill_density"] input');
    await input.fill(density);
    await input.press('Enter');
    await a.getByTestId('settings-save').click();
    await expect.poll(() => drive.presetFiles()['process/Often saved.json']).toContain(density);
  }
  expect(drive.conflictFiles()).toEqual({});
  await expect(a.getByTestId('notice-warning')).toHaveCount(0);
});

test('closing the sign-in window can be undone with Cancel or by trying again', async ({ browser, baseURL }) => {
  const drive = new FakeDrive();
  const a = await device(browser, drive, baseURL!);
  // Google's page stays open (no redirect) until the user closes it.
  await a
    .context()
    .route('https://accounts.google.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<p>Google</p>' }));
  await a.getByTestId('open-preferences').click();
  const popup = a.waitForEvent('popup');
  await a.getByTestId('drive-connect').click();
  await (await popup).close();
  await expect(a.getByTestId('drive-waiting')).toBeVisible();
  await expect(a.getByTestId('drive-connect')).toBeEnabled();
  await a.getByTestId('drive-cancel').click();
  await expect(a.getByTestId('drive-waiting')).toHaveCount(0);
  await expect(a.getByTestId('notice-warning')).toHaveCount(0);

  // Trying again works once Google answers.
  await a.context().unroute('https://accounts.google.com/**');
  await drive.attach(a.context(), new URL(baseURL!).origin);
  await a.getByTestId('drive-connect').click();
  await expect(a.getByTestId('drive')).toContainText('tester@example.com');
});

test('with the token service, an expired sign-in is renewed without asking', async ({ browser, baseURL }) => {
  const drive = new FakeDrive();
  const a = await device(browser, drive, baseURL!, true);
  await connect(a);
  expect(drive.service.renewals).toBe(0);

  // An hour later (the stored token has expired): the next start syncs without asking.
  await a.evaluate(() => {
    const k = 'dolphin-slicer.drive.v1';
    localStorage.setItem(k, JSON.stringify({ ...JSON.parse(localStorage.getItem(k)!), expires: 0 }));
  });
  drive.token = 'renewed-1';
  await a.reload();
  await expect(a.getByTestId('app')).toHaveAttribute('data-engine-ready', 'yes');
  await a.getByTestId('open-preferences').click();
  await expect(a.getByTestId('drive-status')).toContainText('Synced');
  expect(drive.service.renewals).toBe(1);

  // A token Drive rejects early is renewed too.
  drive.token = 'renewed-2';
  await a.getByTestId('drive-sync').click();
  await expect.poll(() => drive.service.renewals).toBe(2);
  await expect(a.getByTestId('drive-status')).toContainText('Synced');
  await expect(a.getByTestId('drive-signin')).toHaveCount(0);

  // Access revoked (e.g. in the Google account settings): asks to sign in.
  drive.service.signedIn = false;
  drive.token = 'renewed-3';
  await a.getByTestId('drive-sync').click();
  await expect(a.getByTestId('drive-signin')).toBeVisible();

  // Disconnecting ends the session at the service.
  drive.service.signedIn = true;
  await a.getByTestId('drive-signin').click();
  await expect(a.getByTestId('drive-status')).toContainText('Synced');
  await a.getByRole('button', { name: 'Disconnect' }).click();
  await expect.poll(() => drive.service.signedIn).toBe(false);
});

test('settings sync between devices: preferences, the settings mode and the selected presets', async ({ browser, baseURL }) => {
  const drive = new FakeDrive();
  const a = await device(browser, drive, baseURL!);
  await connect(a);
  // Device A changes its units, settings mode and print settings.
  await a.getByTestId('open-preferences').click();
  await a.getByRole('radio', { name: 'Imperial' }).click();
  await a.keyboard.press('Escape');
  await choose(a.getByTestId('process'), '0.12mm Fine @MyKlipper');
  await a.getByTestId('edit-print').click();
  await a.getByTestId('settings-mode-expert').click();
  await expect.poll(() => drive.settingsFile()?.settings.settingsMode?.value, { timeout: 15_000 }).toBe('expert');
  await expect
    .poll(() => (drive.settingsFile()?.settings.selection?.value as { process?: string } | undefined)?.process)
    .toBe('0.12mm Fine @MyKlipper');
  expect(drive.settingsFile()?.settings.units?.value).toBe('imperial');

  // Device B, never changed: takes them when it signs in.
  const b = await device(browser, drive, baseURL!);
  await connect(b);
  await expect(b.getByTestId('process')).toHaveAttribute('data-value', '0.12mm Fine @MyKlipper');
  await b.getByTestId('edit-print').click();
  await expect(b.getByTestId('settings-mode-expert')).toHaveAttribute('aria-checked', 'true');
  await b.getByTestId('open-preferences').click();
  await expect(b.getByRole('radio', { name: 'Imperial' })).toHaveAttribute('aria-checked', 'true');
  await b.keyboard.press('Escape');

  // B changes the mode back: A gets it at its next sync.
  await b.getByTestId('settings-mode-simple').click();
  await expect.poll(() => drive.settingsFile()?.settings.settingsMode?.value, { timeout: 15_000 }).toBe('simple');
  await a.getByTestId('open-preferences').click();
  await a.getByTestId('drive-sync').click();
  await expect(a.getByTestId('drive-status')).toContainText('Synced');
  await a.keyboard.press('Escape');
  await expect(a.getByTestId('settings-mode-simple')).toHaveAttribute('aria-checked', 'true');
});
