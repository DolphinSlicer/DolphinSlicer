// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { printerSettingsId } from '../src/gcode/parse';
import type { PrinterConfig } from '../src/printers/connectors';
import { mergePrinters } from '../src/printers/sync';

const printer = (id: string, o: Partial<PrinterConfig> = {}): PrinterConfig => ({
  id,
  name: id,
  kind: 'moonraker',
  url: `http://${id}`,
  presets: ['P'],
  modified: 1,
  ...o,
});

describe('printer sync merge', () => {
  it('puts only synced printers in Drive', () => {
    const r = mergePrinters([printer('a', { sync: true, apiKey: 'k' }), printer('b')], [], []);
    expect(r.remote).toEqual([
      { id: 'a', modified: 1, printer: { name: 'a', kind: 'moonraker', url: 'http://a', presets: ['P'], apiKey: 'k' } },
    ]);
    expect(r.local.map((p) => p.id)).toEqual(['a', 'b']);
  });
  it('brings in printers from Drive', () => {
    const r = mergePrinters([], [], [{ id: 'a', modified: 2, printer: { name: 'Voron', kind: 'moonraker', url: 'http://v' } }]);
    expect(r.local).toEqual([{ id: 'a', name: 'Voron', kind: 'moonraker', url: 'http://v', sync: true, modified: 2 }]);
  });
  it('takes the newer edit', () => {
    const remote = [{ id: 'a', modified: 3, printer: { name: 'remote', kind: 'moonraker' as const, url: 'http://a' } }];
    expect(mergePrinters([printer('a', { name: 'local', sync: true, modified: 5 })], [], remote).remote[0]!.printer!.name).toBe('local');
    expect(mergePrinters([printer('a', { name: 'local', sync: true, modified: 2 })], [], remote).local[0]!.name).toBe('remote');
  });
  it('turning sync off leaves only the id in Drive, and other devices keep their copy', () => {
    const remote = [{ id: 'a', modified: 1, printer: { name: 'a', kind: 'moonraker' as const, url: 'http://a', apiKey: 'k' } }];
    const off = mergePrinters([printer('a', { modified: 4 })], [], remote);
    expect(off.remote).toEqual([{ id: 'a', modified: 4 }]);
    const other = mergePrinters([printer('a', { sync: true, apiKey: 'k' })], [], off.remote);
    expect(other.local).toEqual([{ ...printer('a', { apiKey: 'k' }), sync: false, modified: 4 }]);
    expect(other.remote).toEqual([{ id: 'a', modified: 4 }]);
  });
  it('deletions reach the other devices', () => {
    const remote = [{ id: 'a', modified: 1, printer: { name: 'a', kind: 'moonraker' as const, url: 'http://a' } }];
    const del = mergePrinters([], [{ id: 'a', modified: 2 }], remote);
    expect(del.remote).toEqual([{ id: 'a', modified: 2, deleted: true }]);
    expect(mergePrinters([printer('a', { sync: true })], [], del.remote).local).toEqual([]);
  });
  it('an edit after the deletion wins', () => {
    const remote = [{ id: 'a', modified: 5, printer: { name: 'edited', kind: 'moonraker' as const, url: 'http://a' } }];
    expect(mergePrinters([], [{ id: 'a', modified: 2 }], remote).local.map((p) => p.name)).toEqual(['edited']);
  });
});

describe('printer preset in G-code', () => {
  it('reads printer_settings_id', () => {
    expect(
      printerSettingsId('G1 X1\n; CONFIG_BLOCK_START\n; printer_model = X\n; printer_settings_id = Voron 2.4 350 0.4 nozzle\n; z = 1\n'),
    ).toBe('Voron 2.4 350 0.4 nozzle');
    expect(printerSettingsId('; printer_settings_id = "Original Prusa MK4"\r\n')).toBe('Original Prusa MK4');
    expect(printerSettingsId('; printer_settings_id = \n')).toBeNull();
    expect(printerSettingsId('G1 X1\n')).toBeNull();
  });
});
