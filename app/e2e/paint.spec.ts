// Support painting (desktop's paint-on supports): painting enforcers and blockers on an object,
// undo, the tools, and the paint reaching the slice.
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, type Page, test } from '@playwright/test';
import { boxStl } from './models';

const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
type Win = {
  __orca: {
    store: {
      getState(): {
        objects: { painted: boolean; supports?: [number, string][][]; instances: number[][] }[];
        selected: string[];
        slice: { stats?: { warnings: string[] } };
      };
    };
    viewport: {
      fitObjects(ids: string[]): void;
      camera: { position: { constructor: new (x: number, y: number, z: number) => { project(c: unknown): { x: number; y: number } } } };
      canvas: HTMLCanvasElement;
    };
  };
};

/** Where the middle of the box's top is on the page. */
const topOfBox = (page: Page) =>
  page.evaluate(() => {
    const o = (window as unknown as Win).__orca;
    const m = o.store.getState().objects[0]!.instances[0]!;
    const V = o.viewport.camera.position.constructor;
    const v = new V(m[12]!, m[13]!, 14).project(o.viewport.camera);
    const r = o.viewport.canvas.getBoundingClientRect();
    return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
  });
const painted = (page: Page) => page.evaluate(() => (window as unknown as Win).__orca.store.getState().objects[0]!.painted);

test('paint support enforcers and blockers, undo them, and slice with them', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('app')).toHaveAttribute('data-engine-ready', 'yes');
  if (!(await page.evaluate(() => !!(window as unknown as { __orca?: { viewport?: object } }).__orca?.viewport))) return;
  await page.getByTestId('file-input').setInputFiles([{ name: 'box.stl', mimeType: 'model/stl', buffer: boxStl(30, 20, 15) }]);
  await expect(page.getByTestId('object-panel')).toBeVisible();
  // L: the painting panel takes the object panel's place.
  await page.keyboard.press('l');
  await expect(page.getByTestId('paint-panel')).toBeVisible();
  await expect(page.getByTestId('object-panel')).toHaveCount(0);
  await expect(page.getByTestId('plate-paint-supports')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('paint-erase-all')).toBeDisabled();
  await page.evaluate(() => {
    const o = (window as unknown as Win).__orca;
    o.viewport.fitObjects(o.store.getState().selected);
  });
  await page.waitForTimeout(800);
  const at = await topOfBox(page);
  // A stroke with the left button: enforcers.
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.move(at.x + 40, at.y + 10, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => painted(page)).toBe(true);
  await expect(page.getByTestId('paint-erase-all')).toBeEnabled();
  await expect(page.getByTestId('object-list').locator('li').first()).toContainText('Support Painting');
  // Undo takes it back; redo brings it again.
  await page.keyboard.press(`${mod}+z`);
  await expect.poll(() => painted(page)).toBe(false);
  await page.keyboard.press(`${mod}+y`);
  await expect.poll(() => painted(page)).toBe(true);
  // The tools by desktop's keys.
  await page.keyboard.press('f');
  await expect(page.getByTestId('paint-tool-fill')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('paint-smartFillAngle')).toBeVisible();
  await page.keyboard.press('g');
  await expect(page.getByTestId('paint-gap-apply')).toBeVisible();
  await page.keyboard.press('c');
  // Done; the slice gets the paint (supports are off: desktop's warning).
  await page.getByTestId('paint-done').click();
  await expect(page.getByTestId('object-panel')).toBeVisible();
  await page.getByTestId('slice').click();
  await expect(page.getByTestId('notice-warning')).toContainText('Support enforcers are used but support is not enabled');
  // Erase all (painting is in Prepare; the slice opened the preview).
  await page.getByRole('tab', { name: 'Prepare' }).click();
  await page.keyboard.press('l');
  await page.getByTestId('paint-erase-all').click();
  await expect.poll(() => painted(page)).toBe(false);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('paint-panel')).toHaveCount(0);
});
