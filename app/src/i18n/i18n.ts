// Translations. Keys are the English text (like gettext msgids), so desktop OrcaSlicer's own
// translations apply to every setting name, tooltip and engine message unchanged, and the
// app's own text is looked up the same way. public/i18n/<code>.json is built by
// scripts/build-i18n.mjs from OrcaSlicer's .po files plus src/i18n/app/<code>.json.
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The languages desktop OrcaSlicer ships (localization/i18n), by its codes. */
export const LANGUAGES = [
  'en',
  'ca',
  'cs',
  'de',
  'es',
  'eu',
  'fr',
  'hu',
  'it',
  'ja',
  'ko',
  'lt',
  'nl',
  'pl',
  'pt_BR',
  'ru',
  'sv',
  'th',
  'tr',
  'uk',
  'vi',
  'zh_CN',
  'zh_TW',
] as const;
export type Language = (typeof LANGUAGES)[number];

/** "pt_BR" → "pt-BR" (for Intl and the lang attribute). */
export const bcp47 = (code: string) => code.replace('_', '-');

/** The language's own name ("Deutsch", "日本語"). */
export function nativeName(code: Language): string {
  // Browsers without Basque name it in English.
  if (code === 'eu') return 'Euskara';
  try {
    const n = new Intl.DisplayNames([bcp47(code)], { type: 'language' }).of(bcp47(code));
    return n ? n[0]!.toLocaleUpperCase(bcp47(code)) + n.slice(1) : code;
  } catch {
    return code;
  }
}

/** The best of our languages for the browser's preferred ones (English if none fits). */
export function matchLanguage(preferred: readonly string[]): Language {
  for (const tag of preferred) {
    const [lang, ...rest] = tag.toLowerCase().split('-');
    if (lang === 'zh') {
      // Traditional script for Taiwan, Hong Kong, Macau and explicit Hant.
      return rest.some((r) => ['tw', 'hk', 'mo', 'hant'].includes(r)) ? 'zh_TW' : 'zh_CN';
    }
    if (lang === 'pt') return 'pt_BR';
    const hit = LANGUAGES.find((l) => l === lang);
    if (hit) return hit;
  }
  return 'en';
}

let dict: Record<string, string> = {};
let current: Language = 'en';
export const currentLanguage = () => current;

/** Translate English text; {name} placeholders are filled from vars. */
export function t(text: string, vars?: Record<string, string | number>): string {
  const s = dict[text] || text;
  return vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s;
}

/** Marks text for translation where it is defined; translate it with t() where it is shown. */
export const N_ = (text: string) => text;

/** Translate if there is a translation (engine and preset text that may have none). */
export const tr = (text: string) => (text ? dict[text] || text : text);

export async function loadLanguage(code: Language): Promise<void> {
  if (code === 'en') {
    dict = {};
    current = code;
  } else {
    const r = await fetch(`i18n/${code}.json?v=${__APP_COMMIT__}`);
    if (!r.ok) throw new Error(`i18n/${code}.json: HTTP ${r.status}`);
    dict = (await r.json()) as Record<string, string>;
    current = code;
  }
  document.documentElement.lang = bcp47(code);
}
