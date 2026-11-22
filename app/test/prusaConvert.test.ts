// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { convertPresets, parseSourceFile, type TargetSchema } from '../src/presets/convert/prusa';

// The engine's schema (npm run assets); without it (CI without the engine) the tests are skipped.
const schemaPath = resolve(import.meta.dirname, '../public/settings-schema.json');
const schema = (existsSync(schemaPath) ? JSON.parse(readFileSync(schemaPath, 'utf8')) : null) as TargetSchema;
const mk4 = readFileSync(resolve(import.meta.dirname, 'fixtures/prusaslicer-mk4.ini'), 'utf8');
const convert = (file: string, text: string) => (schema ? convertPresets(parseSourceFile(file, text), schema, '2.5.0.0') : []);

describe.skipIf(!schema)('PrusaSlicer config export (MK4, Prusament PLA, 0.20mm QUALITY)', () => {
  const out = convert('config.ini', mk4);
  const by = (kind: string) => out.find((p) => p.kind === kind)!;

  it('splits into the three presets, named as in PrusaSlicer', () => {
    expect(out.map((p) => [p.kind, p.name])).toEqual(
      [
        ['print', '0.20mm QUALITY @MK4 0.4'],
        ['filament', 'Prusament PLA'],
        ['printer', 'Original Prusa MK4 0.4 nozzle'],
      ].sort((a, b) => ['print', 'filament', 'printer'].indexOf(a[0]!) - ['print', 'filament', 'printer'].indexOf(b[0]!)) as never,
    );
    expect(by('print').json).toMatchObject({ from: 'User', inherits: '', print_settings_id: '0.20mm QUALITY @MK4 0.4' });
    expect(by('filament').json.filament_settings_id).toEqual(['Prusament PLA']);
  });

  it('renames and recomputes print settings exactly', () => {
    const j = by('print').json;
    expect(j).toMatchObject({
      layer_height: '0.2',
      initial_layer_print_height: '0.2',
      wall_loops: '2',
      sparse_infill_pattern: 'grid',
      outer_wall_speed: ['25'],
      inner_wall_speed: ['45'],
      outer_wall_line_width: '0.45',
      line_width: '0.45',
    });
  });

  it('carries over filament and printer settings', () => {
    expect(by('filament').json).toMatchObject({
      nozzle_temperature: ['215'],
      hot_plate_temp: ['60'],
      textured_plate_temp: ['60'],
      filament_type: ['PLA'],
    });
    const p = by('printer').json;
    expect(p.printable_area).toEqual(['0x0', '250x0', '250x210', '0x210']);
    expect(p.nozzle_diameter).toEqual(['0.4']);
    // The printer model check keeps working without an OrcaSlicer printer model.
    expect(p.machine_start_gcode).toContain('M862.3 P "MK4"');
  });

  it('explains what is not 1:1', () => {
    const notes = out.flatMap((p) => p.notes.map((n) => `${p.kind}:${n.key}:${n.kind}`));
    expect(notes).toContain('filament:compatible_printers_condition:approx');
    expect(notes).toContain('printer:start_gcode:approx'); // filament_abrasive, nozzle_high_flow
    const unknown = by('printer').notes.find((n) => n.key === 'start_gcode')!;
    expect(String(unknown.vars?.names)).toContain('filament_abrasive');
    // Written in from the imported filament (0), so the G-code works unchanged.
    expect(by('printer').json.machine_start_gcode).toContain('A{(false ? 1 : 0)} F{(false ? 1 : 0)}');
  });
});

