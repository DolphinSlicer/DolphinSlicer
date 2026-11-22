// Applying preferences: theme on <html>, the UI language, persistence.
// SPDX-License-Identifier: AGPL-3.0-or-later
import { loadLanguage } from '../i18n/i18n';
import { applyTheme, type Prefs, resolveLanguage, savePrefs } from './prefs';
import { noteChange, type SettingKey } from './settingsMeta';
import { get, notify, set } from './store';

/** Before the first render: theme and language, so nothing flashes in the wrong one. */
export async function initPrefs() {
  const p = get().prefs;
  applyTheme(p.theme);
  await switchLanguage(p);
}

async function switchLanguage(p: Prefs) {
  const lang = resolveLanguage(p);
  try {
    await loadLanguage(lang);
    set({ lang });
  } catch (e) {
    await loadLanguage('en');
    set({ lang: 'en' });
    notify({ kind: 'error', title: 'Language not available', message: String((e as Error)?.message ?? e) });
  }
}

export async function updatePrefs(patch: Partial<Prefs>) {
  const prev = get().prefs;
  const p = { ...prev, ...patch };
  savePrefs(p);
  set({ prefs: p });
  for (const k of Object.keys(patch) as (keyof Prefs)[]) if (p[k] !== prev[k]) noteChange(k as SettingKey, p[k]);
  if (p.theme !== prev.theme) applyTheme(p.theme);
  if (p.language !== prev.language) await switchLanguage(p);
}
