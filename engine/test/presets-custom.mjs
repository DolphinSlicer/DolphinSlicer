// Custom printers as the desktop's Create Printer dialog makes them: a root user printer (no
// parent) with process and filament copies made for it, children inheriting from it (variants
// too), deleting.
//   node engine/test/presets-custom.mjs st|mt
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
let P;
const call = (fn, ...a) => M.ccall(fn, 'number', ['number', ...a.map(() => 'string')], [P, ...a]);
const str = (fn, ...a) => M.ccall(fn, 'string', ['number', ...a.map(() => 'string')], [P, ...a]);
const err = () => JSON.parse(M.UTF8ToString(M._orca_presets_last_error(P)));
const values = (t) => JSON.parse(str('orca_presets_values', t));
const state = () => JSON.parse(str('orca_presets_state'));
const userFiles = () => {
  const out = [];
  const walk = (d) => { for (const n of M.FS.readdir(d)) { if (n === '.' || n === '..') continue; const p = `${d}/${n}`; if (M.FS.isDir(M.FS.stat(p).mode)) walk(p); else out.push(p.slice('/orca/user/default/'.length)); } };
  walk('/orca/user/default');
  return out.sort();
};
const load = () => { if (P) M._orca_presets_destroy(P); P = M._orca_presets_create(); assert.equal(call('orca_presets_load', '/orca'), 0, JSON.stringify(err())); };
load();

// Templates: what MyKlipper's print settings and filaments are.
const tpl = JSON.parse(str('orca_presets_templates', JSON.stringify({ printer: 'MyKlipper 0.4 nozzle' })));
assert.ok(tpl.processes.some((p) => p.name === '0.20mm Standard @MyKlipper'));
assert.ok(tpl.filaments.length > 10);
console.log('templates', tpl.processes.length, 'processes', tpl.filaments.length, 'filaments');

const spec = {
  model: 'Acme Cube', nozzle: '0.6', template: 'MyKlipper 0.4 nozzle', from_template: true,
  area: '0x0,220x0,220x230,0x230', height: 240,
  processes: ['0.20mm Standard @MyKlipper', '0.12mm Fine @MyKlipper'], filaments: ['Generic PLA @System'],
};
// At least one of each is required.
assert.ok(!str('orca_presets_create_printer', JSON.stringify({ ...spec, filaments: [] })));
const made = JSON.parse(str('orca_presets_create_printer', JSON.stringify(spec)) || 'null');
assert.ok(made, JSON.stringify(err()));
assert.equal(made.printer, 'Acme Cube 0.6 nozzle');
assert.deepEqual(made.created, ['Acme Cube 0.6 nozzle', 'Generic PLA @Acme Cube 0.6 nozzle', '0.20mm Standard @Acme Cube 0.6 nozzle', '0.12mm Fine @Acme Cube 0.6 nozzle']);
// Creating it again asks first: the names that exist come back.
assert.ok(!str('orca_presets_create_printer', JSON.stringify(spec)));
assert.deepEqual(JSON.parse(err().detail), made.created);
console.log('files', userFiles());
assert.ok(userFiles().includes('machine/base/Acme Cube 0.6 nozzle.json'), 'a root printer is saved in base/, as on desktop');

// The new printer: no parent, its own values, its own print settings.
let v = values('printer');
assert.equal(v.name, 'Acme Cube 0.6 nozzle');
assert.equal(v.user, true); assert.equal(v.inherits, ''); assert.equal(v.base, true);
assert.deepEqual(v.values.nozzle_diameter, ['0.6']);
assert.deepEqual(v.values.printable_area, ['0x0', '220x0', '220x230', '0x230']);
assert.equal(v.values.printable_height, '240');
assert.equal(v.values.printer_model, 'Acme Cube');
assert.deepEqual(v.attached, { filament: 1, print: 2 });
assert.equal(call('orca_presets_select', JSON.stringify({ printer: 'Acme Cube 0.6 nozzle', defaults: true })), 0);
let st = state();
assert.deepEqual(st.processes.map((p) => p.name).sort(), ['0.12mm Fine @Acme Cube 0.6 nozzle', '0.20mm Standard @Acme Cube 0.6 nozzle']);
assert.ok(st.filament_presets.some((f) => f.name === 'Generic PLA @Acme Cube 0.6 nozzle'));
const proc = values('print');
assert.equal(proc.inherits, '');
assert.equal(proc.values.layer_height, '0.3', 'from a template, process copies follow the nozzle (desktop)');
assert.equal(proc.values.line_width, '110%', 'percent widths already follow the nozzle; desktop leaves them');
assert.equal(proc.values.wall_loops, '2');

