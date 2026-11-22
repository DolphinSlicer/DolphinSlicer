// Plate operations with desktop's shortcuts: copy/paste, clone, instances, delete, undo/redo,
// selection, moving and turning with keys, the context menu, auto orient and lay on face.
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, type Page, test } from '@playwright/test';
import { boxStl } from './models';

const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
const rows = (page: Page) => page.getByTestId('object-list').locator('li');
const field = (page: Page, kind: string, axis: number) => page.getByTestId(`op-${kind}-${axis}`);

const hasViewport = (page: Page) => page.evaluate(() => !!(window as unknown as { __orca?: { viewport?: object } }).__orca?.viewport);

async function start(page: Page) {
  await page.goto('/');
  await expect(page.getByTestId('app')).toHaveAttribute('data-engine-ready', 'yes');
  await page.getByTestId('file-input').setInputFiles([{ name: 'box.stl', mimeType: 'model/stl', buffer: boxStl(30, 20, 15) }]);
  await expect(page.getByTestId('object-panel')).toBeVisible();
}

test('copy, paste, clone, instances, delete, undo and redo by keyboard', async ({ page }) => {
  await start(page);
  await page.keyboard.press(`${mod}+c`);
  await page.keyboard.press(`${mod}+v`);
  await expect(rows(page)).toHaveCount(2);
  // The copy is selected, beside the original.
  await expect(rows(page).nth(1)).toHaveClass(/selected/);
  await page.keyboard.press(`${mod}+k`);
  await expect(rows(page)).toHaveCount(3);
  await page.keyboard.press(`${mod}+z`);
  await expect(rows(page)).toHaveCount(2);
  await page.keyboard.press(`${mod}+y`);
  await expect(rows(page)).toHaveCount(3);

  // All selected: the panel is for one object.
  await page.keyboard.press(`${mod}+a`);
  await expect(rows(page).locator('xpath=self::li[contains(@class,"selected")]')).toHaveCount(3);
  await expect(page.getByTestId('object-panel')).toBeHidden();
  await page.keyboard.press('Delete');
  await expect(rows(page)).toHaveCount(0);
  await page.keyboard.press(`${mod}+z`);
  await expect(rows(page)).toHaveCount(3);
  await page.keyboard.press('Escape');
  await expect(rows(page).locator('xpath=self::li[contains(@class,"selected")]')).toHaveCount(0);

  // Ctrl+click adds to the selection; Shift+click selects a range.
  await rows(page).nth(0).click();
  await rows(page)
    .nth(2)
    .click({ modifiers: [mod] });
  await expect(rows(page).locator('xpath=self::li[contains(@class,"selected")]')).toHaveCount(2);
  await rows(page)
    .nth(2)
    .click({ modifiers: ['Shift'] });
  await rows(page).nth(0).click();
  await rows(page)
    .nth(2)
    .click({ modifiers: ['Shift'] });
  await expect(rows(page).locator('xpath=self::li[contains(@class,"selected")]')).toHaveCount(3);

  // Instances.
  await rows(page).nth(0).click();
  await page.keyboard.press('+');
  await expect(rows(page).nth(0)).toContainText('×2');
  await page.keyboard.press('-');
  await expect(rows(page).nth(0)).not.toContainText('×2');

  // Delete all, and back.
  await page.keyboard.press(`${mod}+d`);
  await expect(rows(page)).toHaveCount(0);
  await page.keyboard.press(`${mod}+z`);
  await expect(rows(page)).toHaveCount(3);
  // A copy pasted after everything was deleted still slices (its file is loaded again).
  await rows(page).nth(0).click();
  await page.keyboard.press(`${mod}+c`);
  await page.keyboard.press(`${mod}+d`);
  await page.keyboard.press(`${mod}+v`);
  await page.keyboard.press(`${mod}+v`);
  await expect(rows(page)).toHaveCount(2);
  await page.getByTestId('slice').click();
  await expect(page.getByTestId('preview-legend')).toContainText('Outer wall');
  await expect(page.getByTestId('notice-error')).toHaveCount(0);
});

