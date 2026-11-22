// Preset editing, saving, deleting and import through the engine's PresetBundle API.
//   node engine/test/presets-edit.mjs st|mt
// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadEngine } from './run-engine.mjs';

const here = import.meta.dirname;
const variant = process.argv[2] ?? 'st';
const M = await loadEngine(process.env.ENGINE_DIST ?? resolve(here, `../../.work/build-engine-${variant}/dist`), variant);
const profiles = resolve(here, '../../.work/orca-src/resources/profiles');
function writeTree(src, dst) {
  M.FS.mkdirTree(dst);
  for (const n of readdirSync(src)) { const s = join(src, n); if (statSync(s).isDirectory()) writeTree(s, `${dst}/${n}`); else if (n.endsWith('.json')) M.FS.writeFile(`${dst}/${n}`, readFileSync(s)); }
}
for (const v of ['Custom', 'OrcaFilamentLibrary']) {
  M.FS.mkdirTree('/orca/system');
  M.FS.writeFile(`/orca/system/${v}.json`, readFileSync(join(profiles, `${v}.json`)));
  writeTree(join(profiles, v), `/orca/system/${v}`);
}
const call = (fn, ...args) => M.ccall(fn, 'number', ['number', ...args.map(() => 'string')], [P, ...args]);
const str = (fn, ...args) => M.ccall(fn, 'string', ['number', ...args.map(() => 'string')], [P, ...args]);
const err = () => M.UTF8ToString(M._orca_presets_last_error(P));
const values = (t) => JSON.parse(str('orca_presets_values', t));
const config = () => JSON.parse(str('orca_presets_full_config'));

let P = M._orca_presets_create();
assert.equal(call('orca_presets_load', '/orca'), 0, err());
assert.equal(call('orca_presets_select', JSON.stringify({ printer: 'MyKlipper 0.4 nozzle', defaults: true })), 0, err());
let v = values('print');
assert.equal(v.name, '0.20mm Standard @MyKlipper');
assert.equal(v.system, true);
assert.deepEqual(v.dirty, []);
assert.equal(v.values.layer_height, '0.2');
console.log('print preset', v.name, 'keys', Object.keys(v.values).length, 'variant index', v.variant_index, 'variant keys', v.variant_keys.length);
console.log('printer variant index', values('printer').variant_index, 'filament', values('filament').variant_index);

// Option states: the desktop's toggle rules follow the edited values.
const states = (t) => values(t).states;
let s = states('print');
console.log('print states: disabled', Object.keys(s.disabled).length, 'hidden', Object.keys(s.hidden).length, 'enums', Object.keys(s.enums));
assert.ok('ironing_flow' in s.hidden, 'ironing settings hidden while ironing is off');
assert.ok(!('seam_position' in s.disabled));
assert.ok(s.enums.support_style.includes('grid'));
assert.equal(call('orca_presets_edit', JSON.stringify({ type: 'print', values: { ironing_type: 'top', wall_loops: '0', support_type: 'tree(auto)' } })), 0, err());
s = states('print');
assert.ok(!('ironing_flow' in s.hidden));
assert.match(s.disabled.seam_position, /wall loops/);
assert.deepEqual(s.enums.support_style, ['default', 'tree_slim', 'tree_strong', 'tree_hybrid', 'organic']);
assert.equal(values('print').values.wall_loops, '0', 'reading states does not edit the preset');
assert.equal(call('orca_presets_reset', JSON.stringify({ type: 'print' })), 0, err());
s = states('filament');
console.log('filament states: disabled', Object.keys(s.disabled), 'hidden', Object.keys(s.hidden).length);
s = states('printer');
console.log('printer states: disabled', Object.keys(s.disabled).length, 'hidden', Object.keys(s.hidden).length);
assert.ok('input_shaping_type' in s.hidden, 'Klipper printers do not emit input shaping');
assert.equal(call('orca_presets_edit', JSON.stringify({ type: 'printer', values: { gcode_flavor: 'marlin2' } })), 0, err());
assert.ok(!('input_shaping_type' in states('printer').hidden));
assert.equal(call('orca_presets_reset', JSON.stringify({ type: 'printer' })), 0, err());

