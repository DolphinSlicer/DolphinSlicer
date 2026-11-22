// Using the app's dropdowns (src/ui/Select.tsx) in tests, as selectOption() and friends do for a
// <select>: the dropdown is the combobox button; its options exist while it is open.
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, type Locator } from '@playwright/test';

async function open(select: Locator): Promise<Locator> {
  if ((await select.getAttribute('aria-expanded')) !== 'true') await select.click({ timeout: 10_000 });
  const id = await select.getAttribute('aria-controls');
  const l = select.page().locator(`[id="${id}"]`);
  await expect(l).toBeVisible();
  return l;
}

/** Choose an option by its value or its label (as selectOption(string)), or by its label only. */
export async function choose(select: Locator, option: string | { label: string }): Promise<void> {
  const l = await open(select);
  const byLabel = l.getByRole('option', { name: typeof option === 'string' ? option : option.label, exact: true });
  const target =
    typeof option === 'string'
      ? l
          .locator(`[role=option][data-value="${option.replace(/["\\]/g, '\\$&')}"]`)
          .or(byLabel)
          .first()
      : byLabel;
  // A long list draws only the options in view: search for it.
  const search = select.page().locator('.select-pop input[type=search]');
  if (!(await target.count()) && (await search.count())) await search.fill(typeof option === 'string' ? option : option.label);
  await target.click();
  await expect(select).toHaveAttribute('aria-expanded', 'false');
}

/** The dropdown's options (labels, or values), in order; with `group`, those of that group. */
export async function options(select: Locator, { group, values }: { group?: string; values?: boolean } = {}): Promise<string[]> {
  const l = await open(select);
  const scope = group ? l.getByRole('group', { name: group, exact: true }) : l;
  const got = await scope
    .locator('[role=option]:not([aria-disabled])')
    .evaluateAll((els, v) => els.map((e) => (v ? (e.getAttribute('data-value') ?? '') : (e.textContent ?? ''))), !!values);
  await select.press('Escape');
  await expect(select).toHaveAttribute('aria-expanded', 'false');
  return got;
}

/** The selected value. */
export async function value(select: Locator): Promise<string> {
  return (await select.getAttribute('data-value')) ?? '';
}
