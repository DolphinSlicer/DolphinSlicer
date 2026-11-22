// Preview benchmark (opt-in): BENCH_GCODE=/path/to/big.gcode npx playwright test bench --project=mt
// Loads the file through "Open a G-code file", then measures parse time and frame times for an
// orbiting camera with all layers shown and with the bottom half shown. Writes bench-preview.json.
// Note: headless Chromium on a GPU-less machine renders with SwiftShader (CPU), so frame times
// there are a lower bound on real hardware, not a measurement of it.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { statSync, writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

const file = process.env.BENCH_GCODE;
test.skip(!file, 'set BENCH_GCODE to run');

test('G-code preview performance', async ({ page }, info) => {
  test.setTimeout(600_000);
  if (process.env.BENCH_SIZE) {
    const [w, h] = process.env.BENCH_SIZE.split('x').map(Number);
    await page.setViewportSize({ width: w!, height: h! });
  }
  await page.goto('/');
  await expect(page.getByTestId('app')).toHaveAttribute('data-engine-ready', 'yes');
  const t0 = Date.now();
  await page.getByTestId('gcode-input').setInputFiles(file!);
  await expect(page.getByTestId('layer-slider')).toBeVisible({ timeout: 300_000 });
  const loadMs = Date.now() - t0;
  const renderer = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2')!;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  });
  const frames = Number(process.env.BENCH_FRAMES ?? 60);
  const stats = await page.evaluate(async (frames) => {
    type VP = {
      benchmark(n: number): Promise<{ fps: number; p50: number; p95: number }>;
      gcode: { setRange(a: number, b: number): void; layerRange: [number, number] };
    };
    const vp = (window as unknown as { __orca: { viewport: VP } }).__orca.viewport;
    const [, top] = vp.gcode.layerRange;
    const all = await vp.benchmark(frames);
    vp.gcode.setRange(0, Math.floor(top / 2));
    const half = await vp.benchmark(frames);
    vp.gcode.setRange(0, top);
    return { all, half, layers: top + 1 };
  }, frames);
  // biome-ignore lint/performance/useDomNodeTextContent: the text as shown, line breaks included
  const parse = await page.getByTestId('preview-legend').innerText();
  const result = { file, bytes: statSync(file!).size, renderer, loadMs, parseText: parse.match(/read in [\d.]+ s/)?.[0], ...stats };
  console.log(JSON.stringify(result, null, 2));
  writeFileSync(info.outputPath('bench-preview.json'), JSON.stringify(result, null, 2));
  writeFileSync('bench-preview.json', JSON.stringify(result, null, 2));
});