// Selecting another filament keeps unsaved process edits; the state reports what is unsaved.
assert.equal(call('orca_presets_edit', JSON.stringify({ type: 'print', values: { layer_height: '0.24' } })), 0, err());
const stateNow = () => JSON.parse(str('orca_presets_state'));
assert.deepEqual(stateNow().dirty, { print: true, filament: false, printer: false });
const other = stateNow().filament_presets.find((f) => f.name !== stateNow().filaments[0]).name;
assert.equal(call('orca_presets_select', JSON.stringify({ printer: 'MyKlipper 0.4 nozzle', process: '0.20mm Standard @MyKlipper', filaments: [other] })), 0, err());
assert.equal(values('print').values.layer_height, '0.24', 'process edits survive a filament switch');
assert.equal(stateNow().filaments[0], other);
// Another nozzle: process edits that fit it stay, so there is nothing to ask before; those that
// don't (0.20mm is not for a 0.2 nozzle) would be lost, as would the printer's own.
const loses = (sel) => JSON.parse(str('orca_presets_select_loses', JSON.stringify(sel))).lost;
assert.deepEqual(loses({ variant: '0.6' }), []);
assert.deepEqual(loses({ variant: '0.2' }), ['print']);
assert.deepEqual(loses({ variant: '0.4' }), [], 'the nozzle in use');
assert.deepEqual(loses({ printer: 'MyKlipper 0.4 nozzle', process: '0.08mm Extra Fine @MyKlipper' }), ['print']);
assert.equal(call('orca_presets_select', JSON.stringify({ variant: '0.6' })), 0, err());
assert.equal(values('print').values.layer_height, '0.24', 'process edits survive a nozzle switch');
assert.equal(call('orca_presets_edit', JSON.stringify({ type: 'printer', values: { printable_height: '300' } })), 0, err());
assert.deepEqual(loses({ variant: '0.4' }), ['printer']);
assert.equal(call('orca_presets_select', JSON.stringify({ variant: '0.4' })), 0, err());
assert.equal(values('print').values.layer_height, '0.24');
assert.equal(stateNow().dirty.printer, false, 'the other printer is as saved');
assert.equal(call('orca_presets_reset', JSON.stringify({ type: 'print' })), 0, err());
assert.equal(stateNow().dirty.print, false);

// Invalid value: nothing changes.
assert.notEqual(call('orca_presets_edit', JSON.stringify({ type: 'print', values: { layer_height: 'abc' } })), 0);
console.log('invalid value rejected:', err());
assert.equal(call('orca_presets_edit', JSON.stringify({ type: 'print', values: { layer_height: '0.16', sparse_infill_density: '25%' } })), 0, err());
v = values('print');
assert.deepEqual([...v.dirty].sort(), ['layer_height', 'sparse_infill_density']);
assert.equal(config().layer_height, '0.16');

// One element of a vector option (filament temperature of the active variant).
const fv = values('filament');
console.log('nozzle_temperature', fv.values.nozzle_temperature, 'variant index', fv.variant_index);
assert.equal(call('orca_presets_edit', JSON.stringify({ type: 'filament', values: { nozzle_temperature: { index: fv.variant_index, value: '215' } } })), 0, err());
assert.equal(values('filament').values.nozzle_temperature[fv.variant_index], '215');
assert.equal(config().nozzle_temperature[0], '215');
assert.equal(call('orca_presets_reset', JSON.stringify({ type: 'filament' })), 0, err());

// G-code with ';' comments stays one element; whole-list edit of the bed shape.
const gcode = 'G28 ; home\nM104 S[nozzle_temperature_initial_layer] ; heat';
assert.equal(call('orca_presets_edit', JSON.stringify({ type: 'filament', values: { filament_start_gcode: { index: 0, value: gcode } } })), 0, err());
assert.deepEqual(values('filament').values.filament_start_gcode, [gcode]);
assert.equal(call('orca_presets_edit', JSON.stringify({ type: 'printer', values: { printable_area: { elements: ['0x0', '220x0', '220x220', '0x220'] } } })), 0, err());
assert.deepEqual(values('printer').values.printable_area, ['0x0', '220x0', '220x220', '0x220']);
assert.deepEqual(config().printable_area, ['0x0', '220x0', '220x220', '0x220']);
assert.equal(call('orca_presets_reset', JSON.stringify({ type: 'filament' })), 0, err());
assert.equal(call('orca_presets_reset', JSON.stringify({ type: 'printer' })), 0, err());

// Reset one key to system.
assert.equal(call('orca_presets_reset', JSON.stringify({ type: 'print', keys: ['sparse_infill_density'], to: 'system' })), 0, err());
assert.deepEqual(values('print').dirty, ['layer_height']);

// Save as a user preset: desktop writes only the differences plus "inherits".
const savedText = str('orca_presets_save', JSON.stringify({ type: 'print', name: 'My fine 0.16' }));
if (!savedText) { console.log('save failed:', err()); process.exit(1); }
const saved = JSON.parse(savedText);
console.log('saved', saved);
const file = M.FS.readFile(saved.file, { encoding: 'utf8' });
console.log(file);
const j = JSON.parse(file);
assert.equal(j.inherits, '0.20mm Standard @MyKlipper');
assert.equal(j.layer_height, '0.16');
assert.equal(j.from, 'User');
v = values('print');
assert.equal(v.name, 'My fine 0.16');
assert.equal(v.user, true);
assert.deepEqual(v.dirty, []);
assert.deepEqual(v.from_system, ['layer_height']);
console.log('info file:', M.FS.readFile(saved.file.replace(/\.json$/, '.info'), { encoding: 'utf8' }).trim().replace(/\n/g, ' | '));