// Save as on the root: a child that only keeps what differs.
assert.equal(call('orca_presets_edit', JSON.stringify({ type: 'printer', values: { nozzle_diameter: { index: 0, value: '0.8' } } })), 0, JSON.stringify(err()));
assert.ok(str('orca_presets_save', JSON.stringify({ type: 'printer', name: 'Acme Cube 0.8' })), JSON.stringify(err()));
v = values('printer');
assert.equal(v.inherits, 'Acme Cube 0.6 nozzle'); assert.equal(v.base, false);
const child = JSON.parse(new TextDecoder().decode(M.FS.readFile('/orca/user/default/machine/Acme Cube 0.8.json')));
assert.equal(child.inherits, 'Acme Cube 0.6 nozzle');
assert.deepEqual(child.nozzle_diameter, ['0.8']);
assert.equal(child.printable_height, undefined, 'the child file holds only what differs');
// The child gets the print settings made for its root.
assert.equal(call('orca_presets_select', JSON.stringify({ printer: 'Acme Cube 0.8', defaults: true })), 0);
assert.equal(state().processes.length, 2);

// Saving the root updates the child (values it does not override).
assert.equal(call('orca_presets_select', JSON.stringify({ printer: 'Acme Cube 0.6 nozzle' })), 0);
assert.deepEqual(values('printer').children, ['Acme Cube 0.8']);
assert.equal(call('orca_presets_edit', JSON.stringify({ type: 'printer', values: { printable_height: '250' } })), 0);
assert.ok(str('orca_presets_save', JSON.stringify({ type: 'printer', name: 'Acme Cube 0.6 nozzle' })));
load();
assert.equal(call('orca_presets_select', JSON.stringify({ printer: 'Acme Cube 0.8' })), 0, JSON.stringify(err()));
v = values('printer');
assert.equal(v.values.printable_height, '250', 'the child follows its root after a reload');
assert.deepEqual(v.values.nozzle_diameter, ['0.8']);

// A variant of the user's own printer (here from its child) is a child of the root: it follows the root.
const linked = JSON.parse(str('orca_presets_create_printer', JSON.stringify({
  model: 'Acme Cube', nozzle: '0.4', template: 'Acme Cube 0.8', from_template: false, bed_from: 'Acme Cube 0.6 nozzle', link: true,
  processes: [], filaments: [], share: ['Generic PLA @Acme Cube 0.6 nozzle', '0.20mm Standard @Acme Cube 0.6 nozzle'],
})) || 'null');
assert.ok(linked, JSON.stringify(err()));
v = values('printer');
assert.equal(v.name, 'Acme Cube 0.4 nozzle');
assert.equal(v.inherits, 'Acme Cube 0.6 nozzle');
assert.deepEqual(v.values.nozzle_diameter, ['0.4']);
const linkedFile = JSON.parse(new TextDecoder().decode(M.FS.readFile('/orca/user/default/machine/Acme Cube 0.4 nozzle.json')));
assert.equal(linkedFile.inherits, 'Acme Cube 0.6 nozzle');
assert.equal(linkedFile.printable_height, undefined, 'the variant keeps only what differs');
assert.equal(call('orca_presets_select', JSON.stringify({ printer: 'Acme Cube 0.6 nozzle' })), 0);
assert.equal(call('orca_presets_edit', JSON.stringify({ type: 'printer', values: { printable_height: '260' } })), 0);
assert.ok(str('orca_presets_save', JSON.stringify({ type: 'printer', name: 'Acme Cube 0.6 nozzle' })));
assert.equal(call('orca_presets_select', JSON.stringify({ printer: 'Acme Cube 0.4 nozzle' })), 0, JSON.stringify(err()));
assert.equal(values('printer').values.printable_height, '260', 'a save of the root reaches the variant');
load();
assert.equal(call('orca_presets_select', JSON.stringify({ printer: 'Acme Cube 0.4 nozzle' })), 0, JSON.stringify(err()));
v = values('printer');
assert.equal(v.values.printable_height, '260', 'and after a reload');
assert.deepEqual(v.values.nozzle_diameter, ['0.4']);

