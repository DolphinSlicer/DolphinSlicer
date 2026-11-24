// App preferences (Preferences dialog): theme, language, currency, units; the settings page's
// mode and the Quick settings card's settings. Kept in localStorage, synced through Drive (settingsSync.ts).
// SPDX-License-Identifier: AGPL-3.0-or-later
import { bcp47, currentLanguage, LANGUAGES, type Language, matchLanguage } from '../i18n/i18n';
import { MODES, type SettingsMode } from '../settings/schema';

export type Theme = 'system' | 'light' | 'dark';
export type Units = 'metric' | 'imperial';
export interface Prefs {
  theme: Theme;
  /** 'auto' follows the browser's languages. */
  language: Language | 'auto';
  /** ISO 4217 code, used to show costs. */
  currency: string;
  /** Imperial shows model and filament lengths in inches and weights in ounces, like desktop. Settings stay in mm. */
  units: Units;
  /** The settings page's Simple, Advanced or Expert mode. */
  settingsMode: SettingsMode;
  /** The print settings in the Quick settings card. */
  quickSettings: string[];
}

export const DEFAULT_QUICK_SETTINGS = [
  'layer_height',
  'wall_loops',
  'sparse_infill_density',
  'brim_type',
  'enable_support',
  'support_type',
  'support_on_build_plate_only',
];
export const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

const KEY = 'dolphin-slicer.prefs.v1';
const EURO = new Set([
  'AT',
  'BE',
  'CY',
  'DE',
  'EE',
  'ES',
  'FI',
  'FR',
  'GR',
  'HR',
  'IE',
  'IT',
  'LT',
  'LU',
  'LV',
  'MT',
  'NL',
  'PT',
  'SI',
  'SK',
  'AD',
  'MC',
  'SM',
  'VA',
  'ME',
  'XK',
]);
const REGION_CURRENCY: Record<string, string> = {
  US: 'USD',
  GB: 'GBP',
  CA: 'CAD',
  AU: 'AUD',
  NZ: 'NZD',
  IN: 'INR',
  JP: 'JPY',
  CN: 'CNY',
  TW: 'TWD',
  HK: 'HKD',
  KR: 'KRW',
  CH: 'CHF',
  LI: 'CHF',
  SE: 'SEK',
  NO: 'NOK',
  DK: 'DKK',
  IS: 'ISK',
  PL: 'PLN',
  CZ: 'CZK',
  HU: 'HUF',
  RO: 'RON',
  BG: 'BGN',
  TR: 'TRY',
  UA: 'UAH',
  RU: 'RUB',
  BR: 'BRL',
  MX: 'MXN',
  AR: 'ARS',
  CL: 'CLP',
  CO: 'COP',
  TH: 'THB',
  VN: 'VND',
  SG: 'SGD',
  MY: 'MYR',
  ID: 'IDR',
  PH: 'PHP',
  ZA: 'ZAR',
  IL: 'ILS',
  AE: 'AED',
  SA: 'SAR',
};

/** The currency of the browser's region (USD if unknown). */
export function defaultCurrency(locales: readonly string[] = navigator.languages): string {
  for (const l of locales) {
    let region: string | undefined;
    try {
      region = new Intl.Locale(l).maximize().region;
    } catch {
      continue;
    }
    if (!region) continue;
    if (EURO.has(region)) return 'EUR';
    if (REGION_CURRENCY[region]) return REGION_CURRENCY[region]!;
  }
  return 'USD';
}

export function loadPrefs(): Prefs {
  let saved: Partial<Prefs> = {};
  try {
    saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Prefs>;
  } catch {
    /* defaults */
  }
  return {
    theme: saved.theme === 'light' || saved.theme === 'dark' ? saved.theme : 'system',
    language: saved.language && (LANGUAGES as readonly string[]).includes(saved.language) ? saved.language : 'auto',
    currency: typeof saved.currency === 'string' && /^[A-Z]{3}$/.test(saved.currency) ? saved.currency : defaultCurrency(),
    units: saved.units === 'imperial' || saved.units === 'metric' ? saved.units : 'metric', // desktop's default too
    settingsMode: (MODES as readonly string[]).includes(saved.settingsMode ?? '') ? saved.settingsMode! : 'simple',
    quickSettings: isStrings(saved.quickSettings) ? saved.quickSettings : DEFAULT_QUICK_SETTINGS,
  };
}

export function savePrefs(p: Prefs) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* private mode: this session only */
  }
}

export const resolveLanguage = (p: Prefs): Language => (p.language === 'auto' ? matchLanguage(navigator.languages) : p.language);

const darkQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
export const isDark = (theme: Theme) => theme === 'dark' || (theme === 'system' && !!darkQuery?.matches);
/** Calls back when the system scheme changes. */
export function onSystemScheme(cb: () => void): () => void {
  darkQuery?.addEventListener('change', cb);
  return () => darkQuery?.removeEventListener('change', cb);
}

export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = theme;
}

// ── Formatting with the chosen currency and units ────────────────────────────────────────
export function formatMoney(amount: number, currency: string, lang: string): string {
  try {
    return new Intl.NumberFormat(lang, { style: 'currency', currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

/** The currency's symbol ("€", "$", "CHF"). */
export function currencySymbol(currency: string, lang: string): string {
  try {
    return (
      new Intl.NumberFormat(lang, { style: 'currency', currency, currencyDisplay: 'narrowSymbol' })
        .formatToParts(0)
        .find((p) => p.type === 'currency')?.value ?? currency
    );
  } catch {
    return currency;
  }
}

/** A number with a fixed count of decimals, written as the app's language writes it ("1,34" in German). */
export function formatNumber(n: number, digits: number): string {
  try {
    return new Intl.NumberFormat(bcp47(currentLanguage()), {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
      useGrouping: false,
    }).format(n);
  } catch {
    return n.toFixed(digits);
  }
}

const IN = 25.4,
  OZ = 28.3495;
/** A length in mm as desktop shows it: m or in for filament, mm or in for small sizes (a layer's height). */
export function formatLength(mm: number, units: Units, kind: 'filament' | 'size'): string {
  if (units === 'imperial') return `${formatNumber(mm / IN, kind === 'size' ? 3 : 2)} in`;
  return kind === 'filament' ? `${formatNumber(mm / 1000, 2)} m` : `${formatNumber(mm, 2)} mm`;
}
export function formatWeight(g: number, units: Units): string {
  return units === 'imperial' ? `${formatNumber(g / OZ, 2)} oz` : `${formatNumber(g, 1)} g`;
}