// Reload from MEMFS (as the app does on start-up): the user preset is found again.
M._orca_presets_destroy(P);
P = M._orca_presets_create();
assert.equal(call('orca_presets_load', '/orca'), 0, err());
assert.equal(call('orca_presets_select', JSON.stringify({ printer: 'MyKlipper 0.4 nozzle', process: 'My fine 0.16' })), 0, err());
assert.equal(values('print').name, 'My fine 0.16');
assert.equal(config().layer_height, '0.16');

// Delete it: a compatible preset is selected instead.
assert.equal(call('orca_presets_delete', JSON.stringify({ type: 'print', name: 'My fine 0.16' })), 0, err());
console.log('after delete, process =', values('print').name);
assert.throws(() => M.FS.stat(saved.file));

// Import the file we saved (desktop format) back.
M.FS.mkdirTree('/import');
M.FS.writeFile('/import/My fine 0.16.json', file);
const imp = JSON.parse(str('orca_presets_import', JSON.stringify({ files: ['/import/My fine 0.16.json'] })));
console.log('imported', imp);
assert.equal(imp.imported[0]?.name, 'My fine 0.16');
const again = M.FS.readFile(imp.imported[0].file, { encoding: 'utf8' });
assert.equal(again, file, 'export → import → export is byte-identical');
// A deleted printer or print setting leaves the lists of compatible ones (desktop leaves it there).
const saveAs = (type, name) => JSON.parse(str('orca_presets_save', JSON.stringify({ type, name }))).file;
const listIn = (f, key) => JSON.parse(M.FS.readFile(f, { encoding: 'utf8' }))[key];
assert.equal(call('orca_presets_select', JSON.stringify({ printer: 'MyKlipper 0.4 nozzle', defaults: true })), 0, err());
assert.equal(call('orca_presets_edit', JSON.stringify({ type: 'printer', values: { gcode_flavor: 'marlin2' } })), 0, err());
saveAs('printer', 'MyKlipper variant');
assert.equal(call('orca_presets_edit', JSON.stringify({ type: 'print', values: { compatible_printers: '"MyKlipper 0.4 nozzle";"MyKlipper variant"' } })), 0, err());
const sharedPrint = saveAs('print', 'Shared print');
assert.equal(call('orca_presets_edit', JSON.stringify({ type: 'filament', values: { compatible_printers: '"MyKlipper variant"', compatible_prints: '"Shared print"' } })), 0, err());
const variantFilament = saveAs('filament', 'Variant PLA');
assert.deepEqual(listIn(sharedPrint, 'compatible_printers'), ['MyKlipper 0.4 nozzle', 'MyKlipper variant']);
assert.deepEqual(listIn(variantFilament, 'compatible_printers'), ['MyKlipper variant']);
assert.equal(call('orca_presets_delete', JSON.stringify({ type: 'printer', name: 'MyKlipper variant' })), 0, err());
assert.deepEqual(listIn(sharedPrint, 'compatible_printers'), ['MyKlipper 0.4 nozzle'], 'the other printer stays');
assert.deepEqual(listIn(variantFilament, 'compatible_printers'), [], 'left empty');
assert.equal(call('orca_presets_select', JSON.stringify({ printer: 'MyKlipper 0.4 nozzle', process: 'Shared print', filaments: ['Variant PLA'] })), 0, err());
assert.deepEqual(values('filament').dirty, [], 'the selected copy follows');
assert.equal(call('orca_presets_delete', JSON.stringify({ type: 'print', name: 'Shared print' })), 0, err());
assert.deepEqual(listIn(variantFilament, 'compatible_prints'), []);
assert.deepEqual(values('filament').dirty, [], 'the selected filament is not left edited');
// The filament slot takes the filament's default color (desktop's update_ams_color); one with
// none leaves the slot's color.
const setColor = (c) => assert.equal(call('orca_presets_edit', JSON.stringify({ type: 'filament', values: { default_filament_colour: { index: 0, value: c } } })), 0, err());
setColor('#1E88E5');
assert.deepEqual(config().filament_colour, ['#1E88E5']);
setColor('');
assert.deepEqual(config().filament_colour, ['#1E88E5'], 'no default color: the slot keeps its color');
console.log('OK: edit, reset, save, reload, delete, import round trip, compatible lists after a delete, filament color');
