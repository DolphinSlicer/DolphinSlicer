// The model library: add, search, tag, open on the plate, delete; and its Drive sync between
// two devices.
// SPDX-License-Identifier: AGPL-3.0-or-later
import { type Browser, expect, type Page, test } from '@playwright/test';
import { answer } from './confirm';
import { FakeDrive } from './fakeDrive';
import { boxStl } from './models';

const stl = (name: string, size = 20) => ({ name, mimeType: 'model/stl', buffer: boxStl(size, size, size) });

async function ready(page: Page) {
  await expect(page.getByTestId('app')).toHaveAttribute('data-engine-ready', 'yes');
  await expect(page.getByTestId('process')).not.toHaveAttribute('data-value', '');
}

test('add, find, tag, open and delete library models', { tag: '@browser' }, async ({ page }) => {
  await page.goto('/');
  await ready(page);
  await page.getByTestId('tab-library').click();
  await expect(page.getByTestId('library')).toContainText('No models yet');

  await page.getByTestId('library-input').setInputFiles([stl('Small_cube.stl', 10), stl('Big cube.stl', 30)]);
  const cards = page.getByTestId('library-card');
  await expect(cards).toHaveCount(2);
  await expect(page.getByTestId('library-adding')).toHaveCount(0);
  await expect(cards.filter({ hasText: 'Small cube' })).toContainText('STL');

  // Search by name.
  await page.getByTestId('library-search').fill('big');
  await expect(cards).toHaveCount(1);
  await expect(cards).toContainText('Big cube');
  await page.getByTestId('library-search').fill('');

  // Rename and tag; filter by tag.
  const small = cards.filter({ hasText: 'Small cube' });
  await small.getByTestId('library-edit').click();
  await page.getByTestId('library-name').fill('Calibration cube');
  await page.getByTestId('library-tags-input').fill('calibration, small');
  await page.getByTestId('library-save').click();
  await expect(cards.filter({ hasText: 'Calibration cube' })).toHaveCount(1);
  await page.getByTestId('library-tags').getByRole('button', { name: 'calibration' }).click();
  await expect(cards).toHaveCount(1);
  await page.getByTestId('library-search').fill('small');
  await expect(cards).toHaveCount(1);
  await page.getByTestId('library-tags').getByRole('button', { name: 'calibration' }).click();
  await page.getByTestId('library-search').fill('');

  // Open: the model goes on the plate.
  await cards.filter({ hasText: 'Big cube' }).getByRole('button', { name: 'Open Big cube' }).click();
  await expect(page.getByTestId('app')).toHaveAttribute('data-view', 'prepare');
  await expect(page.getByTestId('object-list')).toContainText('Big cube.stl');

  // The library survives a reload.
  await page.reload();
  await ready(page);
  await page.getByTestId('tab-library').click();
  await expect(cards).toHaveCount(2);

  // Delete: the app asks first. Escape or Cancel keeps the model; the focus goes back.
  const del = cards.filter({ hasText: 'Big cube' }).getByTestId('library-delete');
  await del.click();
  const confirm = page.getByTestId('confirm');
  await expect(confirm).toContainText('Delete Big cube from the library?');
  await expect(confirm.getByRole('button', { name: 'Delete', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(confirm).toBeHidden();
  await expect(del).toBeFocused();
  await del.click();
  await answer(page, 'Cancel');
  await expect(cards).toHaveCount(2);
  await del.click();
  await answer(page, 'Delete');
  await expect(cards).toHaveCount(1);

  // The plate's models can be added too.
  await page.getByRole('tab', { name: 'Prepare' }).click();
  await page.getByTestId('file-input').setInputFiles([stl('Plate part.stl')]);
  await expect(page.getByTestId('object-list')).toContainText('Plate part.stl');
  await page.getByTestId('save-to-library').click();
  await expect(page.getByTestId('notice-info')).toContainText('Plate part');
  await page.getByTestId('tab-library').click();
  await expect(cards.filter({ hasText: 'Plate part' })).toHaveCount(1);
});

async function device(browser: Browser, drive: FakeDrive, baseURL: string): Promise<Page> {
  const context = await browser.newContext({ baseURL, storageState: test.info().project.use.storageState });
  await drive.attach(context, new URL(baseURL).origin);
  const page = await context.newPage();
  await page.goto('/');
  await ready(page);
  return page;
}

async function connect(page: Page) {
  await page.getByTestId('open-preferences').click();
  const popup = page.waitForEvent('popup');
  await page.getByTestId('drive-connect').click();
  await expect.poll(async () => (await popup).isClosed()).toBe(true);
  await expect(page.getByTestId('drive-status')).toContainText('Synced');
  await page.keyboard.press('Escape');
}

async function syncNow(page: Page) {
  await page.getByTestId('open-preferences').click();
  await page.getByTestId('drive-sync').click();
  await expect(page.getByTestId('drive-status')).toContainText('Synced');
  await page.keyboard.press('Escape');
}

test('library models sync between devices through Drive', async ({ browser, baseURL }) => {
  const drive = new FakeDrive();
  const a = await device(browser, drive, baseURL!);
  await connect(a);
  await a.getByTestId('tab-library').click();
  await a.getByTestId('library-input').setInputFiles([stl('Shared cube.stl')]);
  await expect(a.getByTestId('library-card')).toHaveCount(1);
  // Uploaded with its index entry.
  await expect.poll(() => drive.libraryIndex()?.entries.map((e) => e.name)).toEqual(['Shared cube']);
  await expect.poll(() => drive.modelBlobs().map((f) => f.name)).toEqual(['Shared cube.stl']);
  expect(drive.libraryIndex()!.entries[0]!.driveId).toBe(drive.modelBlobs()[0]!.id);

  // Device B lists it from the index without downloading the model…
  const b = await device(browser, drive, baseURL!);
  await connect(b);
  await b.getByTestId('tab-library').click();
  const card = b.getByTestId('library-card');
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('Shared cube');
  const downloads = drive.downloads;
  // …and downloads it when it is opened.
  await card.getByRole('button', { name: 'Open Shared cube' }).click();
  await expect(b.getByTestId('object-list')).toContainText('Shared cube.stl');
  expect(drive.downloads).toBeGreaterThan(downloads);

  // A tag on B reaches A.
  await b.getByTestId('tab-library').click();
  await card.getByTestId('library-edit').click();
  await b.getByTestId('library-tags-input').fill('shared');
  await b.getByTestId('library-save').click();
  await expect.poll(() => drive.libraryIndex()?.entries[0]?.tags).toEqual(['shared']);
  await syncNow(a);
  await expect(a.getByTestId('library-card')).toContainText('shared');

  // A deletes it: the file goes to the Drive trash, and B drops it.
  await a.getByTestId('library-card').getByTestId('library-delete').click();
  await answer(a, 'Delete');
  await expect(a.getByTestId('library-card')).toHaveCount(0);
  await expect.poll(() => drive.modelBlobs().length).toBe(0);
  await syncNow(b);
  await b.getByTestId('tab-library').click();
  await expect(b.getByTestId('library-card')).toHaveCount(0);
});
