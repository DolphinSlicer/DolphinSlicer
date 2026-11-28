// The "Drop to import" overlay while files are dragged over the window, gone when they leave it.
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, type Page, test } from '@playwright/test';

/** Drag events with a file, as a browser sends them: onto `selector`, leaving toward `to` (null: out of the window). */
async function drag(page: Page, type: 'dragenter' | 'dragover' | 'dragleave' | 'dragend', selector: string, to: string | null = null) {
  await page.evaluate(
    ([type, selector, to]) => {
      const dt = new DataTransfer();
      dt.items.add(new File(['solid x\nendsolid x\n'], 'x.stl', { type: 'model/stl' }));
      const target = document.querySelector(selector)!;
      const relatedTarget = to ? document.querySelector(to) : null;
      target.dispatchEvent(new DragEvent(type!, { bubbles: true, cancelable: true, dataTransfer: dt, relatedTarget }));
    },
    [type, selector, to] as const,
  );
}

test('the drop overlay goes when a drag leaves the window or moves on, not within it', { tag: '@browser' }, async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('app')).toHaveAttribute('data-engine-ready', 'yes');
  const overlay = page.locator('.drop-overlay');

  // Over the plate, then out of the window from there (or Escape): gone.
  await drag(page, 'dragenter', 'canvas.viewport');
  await drag(page, 'dragover', 'canvas.viewport');
  await expect(overlay).toBeVisible();
  await drag(page, 'dragleave', 'canvas.viewport');
  await expect(overlay).toBeHidden();

  // From the plate to the sidebar: stays.
  await drag(page, 'dragover', 'canvas.viewport');
  await drag(page, 'dragleave', 'canvas.viewport', '.card.presets');
  await drag(page, 'dragover', '.card.presets');
  await expect(overlay).toBeVisible();
  await drag(page, 'dragleave', '.card.presets', '.drop-overlay');
  await expect(overlay).toBeVisible();

  // No more dragover, with no dragleave (a drag the browser lost track of): gone soon after.
  await expect(overlay).toBeHidden({ timeout: 3000 });

  // Ended elsewhere (dragend): gone at once.
  await drag(page, 'dragover', 'canvas.viewport');
  await expect(overlay).toBeVisible();
  await drag(page, 'dragend', 'canvas.viewport');
  await expect(overlay).toBeHidden({ timeout: 500 });
});
