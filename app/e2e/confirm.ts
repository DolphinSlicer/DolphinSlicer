// Answering the app's confirmation dialog (src/ui/Confirm.tsx) in tests.
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, type Page } from '@playwright/test';

/** Wait for the confirmation (with this text, if given) and click one of its buttons. */
export async function answer(page: Page, button: string, text?: string | RegExp): Promise<void> {
  const dialog = page.getByTestId('confirm');
  await expect(dialog).toBeVisible();
  if (text) await expect(dialog).toContainText(text);
  await dialog.getByRole('button', { name: button, exact: true }).click();
  await expect(dialog).toHaveCount(0);
}