test('arrows move and Page Up/Down turn the selection; the toolbar and menu run commands', async ({ page }) => {
  await start(page);
  const x = Number(await field(page, 'position', 0).inputValue());
  await page.keyboard.press('ArrowRight');
  await expect(field(page, 'position', 0)).toHaveValue(String(x + 10));
  await page.keyboard.press('Shift+ArrowLeft');
  await expect(field(page, 'position', 0)).toHaveValue(String(x + 9));
  await page.keyboard.press('PageUp');
  await expect(field(page, 'rotation', 2)).toHaveValue('45');
  await page.keyboard.press('PageDown');
  await page.keyboard.press('PageDown');
  await expect(field(page, 'rotation', 2)).toHaveValue('-45');
  // Keys typed into a field stay there.
  await field(page, 'position', 0).press('ArrowLeft');
  await expect(field(page, 'rotation', 2)).toHaveValue('-45');

  await page.getByTestId('plate-clone').click();
  await expect(rows(page)).toHaveCount(2);
  await page.getByTestId('plate-undo').click();
  await expect(rows(page)).toHaveCount(1);
  await page.getByTestId('plate-redo').click();
  await expect(rows(page)).toHaveCount(2);

  // The context menu, from the object list; Escape closes it.
  await rows(page).nth(0).click({ button: 'right' });
  const menu = page.getByTestId('plate-menu');
  await expect(menu.getByRole('menuitem', { name: /Copy/ })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await rows(page).nth(0).click({ button: 'right' });
  await menu.getByRole('menuitem', { name: /Add instance/ }).click();
  await expect(rows(page).nth(0)).toContainText('×2');
  // On the empty plate (in the 3D view): the plate's commands.
  if (!(await hasViewport(page))) return;
  await page.mouse.click(700, 120, { button: 'right' });
  await expect(menu.getByRole('menuitem', { name: /Select all/ })).toBeVisible();
  await page.keyboard.press('Escape');
  // As Windows sends it: the contextmenu event after the button is let go, over the open menu's backdrop.
  await page.evaluate(() => {
    const canvas = document.querySelector('canvas.viewport')!;
    const at = { clientX: 700, clientY: 160, bubbles: true, pointerId: 1, isPrimary: true };
    canvas.dispatchEvent(new PointerEvent('pointerdown', { ...at, button: 2, buttons: 2 }));
    canvas.dispatchEvent(new PointerEvent('pointerup', { ...at, button: 2, buttons: 0 }));
  });
  await expect(menu).toBeVisible();
  await page.locator('.menu-backdrop').dispatchEvent('contextmenu');
  await expect(menu.getByRole('menuitem', { name: /Select all/ })).toBeVisible();
  await menu.getByRole('menuitem', { name: /Select all/ }).click();
  await expect(rows(page).locator('xpath=self::li[contains(@class,"selected")]')).toHaveCount(2);
});

test('auto orient and lay on face put a tilted box flat again', async ({ page }) => {
  await start(page);
  // Resting on a side: as high as one of its edges is long.
  const flat = async () => {
    const h = 2 * Number(await field(page, 'position', 2).inputValue());
    return [15, 20, 30].some((e) => Math.abs(h - e) < 0.02);
  };
  await field(page, 'rotation', 0).fill('30');
  await field(page, 'rotation', 0).press('Enter');
  await field(page, 'rotation', 1).fill('20');
  await field(page, 'rotation', 1).press('Enter');
  await expect.poll(flat).toBe(false);
  // Keys typed into a field are the field's.
  await page.evaluate(() => (document.activeElement as HTMLElement).blur());
  await page.keyboard.press('q');
  await expect.poll(flat).toBe(true);
  // Lying on its largest side (30 × 20).
  await expect(field(page, 'position', 2)).toHaveValue('7.5');

  await page.keyboard.press(`${mod}+z`);
  await expect.poll(flat).toBe(false);
  // Lay on face is clicked in the 3D view.
  if (!(await hasViewport(page))) return;
  await page.keyboard.press('f');
  await expect(page.getByTestId('plate-lay-on-face')).toHaveAttribute('aria-pressed', 'true');
  // Click the side facing the camera, at the object's center on the screen.
  const at = await page.evaluate(() => {
    const o = (
      window as unknown as {
        __orca: {
          store: { getState(): { objects: { instances: number[][] }[] } };
          viewport: {
            camera: {
              position: { constructor: new (x: number, y: number, z: number) => { project(c: unknown): { x: number; y: number } } };
            };
            renderer: { domElement: HTMLCanvasElement };
          };
        };
      }
    ).__orca;
    const m = o.store.getState().objects[0]!.instances[0]!;
    const V = o.viewport.camera.position.constructor;
    const p = new V(m[12]!, m[13]!, m[14]!).project(o.viewport.camera);
    const r = o.viewport.renderer.domElement.getBoundingClientRect();
    return { x: r.left + ((p.x + 1) / 2) * r.width, y: r.top + ((1 - p.y) / 2) * r.height };
  });
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.up();
  await expect.poll(flat).toBe(true);
  // It stays on until F or Escape.
  await expect(page.getByTestId('plate-lay-on-face')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('plate-lay-on-face')).toHaveAttribute('aria-pressed', 'false');
});

test('arrange is desktop’s: nine copies of a cube make a 3 × 3 grid on the bed', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('app')).toHaveAttribute('data-engine-ready', 'yes');
  await page.getByTestId('file-input').setInputFiles([{ name: 'cube.stl', mimeType: 'model/stl', buffer: boxStl(20, 20, 20) }]);
  await expect(page.getByTestId('object-panel')).toBeVisible();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  for (let i = 0; i < 8; i++) await page.keyboard.press(`${mod}+k`);
  await expect(rows(page)).toHaveCount(9);
  await page.keyboard.press('a');
  const grid = () =>
    page.evaluate(() => {
      const s = (
        window as unknown as { __orca: { store: { getState(): { objects: { instances: number[][] }[] } } } }
      ).__orca.store.getState();
      const at = s.objects.map((o) => o.instances[0]!);
      return [new Set(at.map((m) => Math.round(m[12]!))).size, new Set(at.map((m) => Math.round(m[13]!))).size];
    });
  await expect.poll(grid).toEqual([3, 3]);
  await expect(page.getByTestId('notice-warning')).toHaveCount(0);
  // One undo step.
  await page.keyboard.press(`${mod}+z`);
  await expect.poll(grid).not.toEqual([3, 3]);
});

