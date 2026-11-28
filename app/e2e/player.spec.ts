// The preview's top layer played back: a slider to any moment of it, and real-time playback
// that goes on with the next layer.
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '@playwright/test';
import { boxStl } from './models';

test('a layer is played in real time, scrubbed and stepped through', { tag: '@engine' }, async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('app')).toHaveAttribute('data-engine-ready', 'yes');
  await page.getByTestId('file-input').setInputFiles({ name: 'box.stl', mimeType: 'model/stl', buffer: boxStl(40, 40, 10) });
  await page.getByTestId('slice').click();
  await expect(page.getByTestId('preview-legend')).toContainText('Outer wall', { timeout: 120_000 });

  // A layer in the middle, all of it shown: the slider at its end.
  const top = page.getByRole('slider', { name: 'Top layer' });
  await top.focus();
  for (let i = 0; i < 30; i++) await page.keyboard.press('ArrowDown');
  await expect(top).toHaveAttribute('aria-valuenow', '20');
  const time = page.getByTestId('layer-time');
  const total = Number(await time.getAttribute('aria-valuemax'));
  expect(total).toBeGreaterThan(3);
  await expect(time).toHaveAttribute('aria-valuenow', String(total));

  // From its start, move by move.
  await time.focus();
  await page.keyboard.press('Home');
  await expect(time).toHaveAttribute('aria-valuenow', '0');
  await expect(page.getByTestId('layer-time-label')).toContainText(/^0s/);
  for (let i = 0; i < 40; i++) await page.keyboard.press('ArrowRight');
  const stepped = Number(await time.getAttribute('aria-valuenow'));
  expect(stepped).toBeGreaterThan(0);
  expect(stepped).toBeLessThan(total);

  // Played: the time runs in real time, paused it stays.
  const play = page.getByTestId('play');
  await page.keyboard.press('Home');
  await play.click();
  await expect(play).toHaveAttribute('aria-pressed', 'true');
  await expect(time).toHaveAttribute('aria-valuenow', '2', { timeout: 4000 });
  await play.click();
  await expect(play).toHaveAttribute('aria-pressed', 'false');
  const paused = await time.getAttribute('aria-valuenow');
  await page.waitForTimeout(1200);
  await expect(time).toHaveAttribute('aria-valuenow', paused!);

  // At the layer's end, the next layer goes on.
  const r = (await page.locator('.hrange').boundingBox())!;
  await page.mouse.click(r.x + r.width * 0.97, r.y + r.height / 2);
  await play.click();
  await expect(top).toHaveAttribute('aria-valuenow', '21', { timeout: 5000 });
  await expect(play).toHaveAttribute('aria-pressed', 'true');

  // A layer picked by hand stops it and shows that layer whole.
  await top.focus();
  await page.keyboard.press('ArrowDown');
  await expect(play).toHaveAttribute('aria-pressed', 'false');
  await expect(time).toHaveAttribute('aria-valuenow', await time.getAttribute('aria-valuemax').then((v) => v!));
});