describe.skipIf(!schema)('formats and value rules', () => {
  it('reads a config bundle, resolving presets it inherits from', () => {
    const bundle =
      '[print:*base*]\nperimeters = 3\nlayer_height = 0.1\n[print:Fine]\ninherits = *base*\nlayer_height = 0.08\n\n[presets]\nprint = Fine\n';
    const [p, ...rest] = convert('bundle.ini', bundle);
    expect(rest).toHaveLength(0);
    expect(p!.json).toMatchObject({ name: 'Fine', wall_loops: '3', layer_height: '0.08' });
  });

  it('reads the settings stored in a PrusaSlicer G-code file', () => {
    const g =
      'G1 X1\n; prusaslicer_config = begin\n; layer_height = 0.15\n; perimeters = 4\n; fill_density = 15%\n; top_solid_layers = 5\n; bottom_solid_layers = 4\n; print_settings_id = Mine\n; prusaslicer_config = end\n';
    const [p] = convert('part.gcode', g);
    expect(p!.json).toMatchObject({ name: 'Mine', wall_loops: '4', sparse_infill_density: '15%', top_shell_layers: '5' });
  });

  it('resolves percentages over PrusaSlicer bases and automatic values', () => {
    const ini =
      'layer_height = 0.2\nperimeter_speed = 60\nexternal_perimeter_speed = 50%\ninfill_speed = 0\nmax_print_speed = 120\nsolid_infill_speed = 50%\n' +
      'extrusion_width = 0\nperimeter_extrusion_width = 225%\nfirst_layer_height = 75%\nsmall_perimeter_speed = 50%\n';
    const [p] = convert('speeds.ini', ini);
    expect(p!.json).toMatchObject({
      outer_wall_speed: ['30'],
      small_perimeter_speed: ['30'],
      sparse_infill_speed: ['120'],
      internal_solid_infill_speed: ['60'],
      inner_wall_line_width: '0.45',
      initial_layer_print_height: '0.15',
      line_width: '0.45', // automatic: 1.125 × an assumed 0.4 mm nozzle
    });
    const keys = p!.notes.map((n) => n.key);
    expect(keys).toContain('infill_speed'); // automatic speed
    expect(keys).toContain('nozzle_diameter'); // nozzle assumed
  });

  it('maps choices, and flags the ones without an equivalent', () => {
    const [p] = convert(
      'c.ini',
      'perimeters = 2\nlayer_height = 0.2\nseam_position = rear\ndraft_shield = limited\nfill_pattern = stars\ntop_solid_layers = 3\nbottom_solid_layers = 3\n',
    );
    expect(p!.json).toMatchObject({ seam_position: 'back', draft_shield: 'enabled', sparse_infill_pattern: 'tri-hexagon' });
    expect(p!.notes.map((n) => [n.key, n.kind])).toContainEqual(['draft_shield', 'approx']);
  });

  it('keeps settings OrcaSlicer files elsewhere with the preset that has them', () => {
    const ini =
      'layer_height = 0.2\nperimeters = 2\ntop_solid_layers = 3\nbottom_solid_layers = 3\nfill_density = 20%\nextruder_clearance_height = 25\n';
    const [p] = convert('print.ini', ini);
    expect(p!.json).not.toHaveProperty('extruder_clearance_height_to_rod');
    expect(p!.notes.map((n) => n.key)).toContain('extruder_clearance_height_to_rod');
  });

  it('fixes custom G-code variables', () => {
    const ini =
      'bed_shape = 0x0,200x0,200x200,0x200\nnozzle_diameter = 0.4\nretract_length = 1\ngcode_flavor = marlin2\nmax_print_height = 200\nprinter_model = XL\n' +
      'start_gcode = M104 S[first_layer_temperature]\\nG1 E-[retract_length] ; perimeters [perimeters]\\n{if foo_bar > 1}M117 x{endif}\\nM117 [mystery]\\nM862.3 P "[printer_model]"\n';
    const [p] = convert('p.ini', ini);
    const g = String(p!.json.machine_start_gcode);
    expect(g).toContain('M104 S[first_layer_temperature]'); // OrcaSlicer defines it
    expect(g).toContain('E-[retract_length]');
    expect(g).toContain('; M117 [mystery]'); // unknown, no value: commented out
    expect(g).toContain('{if foo_bar > 1}'); // inside an {if}: left as is, noted
    expect(g).toContain('M862.3 P "XL"');
    expect(String(p!.notes.find((n) => n.key === 'start_gcode')?.vars?.names)).toContain('mystery');
  });

  it('turns shrinkage into OrcaSlicer\'s "remaining size"', () => {
    const [f] = convert(
      'f.ini',
      'temperature = 210\nfirst_layer_temperature = 215\nbed_temperature = 60\nfilament_type = PETG\nfilament_diameter = 1.75\nfilament_shrinkage_compensation_xy = 0.5%\nfilament_shrinkage_compensation_z = 0%\n',
    );
    expect(f!.json).toMatchObject({ filament_shrink: ['99.5%'], filament_shrinkage_compensation_z: ['100%'] });
  });

  it('reads SuperSlicer configs and their extra settings', () => {
    const ini =
      '# generated by SuperSlicer 2.7.61.10\n' +
      'layer_height = 0.2\nperimeters = 3\ntop_solid_layers = 4\nbottom_solid_layers = 3\nfill_density = 20%\n' +
      'fill_top_flow_ratio = 95%\nfirst_layer_size_compensation = -0.15\nsolid_fill_pattern = rectilineargapfill\nonly_one_perimeter_top = 1\n' +
      'nozzle_diameter = 0.4\nbed_shape = 0x0,300x0,300x300,0x300\nmax_print_height = 300\ngcode_flavor = klipper\nmachine_max_feedrate_x = 500,200\nseam_gap = 15%\n' +
      'temperature = 240\nfirst_layer_temperature = 245\nbed_temperature = 80\nfilament_type = ABS\nfilament_pressure_advance = 0.04\nprint_settings_id = SS fine\nprinter_settings_id = SS Voron\nfilament_settings_id = "SS ABS"\n';
    const out = convert('ss.ini', ini);
    expect(out.every((p) => p.app === 'SuperSlicer')).toBe(true);
    const print = out.find((p) => p.kind === 'print')!.json,
      printer = out.find((p) => p.kind === 'printer')!.json;
    const filament = out.find((p) => p.kind === 'filament')!.json;
    expect(print).toMatchObject({
      top_solid_infill_flow_ratio: ['0.95'],
      elefant_foot_compensation: '0.15',
      internal_solid_infill_pattern: 'rectilinear',
      only_one_wall_top: '1',
      seam_gap: '15%',
    });
    expect(printer).toMatchObject({ gcode_flavor: 'klipper', machine_max_speed_x: ['500', '200'] });
    expect(filament).toMatchObject({ pressure_advance: ['0.04'], enable_pressure_advance: ['1'] });
    // The printer's seam gap is a print setting in OrcaSlicer: it went into the print preset.
    expect(printer).not.toHaveProperty('seam_gap');
  });
});