test('arrange keeps objects of different sizes apart', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('app')).toHaveAttribute('data-engine-ready', 'yes');
  const sizes = [
    [10, 10],
    [80, 20],
    [20, 90],
    [60, 60],
    [15, 40],
    [100, 30],
  ];
  await page
    .getByTestId('file-input')
    .setInputFiles(sizes.map(([x, y], i) => ({ name: `b${i}.stl`, mimeType: 'model/stl', buffer: boxStl(x, y, 10) })));
  await expect(rows(page)).toHaveCount(6);
  // Footprints on the bed (the boxes may be turned), and how many pairs of them overlap.
  const layout = () =>
    page.evaluate((sizes) => {
      const s = (
        window as unknown as { __orca: { store: { getState(): { objects: { instances: number[][] }[] } } } }
      ).__orca.store.getState();
      const at = s.objects.map((o, i) => {
        const m = o.instances[0]!,
          [sx, sy] = sizes[i]!;
        return {
          x: m[12]!,
          y: m[13]!,
          hx: (Math.abs(m[0]!) * sx! + Math.abs(m[4]!) * sy!) / 2,
          hy: (Math.abs(m[1]!) * sx! + Math.abs(m[5]!) * sy!) / 2,
        };
      });
      let overlaps = 0;
      for (let i = 0; i < at.length; i++)
        for (let j = i + 1; j < at.length; j++)
          if (Math.abs(at[i]!.x - at[j]!.x) < at[i]!.hx + at[j]!.hx - 0.01 && Math.abs(at[i]!.y - at[j]!.y) < at[i]!.hy + at[j]!.hy - 0.01)
            overlaps++;
      return { key: at.map((a) => `${a.x.toFixed(1)},${a.y.toFixed(1)}`).join(' '), overlaps };
    }, sizes);
  const before = await layout();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('a');
  await expect
    .poll(async () => {
      const now = await layout();
      return now.key === before.key ? -1 : now.overlaps;
    })
    .toBe(0);
});

test('shortcuts keep working after a click on a view tab or a dropdown that was closed again', async ({ page }) => {
  await start(page);
  await page.getByRole('tab', { name: 'Prepare' }).click();
  await page.keyboard.press(`${mod}+a`);
  await page.keyboard.press('Delete');
  await expect(rows(page)).toHaveCount(0);
  await page.keyboard.press(`${mod}+z`);
  await expect(rows(page)).toHaveCount(1);

  // The arrows belong to the open dropdown; once it is closed the plate has its keys again.
  await rows(page).first().click();
  const x = await field(page, 'position', 0).inputValue();
  await page.getByTestId('printer').click();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Escape');
  await expect(field(page, 'position', 0)).toHaveValue(x);
  await page.keyboard.press('Delete');
  await expect(rows(page)).toHaveCount(0);
});

test('deleted objects are neither sliced nor added to the library', async ({ page }) => {
  await start(page);
  await page.keyboard.press(`${mod}+a`);
  await page.keyboard.press('Delete');
  await expect(rows(page)).toHaveCount(0);
  await page.getByTestId('file-input').setInputFiles([{ name: 'kept.stl', mimeType: 'model/stl', buffer: boxStl(12, 12, 6) }]);
  await expect(rows(page)).toHaveCount(1);

  await page.getByTestId('slice').click();
  await expect(page.getByTestId('preview-legend')).toContainText('Outer wall');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('download').click()]);
  expect(download.suggestedFilename()).toMatch(/^kept_/);

  await page.getByRole('tab', { name: 'Prepare' }).click();
  await page.getByTestId('save-to-library').click();
  await page.getByTestId('tab-library').click();
  await expect(page.getByTestId('library-card')).toHaveCount(1);
  await expect(page.getByTestId('library-card')).toHaveAttribute('data-name', 'kept');
});

