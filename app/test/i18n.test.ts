// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { matchLanguage, t } from '../src/i18n/i18n';
import { currencySymbol, defaultCurrency, formatLength, formatMoney, formatWeight } from '../src/state/prefs';

describe('language', () => {
  it('picks the best of the shipped languages for the browser', () => {
    expect(matchLanguage(['de-AT', 'en'])).toBe('de');
    expect(matchLanguage(['zh-TW'])).toBe('zh_TW');
    expect(matchLanguage(['zh-Hant-HK'])).toBe('zh_TW');
    expect(matchLanguage(['zh'])).toBe('zh_CN');
    expect(matchLanguage(['pt-PT'])).toBe('pt_BR');
    expect(matchLanguage(['xx', 'fr-CA'])).toBe('fr');
    expect(matchLanguage(['xx'])).toBe('en');
  });

  it('fills placeholders, and falls back to English', () => {
    expect(t('Delete {name}?', { name: 'A' })).toBe('Delete A?');
    expect(t('{n} corners', { n: 4 })).toBe('4 corners');
  });
});

describe('currency and units', () => {
  it('defaults the currency to the browser region', () => {
    expect(defaultCurrency(['de-DE'])).toBe('EUR');
    expect(defaultCurrency(['en-GB'])).toBe('GBP');
    expect(defaultCurrency(['ja'])).toBe('JPY');
    expect(defaultCurrency(['en-US'])).toBe('USD');
  });

  it('formats money and lengths like desktop', () => {
    expect(formatMoney(1.5, 'EUR', 'de-DE')).toMatch(/1,50\s€/);
    expect(currencySymbol('USD', 'en-US')).toBe('$');
    expect(formatLength(2540, 'metric', 'filament')).toBe('2.54 m');
    expect(formatLength(2540, 'imperial', 'filament')).toBe('100.00 in');
    expect(formatWeight(28.3495, 'imperial')).toBe('1.00 oz');
    expect(formatWeight(12.34, 'metric')).toBe('12.3 g');
  });
});

// Needs the engine's schema and desktop's translations (npm run assets); skipped without them.
const built = ['public/settings-schema.json', '../.work/orca-src/localization/i18n'].every((p) =>
  existsSync(resolve(import.meta.dirname, '..', p)),
);

describe('translations', () => {
  it.skipIf(!built)(
    'cover every app string in every language, with the same placeholders',
    async () => {
      const { execFileSync } = await import('node:child_process');
      const app = resolve(import.meta.dirname, '..');
      execFileSync('node', ['scripts/build-i18n.mjs'], { cwd: app });
      // Throws (non-zero exit) with the list of problems.
      execFileSync('node', ['scripts/check-i18n.mjs'], { cwd: app, encoding: 'utf8' });
    },
    30000,
  );
});
