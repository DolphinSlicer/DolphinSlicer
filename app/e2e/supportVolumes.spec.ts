// Desktop's Add Support Blocker / Add Support Enforcer: a generic shape added to an object from its
// menu, listed under it, placed with its panel, and kept away supports in the slice.
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, type Page, test } from '@playwright/test';
import { projectWithBlocker } from './models';

/** A pillar with a slab on top that overhangs both sides: supports under the slab. */
function teeStl(): Buffer {
  const boxes: [number[], number[]][] = [
    [
      [-5, -5, 0],
      [5, 5, 20],
    ],
    [
      [-25, -5, 20],
      [25, 5, 24],
    ],
  ];
  const tris: number[][][] = [];
  for (const [a, b] of boxes) {
    const v = (x: number, y: number, z: number) => [x ? b[0]! : a[0]!, y ? b[1]! : a[1]!, z ? b[2]! : a[2]!];
    const q = (p: number[], r: number[], s: number[], u: number[]) => tris.push([p, r, s], [p, s, u]);
    q(v(0, 0, 0), v(0, 1, 0), v(1, 1, 0), v(1, 0, 0));
    q(v(0, 0, 1), v(1, 0, 1), v(1, 1, 1), v(0, 1, 1));
    q(v(0, 0, 0), v(1, 0, 0), v(1, 0, 1), v(0, 0, 1));
    q(v(0, 1, 0), v(0, 1, 1), v(1, 1, 1), v(1, 1, 0));
    q(v(0, 0, 0), v(0, 0, 1), v(0, 1, 1), v(0, 1, 0));
    q(v(1, 0, 0), v(1, 1, 0), v(1, 1, 1), v(1, 0, 1));
  }
  const buf = Buffer.alloc(84 + tris.length * 50);
  buf.writeUInt32LE(tris.length, 80);
  let o = 84;
  for (const t of tris) {
    o += 12;
    for (const p of t) {
      buf.writeFloatLE(p[0]!, o);
      buf.writeFloatLE(p[1]!, o + 4);
      buf.writeFloatLE(p[2]!, o + 8);
      o += 12;
    }
    o += 2;
  }
  return buf;
}

/** Slice, and count the extrusion moves of support. */
async function supportMoves(page: Page): Promise<number> {
  await page.getByTestId('slice').click();
  await expect(page.getByTestId('download')).toBeEnabled({ timeout: 120_000 });
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('download').click()]);
  const gcode = await (await download.createReadStream()).toArray().then((c) => Buffer.concat(c).toString('utf8'));
  await page.getByRole('tab', { name: 'Prepare' }).click();
  let n = 0,
    inSupport = false;
  for (const line of gcode.split('\n')) {
    if (line.startsWith(';TYPE:')) inSupport = line.startsWith(';TYPE:Support');
    else if (inSupport && /^G1 .*E/.test(line)) n++;
  }
  return n;
}

test('a support blocker keeps supports away; enforcers are added the same way', { tag: '@engine' }, async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('app')).toHaveAttribute('data-engine-ready', 'yes');
  await page.getByTestId('file-input').setInputFiles({ name: 'tee.stl', mimeType: 'model/stl', buffer: teeStl() });
  const objectRow = page.getByTestId('object-list').locator('li').first();
  await expect(objectRow).toContainText('tee');
  await page.getByTestId('edit-print').click();
  await page.getByTestId('settings-search').fill('enable support');
  const supports = page.locator('.settings .field[data-key="enable_support"] input[type=checkbox]');
  await supports.click();
  await expect(supports).toBeChecked();
  await page.getByRole('tab', { name: 'Prepare' }).click();
  const before = await supportMoves(page);
  expect(before).toBeGreaterThan(0);

  // The object's menu: Add Support Blocker ▸ Cube. Listed under the object, its panel shown.
  await objectRow.click({ button: 'right' });
  await page.getByTestId('menu-add-blocker').hover();
  await page.getByTestId('menu-blocker-cube').click();
  const volumeRow = page.getByTestId('volume-row');
  await expect(volumeRow).toHaveCount(1);
  await expect(volumeRow).toContainText('Support Blocker');
  await expect(page.getByTestId('volume-panel')).toBeVisible();
  // Desktop's size: a tenth of the bed's larger side (250 mm here).
  await expect(page.getByTestId('volume-size-0')).toHaveValue('25');

  // Over the whole object: at its center, larger than it.
  await objectRow.click();
  const [ox, oy] = [await page.getByTestId('op-position-0').inputValue(), await page.getByTestId('op-position-1').inputValue()];
  await volumeRow.click();
  await page.getByTestId('volume-uniform').click();
  for (const [id, v] of [
    ['volume-size-0', '80'],
    ['volume-size-1', '30'],
    ['volume-size-2', '40'],
    ['volume-position-0', ox],
    ['volume-position-1', oy],
    ['volume-position-2', '20'],
  ] as const) {
    await page.getByTestId(id).fill(v);
    await page.getByTestId(id).press('Enter');
  }
  await expect(page.getByTestId('volume-size-0')).toHaveValue('80');
  expect(await supportMoves(page)).toBe(0);

  // An enforcer comes from the other menu, blue in the list.
  await objectRow.click({ button: 'right' });
  await page.getByTestId('menu-add-enforcer').click();
  await page.getByTestId('menu-enforcer-cylinder').click();
  await expect(volumeRow).toHaveCount(2);
  await expect(volumeRow.nth(1)).toContainText('Cylinder');
  await expect(volumeRow.nth(1)).toContainText('Support Enforcer');

  // Delete removes the selected one, undo brings it back; the object stays.
  await page.keyboard.press('Delete');
  await expect(volumeRow).toHaveCount(1);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await expect(volumeRow).toHaveCount(2);
  await expect(page.getByTestId('object-list').locator('li:not(.volume)')).toHaveCount(1);
});

test('a project’s own support blocker is listed, and can be moved, deleted and brought back', { tag: '@engine' }, async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('app')).toHaveAttribute('data-engine-ready', 'yes');
  await page.getByTestId('edit-print').click();
  await page.getByTestId('settings-search').fill('enable support');
  const supports = page.locator('.settings .field[data-key="enable_support"] input[type=checkbox]');
  await supports.click();
  await expect(supports).toBeChecked();
  await page.getByRole('tab', { name: 'Prepare' }).click();
  await page.getByTestId('file-input').setInputFiles({ name: 'tee.3mf', mimeType: 'model/3mf', buffer: projectWithBlocker() });

  // Listed with its name from the file; it keeps supports away.
  const volumeRow = page.getByTestId('volume-row');
  await expect(volumeRow).toHaveCount(1);
  await expect(volumeRow).toContainText('Big blocker');
  await expect(volumeRow).toContainText('Support Blocker');
  expect(await supportMoves(page)).toBe(0);

  // Its size as the file has it; moved off the object, the supports come back.
  await volumeRow.click();
  await expect(page.getByTestId('volume-size-0')).toHaveValue('80');
  await page.getByTestId('volume-position-0').fill('20');
  await page.getByTestId('volume-position-0').press('Enter');
  const away = await supportMoves(page);
  expect(away).toBeGreaterThan(0);

  // Deleted: still supports. Both undone: none again.
  await volumeRow.click();
  await page.keyboard.press('Delete');
  await expect(volumeRow).toHaveCount(0);
  expect(await supportMoves(page)).toBe(away);
  const undo = process.platform === 'darwin' ? 'Meta+z' : 'Control+z';
  await page.keyboard.press(undo);
  await page.keyboard.press(undo);
  await expect(volumeRow).toHaveCount(1);
  expect(await supportMoves(page)).toBe(0);
});