test('leaving the page with objects on the plate asks first', async ({ page }) => {
  await start(page);
  // Browsers ask only after the user did something on the page.
  await page.getByTestId('object-list').locator('li').first().click();
  const dialog = page.waitForEvent('dialog', { timeout: 10_000 });
  // Staying on the page leaves the reload waiting; it is not awaited.
  void page.reload({ timeout: 10_000 }).catch(() => {});
  const d = await dialog;
  expect(d.type()).toBe('beforeunload');
  await d.dismiss();
  await expect(rows(page)).toHaveCount(1);
});

test('number keys pick desktop’s camera views; Fit view frames the selection', async ({ page }) => {
  await start(page);
  if (!(await hasViewport(page))) return;
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  // The camera's direction from its target, and how far it is.
  const cam = () =>
    page.evaluate(() => {
      const vp = (
        window as unknown as {
          __orca: {
            viewport: {
              camera: { position: { x: number; y: number; z: number } };
              controls: { target: { x: number; y: number; z: number } };
            };
          };
        }
      ).__orca.viewport;
      const p = vp.camera.position,
        t = vp.controls.target;
      const d = [p.x - t.x, p.y - t.y, p.z - t.z],
        n = Math.hypot(...d);
      return { dir: d.map((x) => Math.round((x / n) * 100) / 100 + 0), dist: n, target: [t.x, t.y] };
    });
  const initial = await cam();
  // The views animate; wait for them to arrive.
  const dirIs = (d: number[]) => expect.poll(async () => (await cam()).dir).toEqual(d);
  await page.keyboard.press('1');
  await dirIs([0, 0, 1]);
  await page.keyboard.press('5');
  await dirIs([-1, 0, 0]);
  await page.keyboard.press('0');
  await dirIs([0, -0.79, 0.62]);
  const plate = await cam();
  // Fit view (the selected object's context menu): the object, closer than the whole bed.
  await page.evaluate(() => {
    const store = (window as unknown as { __orca: { store: { getState(): { selected: string[] }; setState(s: object): void } } }).__orca
      .store;
    store.setState({ menu: { id: store.getState().selected[0], x: 400, y: 300 } });
  });
  await page.getByTestId('menu-fit-view').click();
  await expect.poll(async () => (await cam()).dist).toBeLessThan(plate.dist / 2);
  const fit = await cam();
  // The view cube in the lower left corner: from the default view its top shows above its
  // front, the edge between them in the middle; a click on a side, edge or corner looks from there.
  const at = await page.evaluate(() => {
    const vp = (window as unknown as { __orca: { viewport: { cube: { left: number; bottom: number; size: number } } } }).__orca.viewport;
    const c = document.querySelector('canvas.viewport')!.getBoundingClientRect();
    return { x: c.left + vp.cube.left + vp.cube.size / 2, y: c.bottom - vp.cube.bottom - vp.cube.size / 2, left: vp.cube.left };
  });
  expect(at.left).toBe(8);
  await page.mouse.click(at.x, at.y - 18);
  await dirIs([0, 0, 1]);
  // From above (the front at the bottom), the top-front-right corner is at the lower right.
  await page.mouse.click(at.x + 24, at.y + 24);
  await dirIs([0.58, -0.58, 0.58]);
  await page.keyboard.press('0');
  await dirIs([0, -0.79, 0.62]);
  await page.mouse.click(at.x, at.y + 18);
  await dirIs([0, -1, 0]);
  // Dragging the cube turns the view.
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.move(at.x + 60, at.y, { steps: 6 });
  await page.mouse.up();
  expect((await cam()).dir).not.toEqual([0, -1, 0]);
  // The home button goes back to the view the page starts with.
  await page.getByTestId('view-home').click();
  await expect
    .poll(async () => {
      const c = await cam();
      return [c.dir, Math.round(c.dist), c.target.map(Math.round)];
    })
    .toEqual([initial.dir, Math.round(initial.dist), initial.target.map(Math.round)]);
  // The keys are the 3D view's: typed into a field, a digit stays there.
  const before = await cam();
  await page.getByTestId('op-position-0').fill('1');
  expect((await cam()).dir).toEqual(before.dir);
  void fit;
});
