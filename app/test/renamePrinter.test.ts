// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { renamePresetFiles, renamePrinterFiles } from '../src/presets/renamePrinter';

const P = 'Acme Cube 0.6 nozzle';
const files = {
  [`machine/base/${P}.json`]: JSON.stringify({
    name: P,
    inherits: '',
    from: 'User',
    printer_model: 'Acme Cube',
    printer_variant: '0.6',
    printer_settings_id: P,
    nozzle_diameter: ['0.6'],
  }),
  [`machine/base/${P}.info`]: 'sync_info = \nupdated_time = 0\n',
  'machine/Acme Cube 0.8.json': JSON.stringify({
    name: 'Acme Cube 0.8',
    inherits: P,
    nozzle_diameter: ['0.8'],
    printer_settings_id: 'Acme Cube 0.8',
  }),
  [`process/base/0.20mm Standard @${P}.json`]: JSON.stringify({
    name: `0.20mm Standard @${P}`,
    inherits: '',
    compatible_printers: [P],
    print_settings_id: `0.20mm Standard @${P}`,
  }),
  [`process/My fine @${P}.json`]: JSON.stringify({ name: `My fine @${P}`, inherits: `0.20mm Standard @${P}`, layer_height: '0.1' }),
  [`filament/base/Generic PLA @${P}.json`]: JSON.stringify({
    name: `Generic PLA @${P}`,
    inherits: '',
    compatible_printers: [P],
    filament_settings_id: [`Generic PLA @${P}`],
  }),
  'process/Other.json': '{"name": "Other", "inherits": "0.20mm Standard @MyKlipper"}',
};

describe('renaming a custom printer', () => {
  const r = renamePrinterFiles(files, P, 'Zeta Box');
  const j = (path: string) => JSON.parse(r.files[path]!);

  it('renames the printer, its own presets and every reference', () => {
    expect(r.name).toBe('Zeta Box 0.6 nozzle');
    expect(Object.keys(r.files).sort()).toEqual([
      'filament/base/Generic PLA @Zeta Box 0.6 nozzle.json',
      'machine/Acme Cube 0.8.json',
      'machine/base/Zeta Box 0.6 nozzle.info',
      'machine/base/Zeta Box 0.6 nozzle.json',
      `process/My fine @${P}.json`,
      'process/Other.json',
      'process/base/0.20mm Standard @Zeta Box 0.6 nozzle.json',
    ]);
    expect(j('machine/base/Zeta Box 0.6 nozzle.json')).toMatchObject({
      name: 'Zeta Box 0.6 nozzle',
      printer_model: 'Zeta Box',
      printer_settings_id: 'Zeta Box 0.6 nozzle',
    });
    expect(j('machine/Acme Cube 0.8.json').inherits).toBe('Zeta Box 0.6 nozzle');
    expect(j('process/base/0.20mm Standard @Zeta Box 0.6 nozzle.json')).toMatchObject({
      name: '0.20mm Standard @Zeta Box 0.6 nozzle',
      compatible_printers: ['Zeta Box 0.6 nozzle'],
      print_settings_id: '0.20mm Standard @Zeta Box 0.6 nozzle',
    });
    expect(j('filament/base/Generic PLA @Zeta Box 0.6 nozzle.json').filament_settings_id).toEqual(['Generic PLA @Zeta Box 0.6 nozzle']);
    // A child of a copy keeps its own name and follows its parent.
    expect(j(`process/My fine @${P}.json`).inherits).toBe('0.20mm Standard @Zeta Box 0.6 nozzle');
    expect(r.renamed).toMatchObject({ [P]: 'Zeta Box 0.6 nozzle', [`0.20mm Standard @${P}`]: '0.20mm Standard @Zeta Box 0.6 nozzle' });
  });

  it('leaves unrelated files as they are', () => {
    expect(r.files['process/Other.json']).toBe(files['process/Other.json']);
    expect(r.files['machine/base/Zeta Box 0.6 nozzle.info']).toBe(files[`machine/base/${P}.info`]);
  });

  it('only renames custom printers', () => {
    expect(() => renamePrinterFiles(files, 'Acme Cube 0.8', 'X')).toThrow();
  });
});

describe('renaming print settings or a filament', () => {
  const files = {
    'process/Fast.json': JSON.stringify({
      name: 'Fast',
      inherits: '0.20mm Standard @MyKlipper',
      print_settings_id: 'Fast',
      layer_height: '0.28',
    }),
    'process/Fast.info': 'sync_info = \nupdated_time = 0\n',
    'process/Fast child.json': JSON.stringify({ name: 'Fast child', inherits: 'Fast', print_settings_id: 'Fast child' }),
    // A filament may have a print preset's name; it stays as it is.
    'filament/Fast.json': JSON.stringify({ name: 'Fast', inherits: 'Generic PLA @System', filament_settings_id: ['Fast'] }),
    'filament/For fast.json': JSON.stringify({
      name: 'For fast',
      inherits: 'Fast',
      compatible_prints: ['Fast', 'Other'],
      filament_settings_id: ['For fast'],
    }),
  };
  const j = (out: Record<string, string>, path: string) => JSON.parse(out[path]!);

  it('renames print settings, presets based on them and the filaments that name them', () => {
    const out = renamePresetFiles(files, 'print', 'Fast', 'Quick');
    expect(Object.keys(out).sort()).toEqual([
      'filament/Fast.json',
      'filament/For fast.json',
      'process/Fast child.json',
      'process/Quick.info',
      'process/Quick.json',
    ]);
    expect(j(out, 'process/Quick.json')).toMatchObject({
      name: 'Quick',
      print_settings_id: 'Quick',
      inherits: '0.20mm Standard @MyKlipper',
    });
    expect(j(out, 'process/Fast child.json').inherits).toBe('Quick');
    expect(j(out, 'filament/For fast.json')).toMatchObject({ inherits: 'Fast', compatible_prints: ['Quick', 'Other'] });
    expect(out['filament/Fast.json']).toBe(files['filament/Fast.json']);
  });

  it('renames a filament and the filaments based on it, not print settings of that name', () => {
    const out = renamePresetFiles(files, 'filament', 'Fast', 'Silk');
    expect(j(out, 'filament/Silk.json')).toMatchObject({ name: 'Silk', filament_settings_id: ['Silk'] });
    expect(j(out, 'filament/For fast.json')).toMatchObject({ inherits: 'Silk', compatible_prints: ['Fast', 'Other'] });
    expect(out['process/Fast.json']).toBe(files['process/Fast.json']);
  });
});
