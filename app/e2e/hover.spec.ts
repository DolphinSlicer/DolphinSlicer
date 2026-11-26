// Hover follows the model's surface, not its bounding box (the click already did).
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, type Page, test } from '@playwright/test';
import { sphereStl } from './models';

async function hoveredAt(page: Page, x: number, y: number): Promise<boolean> {
  await page.mouse.move(x, y);
  // The hover is picked on the next animation frame.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  return (await page.locator('canvas').evaluate((c) => c.style.cursor)) === 'grab';
}

test('the hover glow starts on the model, not on its bounding box', { tag: '@browser' }, async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('app')).toHaveAttribute('data-engine-ready', 'yes');
  // Headless Firefox on a machine without a GPU has no WebGL: no 3D view to hover.
  test.skip(!(await page.evaluate(() => !!document.createElement('canvas').getContext('webgl2'))), 'no WebGL in this browser');
  // About 360 000 triangles: above 300 000 the hover used to fall back to the bounding box.
  await page.getByTestId('file-input').setInputFiles({ name: 'ball.stl', mimeType: 'model/stl', buffer: sphereStl(40, 600) });
  await expect(page.getByTestId('object-list').getByText('ball')).toBeVisible();

  // The ball's center on screen (the 3D view's camera), then its outline's edge left, right, up
  // and down of it by bisection.
  const box = (await page.locator('canvas').boundingBox())!;
  const { cx, cy } = await page.evaluate(() => {
    type V = { clone(): V; applyMatrix4(m: unknown): V; project(c: unknown): V; x: number; y: number };
    const vp = (
      window as unknown as {
        __orca: {
          viewport: {
            camera: unknown;
            renderer: { domElement: HTMLCanvasElement };
            meshes: Map<
              string,
              { matrixWorld: unknown; geometry: { boundingSphere: { center: V } | null; computeBoundingSphere(): void } }[]
            >;
          };
        };
      }
    ).__orca.viewport;
    const mesh = [...vp.meshes.values()][0]![0]!;
    if (!mesh.geometry.boundingSphere) mesh.geometry.computeBoundingSphere();
    const p = mesh.geometry.boundingSphere!.center.clone().applyMatrix4(mesh.matrixWorld).project(vp.camera);
    const r = vp.renderer.domElement.getBoundingClientRect();
    return { cx: r.left + ((p.x + 1) / 2) * r.width, cy: r.top + ((1 - p.y) / 2) * r.height };
  });
  expect(await hoveredAt(page, cx, cy)).toBe(true);
  const edge = async (dx: number, dy: number) => {
    let inside = 0,
      outside = Math.max(box.width, box.height);
    while (outside - inside > 2) {
      const mid = (inside + outside) / 2;
      if (await hoveredAt(page, cx + dx * mid, cy + dy * mid)) inside = mid;
      else outside = mid;
    }
    return inside;
  };
  const left = await edge(-1, 0),
    right = await edge(1, 0),
    up = await edge(0, -1),
    down = await edge(0, 1);
  const rx = (left + right) / 2,
    ry = (up + down) / 2;
  const ox = cx + (right - left) / 2,
    oy = cy + (down - up) / 2;
  expect(rx).toBeGreaterThan(20);

  for (const [sx, sy] of [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ] as const) {
    // Inside the round outline: hovers.
    expect(await hoveredAt(page, ox + sx * 0.55 * rx, oy + sy * 0.55 * ry), `inside ${sx},${sy}`).toBe(true);
    // Outside the round outline but inside the box around it: a bounding-box hover would glow.
    expect(await hoveredAt(page, ox + sx * 0.85 * rx, oy + sy * 0.85 * ry), `corner ${sx},${sy}`).toBe(false);
  }
  // The pointer leaving the model ends the hover.
  expect(await hoveredAt(page, box.x + 5, box.y + 5)).toBe(false);
});
