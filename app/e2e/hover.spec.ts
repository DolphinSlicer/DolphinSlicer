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

test('the hover glow starts on the model, not on its bounding box', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('app')).toHaveAttribute('data-engine-ready', 'yes');
  // Headless Firefox on a machine without a GPU has no WebGL: no 3D view to hover.
  test.skip(!(await page.evaluate(() => !!document.createElement('canvas').getContext('webgl2'))), 'no WebGL in this browser');
  // About 360 000 triangles: above 300 000 the hover used to fall back to the bounding box.
  await page.getByTestId('file-input').setInputFiles({ name: 'ball.stl', mimeType: 'model/stl', buffer: sphereStl(40, 600) });
  await expect(page.getByTestId('object-list').getByText('ball')).toBeVisible();

  // Find the ball: a coarse grid, then its outline's edge left, right, up and down of the center
  // by bisection.
  const box = (await page.locator('canvas').boundingBox())!;
  const hits: { x: number; y: number }[] = [];
  const N = 16;
  for (let i = 1; i < N; i++) {
    for (let j = 1; j < N; j++) {
      const x = box.x + (box.width * i) / N,
        y = box.y + (box.height * j) / N;
      if (await hoveredAt(page, x, y)) hits.push({ x, y });
    }
  }
  expect(hits.length).toBeGreaterThan(0);
  const cx = hits.reduce((a, h) => a + h.x, 0) / hits.length,
    cy = hits.reduce((a, h) => a + h.y, 0) / hits.length;
  expect(await hoveredAt(page, cx, cy)).toBe(true);
  const edge = async (dx: number, dy: number) => {
    let inside = 0,
      outside = Math.max(box.width, box.height);
    while (outside - inside > 1) {
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
