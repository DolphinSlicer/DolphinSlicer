// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { mergeSettings, validSetting } from '../src/state/settingsMerge';

const lib = { printers: [{ vendor: 'Custom', model: 'Generic Klipper Printer', nozzle: '0.4' }], filaments: ['Generic PLA'], vendors: [] };

describe('syncing the settings through Drive', () => {
  it('takes the newer change of each setting', () => {
    const r = mergeSettings(
      { language: 'de', units: 'imperial' },
      { language: { json: '"de"', modified: 200 }, units: { json: '"imperial"', modified: 100 } },
      { language: { value: 'fr', modified: 150 }, units: { value: 'metric', modified: 150 } },
      1000,
    );
    expect(r.apply).toEqual({ units: 'metric' });
    expect(r.file.language).toEqual({ value: 'de', modified: 200 });
    expect(r.file.units).toEqual({ value: 'metric', modified: 150 });
    expect(r.meta.units).toEqual({ json: '"metric"', modified: 150 });
  });

  it('a setting never changed on this device takes the one in Drive', () => {
    const r = mergeSettings(
      { currency: 'EUR', library: null },
      {},
      { currency: { value: 'USD', modified: 0 }, library: { value: lib, modified: 5 } },
      1000,
    );
    expect(r.apply).toEqual({ currency: 'USD', library: lib });
  });

  it('a change made without being noted counts as made now', () => {
    const r = mergeSettings(
      { theme: 'dark' },
      { theme: { json: '"light"', modified: 10 } },
      { theme: { value: 'system', modified: 500 } },
      1000,
    );
    expect(r.apply).toEqual({});
    expect(r.file.theme).toEqual({ value: 'dark', modified: 1000 });
  });

  it('writes this device’s settings when Drive has none, but not those not chosen here', () => {
    const r = mergeSettings({ units: 'metric', selection: null }, {}, {}, 1000);
    expect(r.file).toEqual({ units: { value: 'metric', modified: 0 } });
  });

  it('ignores values in Drive it cannot use', () => {
    expect(validSetting('language', 'xx')).toBe(false);
    expect(validSetting('settingsMode', 'expert')).toBe(true);
    expect(validSetting('library', { printers: 'x' })).toBe(false);
    expect(validSetting('selection', { printer: 'MyKlipper 0.4 nozzle', process: 3 })).toBe(false);
    const r = mergeSettings(
      { language: 'de' },
      { language: { json: '"de"', modified: 1 } },
      { language: { value: 'xx', modified: 900 } },
      1000,
    );
    expect(r.apply).toEqual({});
    expect(r.file.language).toEqual({ value: 'de', modified: 1 });
  });
});

describe('a selection this device can only partly apply', () => {
  const asked = { printer: 'VZ330 0.4 nozzle', process: 'VzBot 0.12mm DEFAULT', filament: 'My ABS' };
  const got = { printer: 'VZ330 0.4 nozzle', process: 'VzBot 0.12mm DEFAULT', filament: 'Generic ABS' };
  const meta = { selection: { json: JSON.stringify(got), modified: 500, tried: JSON.stringify(asked) } };

  it('keeps Drive’s, and is not applied again', () => {
    const r = mergeSettings({ selection: got }, meta, { selection: { value: asked, modified: 500 } }, 1000);
    expect(r.apply).toEqual({});
    expect(r.file.selection).toEqual({ value: asked, modified: 500 });
    expect(r.meta.selection).toEqual(meta.selection);
  });

  it('a new choice in Drive is applied', () => {
    const other = { ...asked, filament: 'Generic PLA' };
    const r = mergeSettings({ selection: got }, meta, { selection: { value: other, modified: 600 } }, 1000);
    expect(r.apply).toEqual({ selection: other });
  });

  it('a choice made here wins', () => {
    const mine = { ...got, filament: 'Generic PETG' };
    const r = mergeSettings({ selection: mine }, meta, { selection: { value: asked, modified: 500 } }, 1000);
    expect(r.apply).toEqual({});
    expect(r.file.selection).toEqual({ value: mine, modified: 1000 });
  });
});
