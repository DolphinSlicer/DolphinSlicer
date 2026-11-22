// The object operations panel: position, relative rotation, scale ratios and size of the
// selected object, in world and object coordinates, as desktop's.
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, type Page, test } from '@playwright/test';
import { boxStl } from './models';
import { choose } from './select';

const field = (page: Page, kind: string, axis: number) => page.getByTestId(`op-${kind}-${axis}`);
async function enter(page: Page, kind: string, axis: number, value: string) {
  await field(page, kind, axis).fill(value);
  await field(page, kind, axis).press('Enter');
}
const values = (page: Page, kind: string) => Promise.all([0, 1, 2].map((a) => field(page, kind, a).inputValue()));

test('edit position, rotation, scale and size of the selected object', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('app')).toHaveAttribute('data-engine-ready', 'yes');
  await page.getByTestId('file-input').setInputFiles([{ name: 'box.stl', mimeType: 'model/stl', buffer: boxStl(30, 20, 15) }]);
  const panel = page.getByTestId('object-panel');
  await expect(panel).toBeVisible();
  await expect.poll(() => values(page, 'size')).toEqual(['30', '20', '15']);
  await expect(page.getByTestId('op-volume')).toHaveText('9000.00 mm³');
  // It rests on the bed: Z follows it in world coordinates.
  await expect(field(page, 'position', 2)).toBeDisabled();
  await expect(field(page, 'position', 2)).toHaveValue('7.5');

  await enter(page, 'position', 0, '100');
  await expect(field(page, 'position', 0)).toHaveValue('100');
  // Escape puts the value back.
  await field(page, 'position', 1).fill('3');
  await field(page, 'position', 1).press('Escape');
  await expect(field(page, 'position', 1)).not.toHaveValue('3');

  // Rotation: the object's angles. Turning it changes its footprint, not its scale or size.
  await enter(page, 'rotation', 2, '90');
  await expect(field(page, 'rotation', 2)).toHaveValue('90');
  await expect.poll(() => values(page, 'size')).toEqual(['30', '20', '15']);
  await expect.poll(() => values(page, 'scale')).toEqual(['100', '100', '100']);
  await expect(field(page, 'position', 0)).toHaveValue('100');
  await enter(page, 'rotation', 0, '45');
  await expect.poll(() => values(page, 'rotation')).toEqual(['45', '0', '90']);
  await expect.poll(() => values(page, 'size')).toEqual(['30', '20', '15']);
  // Typing the angle back undoes it; the reset button puts all back to 0.
  await enter(page, 'rotation', 0, '0');
  await expect.poll(() => values(page, 'rotation')).toEqual(['0', '0', '90']);
  await expect(field(page, 'position', 2)).toHaveValue('7.5');
  await page.getByTestId('op-reset-rotation').click();
  await expect.poll(() => values(page, 'rotation')).toEqual(['0', '0', '0']);
  await expect(page.getByTestId('op-reset-rotation')).toHaveCount(0);
  await enter(page, 'rotation', 2, '30');

  // Scale along the object's own axes, rotated or not: uniform by default; unlocked, one axis.
  await enter(page, 'scale', 0, '200');
  await expect.poll(() => values(page, 'size')).toEqual(['60', '40', '30']);
  await expect.poll(() => values(page, 'scale')).toEqual(['200', '200', '200']);
  await expect(page.getByTestId('op-volume')).toHaveText('72000.00 mm³');
  await page.getByTestId('op-uniform').click();
  await expect(page.getByTestId('op-uniform')).toHaveAttribute('aria-pressed', 'false');
  await enter(page, 'size', 0, '30');
  await expect.poll(() => values(page, 'size')).toEqual(['30', '40', '30']);
  await expect.poll(() => values(page, 'scale')).toEqual(['100', '200', '200']);
  await expect(field(page, 'rotation', 2)).toHaveValue('30');
  await page.getByTestId('op-reset-scale').click();
  await expect.poll(() => values(page, 'size')).toEqual(['30', '20', '15']);

  // Mirror: the size and place stay, the object is flipped (its volume stays positive).
  await page.getByTestId('op-mirror-0').click();
  await expect.poll(() => values(page, 'size')).toEqual(['30', '20', '15']);
  await expect(field(page, 'position', 0)).toHaveValue('100');
  await expect(page.getByTestId('op-volume')).toHaveText('9000.00 mm³');

  // Object coordinates: moving goes along the object's own axes.
  // Its Z axis points straight up here: a move along it would drop back to the bed.
  await choose(page.getByTestId('op-coords'), 'object');
  await expect(field(page, 'position', 2)).toBeDisabled();
  await enter(page, 'position', 1, '10');
  await choose(page.getByTestId('op-coords'), 'world');
  await expect(field(page, 'position', 1)).not.toHaveValue('125');

  // The focused field's axis shows in the 3D view; a rotation angle shows the axis it turns about.
  const hint = () =>
    page.evaluate(
      () => (window as unknown as { __orca: { store: { getState(): { axisHint: unknown } } } }).__orca.store.getState().axisHint,
    );
  await field(page, 'size', 1).focus();
  await expect.poll(hint).toEqual({ kind: 'scale', axis: 1, frame: 'object' });
  // Scaling uniformly, the hint is for all three axes.
  await page.getByTestId('op-uniform').click();
  await field(page, 'scale', 2).focus();
  await expect.poll(hint).toEqual({ kind: 'scale', axis: 2, frame: 'object', all: true });
  await page.getByTestId('op-uniform').click();
  await field(page, 'rotation', 0).focus();
  await expect.poll(hint).toEqual({ kind: 'rotate', axis: 0, frame: 'euler' });
  // Arcs with arrowheads towards the positive angle, the same size on screen for any model.
  const gizmo = () =>
    page.evaluate(() => {
      const vp = (
        window as unknown as {
          __orca: { viewport?: { render(): void; axisGizmo: { scale: { x: number } }; axisSpin: { children: unknown[] } | null } };
        }
      ).__orca.viewport;
      if (!vp) return null;
      vp.render();
      return { scale: vp.axisGizmo.scale.x, parts: vp.axisSpin?.children.length };
    });
  const small = await gizmo();
  if (small) {
    expect(small.parts).toBe(4); // two arcs and two heads
    await enter(page, 'scale', 0, '400');
    await field(page, 'rotation', 0).focus();
    const big = (await gizmo())!;
    expect(big.parts).toBe(4);
    expect(big.scale / small.scale).toBeGreaterThan(0.7);
    expect(big.scale / small.scale).toBeLessThan(1.3);
    await page.getByTestId('op-reset-scale').click();
    await field(page, 'rotation', 0).focus();
  }
  await page.getByTestId('op-mirror-2').hover();
  await expect.poll(hint).toEqual({ kind: 'mirror', axis: 2, frame: 'world' });
  // The pointer gone, the focused field's hint is back.
  await page.mouse.move(5, 400);
  await expect.poll(hint).toEqual({ kind: 'rotate', axis: 0, frame: 'euler' });
  await field(page, 'rotation', 0).blur();
  await expect.poll(hint).toBeNull();
  // The quick turns show theirs: about the world's Z, the −90° one the other way round.
  await page.getByRole('button', { name: 'Rotate left' }).hover();
  await expect.poll(hint).toEqual({ kind: 'rotate', axis: 2, frame: 'world', reverse: true });
  await page.getByRole('button', { name: 'Rotate right' }).hover();
  await expect.poll(hint).toEqual({ kind: 'rotate', axis: 2, frame: 'world' });
  await page.mouse.move(5, 400);
  await expect.poll(hint).toBeNull();

  // Desktop units follow Preferences: inches.
  await page.getByTestId('open-preferences').click();
  await page.getByRole('radio', { name: 'Imperial' }).click();
  await page.keyboard.press('Escape');
  await expect.poll(() => values(page, 'size')).toEqual(['1.18', '0.79', '0.59']);

  // Quick turns and delete, in the panel's header.
  const before = Number(await field(page, 'rotation', 2).inputValue());
  await page.getByRole('button', { name: 'Rotate right' }).click();
  await expect(field(page, 'rotation', 2)).toHaveValue(String(((before + 90 + 540) % 360) - 180));
  await page.getByTestId('op-delete').click();
  await expect(page.getByTestId('object-panel')).toHaveCount(0);
});

test('a rotated, stretched and mirrored object slices', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('app')).toHaveAttribute('data-engine-ready', 'yes');
  await page.getByTestId('file-input').setInputFiles([{ name: 'box.stl', mimeType: 'model/stl', buffer: boxStl(20, 20, 10) }]);
  await expect(page.getByTestId('object-panel')).toBeVisible();
  await enter(page, 'rotation', 2, '30');
  await page.getByTestId('op-uniform').click();
  await enter(page, 'size', 0, '40');
  await expect(field(page, 'size', 0)).toHaveValue('40');
  await enter(page, 'rotation', 1, '20');
  await page.getByTestId('op-mirror-1').click();
  await page.getByTestId('slice').click();
  await expect(page.getByTestId('preview-legend')).toContainText('Outer wall', { timeout: 60_000 });
  await expect(page.getByTestId('notice-error')).toHaveCount(0);
});