// A root with children cannot be deleted; the children can; then the root goes with its own presets.
assert.notEqual(call('orca_presets_delete', JSON.stringify({ type: 'printer', name: 'Acme Cube 0.6 nozzle' })), 0);
assert.deepEqual(JSON.parse(err().detail).sort(), ['Acme Cube 0.4 nozzle', 'Acme Cube 0.8']);
for (const name of ['Acme Cube 0.8', 'Acme Cube 0.4 nozzle'])
  assert.equal(call('orca_presets_delete', JSON.stringify({ type: 'printer', name })), 0, JSON.stringify(err()));
assert.equal(call('orca_presets_delete', JSON.stringify({ type: 'printer', name: 'Acme Cube 0.6 nozzle' })), 0, JSON.stringify(err()));
assert.deepEqual(userFiles(), [], 'the printer took its print settings and filament along');

// Create Nozzle for Existing Printer: the bed comes from that printer.
const nozzle = JSON.parse(str('orca_presets_create_printer', JSON.stringify({
  model: 'MyKlipper', nozzle: '0.25', template: 'MyKlipper 0.4 nozzle', from_template: false, bed_from: 'MyKlipper 0.4 nozzle', link: true,
  processes: ['0.20mm Standard @MyKlipper'], filaments: ['Generic PETG @System'],
})) || 'null');
assert.ok(nozzle, JSON.stringify(err()));
v = values('printer');
assert.equal(v.name, 'MyKlipper 0.25 nozzle');
assert.equal(v.inherits, '', 'a variant of a system printer is a printer of its own (desktop)');
assert.equal(values('print').values.layer_height, '0.2', 'based on a printer (not a template), process copies stay as they are');

// Create Filament (desktop): "<vendor> <type> <serial> @<printer>" copies of a filament for the
// chosen printers, each for that printer alone, all with one new filament id.
const list = JSON.parse(str('orca_presets_filament_list'));
const pla = list.find((f) => f.name === 'Generic PLA @System');
assert.equal(pla.type, 'PLA');
assert.ok(pla.filament_id && !pla.user);
const fspec = { name: 'Acme PLA Matte', vendor: 'Acme', type: 'PLA', items: [
  { printer: 'MyKlipper 0.4 nozzle', preset: 'Generic PLA @System' }, { printer: 'MyKlipper 0.25 nozzle', preset: 'Generic PLA @System' }] };
const fil = JSON.parse(str('orca_presets_create_filament', JSON.stringify(fspec)) || 'null');
assert.ok(fil, JSON.stringify(err()));
assert.deepEqual(fil.created, ['Acme PLA Matte @MyKlipper 0.4 nozzle', 'Acme PLA Matte @MyKlipper 0.25 nozzle']);
assert.ok(!str('orca_presets_create_filament', JSON.stringify(fspec)), 'asks before replacing');
assert.deepEqual(JSON.parse(err().detail), fil.created);
assert.ok(userFiles().includes('filament/base/Acme PLA Matte @MyKlipper 0.4 nozzle.json'));
const made2 = JSON.parse(str('orca_presets_filament_list')).filter((f) => f.name.startsWith('Acme PLA Matte @'));
assert.equal(made2.length, 2);
assert.equal(new Set(made2.map((f) => f.filament_id)).size, 1, 'one filament id for all its presets');
assert.equal(made2[0].filament_id, fil.filament_id);
assert.match(fil.filament_id, /^P[0-9a-f]{7}$/);
assert.equal(call('orca_presets_select', JSON.stringify({ printer: 'MyKlipper 0.4 nozzle', filaments: ['Acme PLA Matte @MyKlipper 0.4 nozzle'] })), 0, JSON.stringify(err()));
v = values('filament');
assert.equal(v.inherits, '');
assert.deepEqual(v.values.filament_vendor, ['Acme']);
assert.deepEqual(v.values.compatible_printers, ['MyKlipper 0.4 nozzle']);
assert.ok(!state().filament_presets.some((f) => f.name === 'Acme PLA Matte @MyKlipper 0.25 nozzle'), 'each copy fits its printer only');
console.log('custom printers and filaments ok');
