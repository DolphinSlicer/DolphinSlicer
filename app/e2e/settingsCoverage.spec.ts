// Every setting desktop's tabs place renders, on its page, with a control.
// The only keys not shown are the develop-mode ones (desktop shows those only in its developer
// mode) and the ones desktop's own rules hide for the selected presets, which the test
// asks the engine for. Keys the desktop tabs do not place at all are pinned in
// test/fixtures/hidden-keys.json (test/settings-layout.test.ts).
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
// @ts-expect-error plain JavaScript test helpers of the engine
import { loadVendor } from '../../engine/test/presets-pick.mjs';
// @ts-expect-error plain JavaScript test helpers of the engine
import { loadEngine } from '../../engine/test/run-engine.mjs';
import { value } from './select';

type Page = { title: string; groups: { title: string; keys: string[]; lines?: Record<string, string> }[] };
const app = resolve(import.meta.dirname, '..');
const layout: Record<string, Page[]> = JSON.parse(readFileSync(resolve(app, 'src/settings/layout.json'), 'utf8'));
const schema = JSON.parse(readFileSync(resolve(app, 'public/settings-schema.json'), 'utf8'));
const TABS = [
  ['print', 'Print settings'],
  ['filament', 'Filament'],
  ['printer', 'Printer'],
] as const;

/** What desktop's rules hide for these presets, per preset type (the engine's toggle rules). */
async function hiddenByRules(sel: { printer: string; process: string; filament: string }) {
  const M = await loadEngine(resolve(app, '../.work/build-engine-st/dist'), 'st');
  const P = loadVendor(M, resolve(app, '../.work/orca-src/resources/profiles'), 'Custom');
  const rc = M.ccall(
    'orca_presets_select',
    'number',
    ['number', 'string'],
    [P, JSON.stringify({ printer: sel.printer, process: sel.process, filaments: [sel.filament] })],
  );
  expect(rc, M.UTF8ToString(M._orca_presets_last_error(P))).toBe(0);
  const out: Record<string, Set<string>> = {};
  for (const [type] of TABS) {
    const v = JSON.parse(M.ccall('orca_presets_values', 'string', ['number', 'string', 'number'], [P, type, 0]));
    out[type] = new Set(Object.keys(v.states.hidden));
  }
  return out;
}

test("every setting on desktop's tabs renders, except the ones desktop hides", async ({ page }, info) => {
  test.skip(info.project.name !== 'mt', 'one browser is enough: the page content does not depend on it');
  test.setTimeout(180_000);
  await page.goto('/');
  await expect(page.getByTestId('app')).toHaveAttribute('data-engine-ready', 'yes');
  await expect(page.getByTestId('process')).toHaveAttribute('data-value', '0.20mm Standard @MyKlipper');
  const sel = {
    printer: await value(page.getByTestId('printer')),
    process: await value(page.getByTestId('process')),
    filament: await value(page.getByTestId('filament')),
  };
  const hidden = await hiddenByRules(sel);

  await page.getByTestId('tab-settings').click();
  const settings = page.getByTestId('settings');
  await settings.getByTestId('settings-mode-expert').click();
  let total = 0;
  for (const [type, label] of TABS) {
    await settings.getByRole('tab', { name: label, exact: true }).click();
    for (const [i, p] of layout[type]!.entries()) {
      await settings.locator('.settings-pages button').nth(i).click();
      await expect(settings.locator('.settings-pages button').nth(i)).toHaveAttribute('aria-current', 'true');
      // A row of several options is hidden as a whole when one of them is.
      const keys = p.groups.flatMap((g) =>
        g.keys.filter((k) => !g.lines?.[k] || !g.keys.some((o) => g.lines![o] === g.lines![k] && hidden[type]!.has(o))),
      );
      const expected = keys.filter((k) => schema.options[k].mode !== 'develop' && !hidden[type]!.has(k));
      // Wait for the page's fields, then compare the whole set.
      if (expected.length) await expect(settings.locator(`.field[data-key="${expected[0]}"]`)).toBeVisible();
      const rendered = await settings.locator('.settings-content .field').evaluateAll((els) => els.map((e) => e.getAttribute('data-key')));
      expect(rendered, `${type} › ${p.title}`).toEqual(expected);
      // Each with a control to edit it.
      const controls = await settings
        .locator('.settings-content .field')
        .evaluateAll((els) =>
          els
            .filter((e) => !e.querySelector('input, select, textarea, button, [contenteditable="true"]'))
            .map((e) => e.getAttribute('data-key')),
        );
      expect(controls, `${type} › ${p.title}: fields without a control`).toEqual([]);
      total += rendered.length;
    }
  }
  console.log(`settings coverage: ${total} fields rendered for ${sel.printer} | ${sel.process} | ${sel.filament}`);
});
