// "Slice now" links: ?model=<url> opens the app with that model on the plate.
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, type Page, test } from '@playwright/test';
import { boxStl } from './models';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Content-Disposition' };

async function site(page: Page) {
  // A model site that allows other sites to download its files…
  await page.context().route('https://models.example.test/**', (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === '/files/cube.stl') return route.fulfill({ status: 200, headers: CORS, body: boxStl(25, 25, 25) });
    if (u.pathname === '/download') return route.fulfill({ status: 200, headers: CORS, body: boxStl(15, 15, 15) });
    if (u.pathname === '/named')
      return route.fulfill({
        status: 200,
        headers: { ...CORS, 'Content-Disposition': 'attachment; filename="Bracket.stl"' },
        body: boxStl(10, 30, 5),
      });
    if (u.pathname === '/login')
      return route.fulfill({ status: 200, headers: CORS, contentType: 'text/html', body: '<html><body>Please log in</body></html>' });
    return route.fulfill({ status: 404, headers: CORS, body: 'not found' });
  });
}

const link = (...models: string[]) => `/?${models.map((m) => `model=${encodeURIComponent(m)}`).join('&')}`;

test('a slice-now link opens the model on the plate, ready to slice', { tag: '@browser' }, async ({ page }) => {
  await site(page);
  await page.goto(link('https://models.example.test/files/cube.stl'));
  await expect(page.getByTestId('object-list')).toContainText('cube.stl');
  // The link is removed from the address, so a reload doesn't add the model again.
  expect(new URL(page.url()).search).toBe('');
  await expect(page.getByTestId('app')).toHaveAttribute('data-engine-ready', 'yes');
  await expect(page.getByTestId('slice')).toBeEnabled();
  await page.getByTestId('slice').click();
  await expect(page.getByTestId('download')).toBeEnabled();
});

test('several models, names from the server or the content', async ({ page }) => {
  await site(page);
  await page.goto(link('https://models.example.test/download?id=7', 'https://models.example.test/named'));
  const list = page.getByTestId('object-list');
  await expect(list).toContainText('download.stl');
  await expect(list).toContainText('Bracket.stl');
});

test('links that cannot be opened say why', async ({ page }) => {
  await site(page);
  // A real server that sends no CORS header (faked responses skip the browser's CORS check).
  const closed = createServer((_, res) => {
    res.writeHead(200, { 'Content-Type': 'model/stl' });
    res.end(boxStl());
  });
  await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r));
  const port = (closed.address() as AddressInfo).port;
  await page.goto(link(`http://127.0.0.1:${port}/part.stl`));
  await expect(page.getByTestId('notice-error')).toContainText(`127.0.0.1:${port} doesn’t let other sites download this file`);
  closed.close();
  await page.goto(link('https://models.example.test/missing.stl'));
  await expect(page.getByTestId('notice-error')).toContainText('HTTP 404');
  await page.goto(link('https://models.example.test/login'));
  await expect(page.getByTestId('notice-error')).toContainText('not an STL, 3MF, OBJ or AMF file');
  await expect(page.getByTestId('object-list')).toHaveCount(0);
});
