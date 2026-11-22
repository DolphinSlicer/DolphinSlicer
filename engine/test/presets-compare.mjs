// Comparing presets (orca_presets_preset_values): any preset's settings, the selected one as
// edited.
//   node engine/test/presets-compare.mjs st|mt
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
const P = M._orca_presets_create();
const call = (fn, ...args) => M.ccall(fn, 'number', ['number', ...args.map(() => 'string')], [P, ...args]);
const str = (fn, ...args) => M.ccall(fn, 'string', ['number', ...args.map(() => 'string')], [P, ...args]);
const err = () => M.UTF8ToString(M._orca_presets_last_error(P));
const valuesOf = (type, name) => {
  const out = str('orca_presets_preset_values', JSON.stringify({ type, name }));
  if (!out) assert.fail(err());
  return JSON.parse(out).values;
};

assert.equal(call('orca_presets_load', '/orca'), 0, err());
assert.equal(call('orca_presets_select', JSON.stringify({ printer: 'MyKlipper 0.4 nozzle', defaults: true })), 0, err());

// Any preset's settings, as orca_presets_values gives the edited one's.
const fine = valuesOf('print', '0.12mm Fine @MyKlipper');
const edited = JSON.parse(M.ccall('orca_presets_values', 'string', ['number', 'string', 'number'], [P, 'print', 0])).values;
assert.equal(fine.layer_height, '0.12');
assert.deepEqual(Object.keys(fine).sort(), Object.keys(edited).sort(), 'the same settings');
assert.deepEqual(valuesOf('filament', 'Generic PETG @System').filament_type, ['PETG'], 'lists as their elements');
assert.equal(valuesOf('printer', 'MyKlipper 0.6 nozzle').nozzle_diameter[0], '0.6');

// The selected preset as edited.
assert.equal(call('orca_presets_edit', JSON.stringify({ type: 'print', values: { wall_loops: '5' } })), 0, err());
assert.equal(valuesOf('print', '0.20mm Standard @MyKlipper').wall_loops, '5', 'unsaved edits count');
assert.equal(call('orca_presets_reset', JSON.stringify({ type: 'print' })), 0, err());

assert.ok(!str('orca_presets_preset_values', JSON.stringify({ type: 'print', name: 'No such preset' })), 'a preset that does not exist fails');
assert.ok(!str('orca_presets_preset_values', JSON.stringify({ type: 'nope', name: '' })), 'an unknown type fails');

// Every preset of a type to compare with, also those for other printers.
const all = (type) => JSON.parse(str('orca_presets_all', JSON.stringify({ type })) || assert.fail(err()));
const prints = Object.fromEntries(all('print').map((e) => [e.name, e.compatible]));
assert.equal(prints['0.12mm Fine @MyKlipper'], true);
assert.equal(prints['0.12mm Fine @MyMarlin'], false, 'presets for another printer are listed, not compatible');
assert.ok(all('printer').some((e) => e.name === 'MyKlipper 0.6 nozzle'));
assert.ok(all('filament').some((e) => e.name === 'Generic PETG @System'));
assert.ok(!str('orca_presets_all', JSON.stringify({ type: 'nope' })), 'an unknown type fails');

// Another vendor's presets kept aside (orca_presets_load_aside): its settings, while the loaded
// presets keep saving to their own data folder.
for (const v of ['Anker', 'OrcaFilamentLibrary']) {
  M.FS.mkdirTree('/orca-aside/system');
  M.FS.writeFile(`/orca-aside/system/${v}.json`, readFileSync(join(profiles, `${v}.json`)));
  writeTree(join(profiles, v), `/orca-aside/system/${v}`);
}
const A = M._orca_presets_create();
assert.equal(M.ccall('orca_presets_load_aside', 'number', ['number', 'string'], [A, '/orca-aside']), 0, M.UTF8ToString(M._orca_presets_last_error(A)));
const anker = M.ccall('orca_presets_preset_values', 'string', ['number', 'string'], [A, JSON.stringify({ type: 'printer', name: 'Anker M5 0.4 nozzle' })]);
assert.ok(anker, M.UTF8ToString(M._orca_presets_last_error(A)));
assert.equal(JSON.parse(anker).values.nozzle_diameter[0], '0.4');
assert.ok(!str('orca_presets_preset_values', JSON.stringify({ type: 'printer', name: 'Anker M5 0.4 nozzle' })), 'not in the loaded presets');
assert.ok(str('orca_presets_save', JSON.stringify({ type: 'print', name: 'Saved after aside' })), err());
assert.ok(M.FS.readdir('/orca/user/default/process').some((f) => f.startsWith('Saved after aside')), 'saved in the data folder of the loaded presets');
M._orca_presets_destroy(A);
console.log('ok    presets-compare: any preset\'s settings, the selected one as edited; all presets of a type; another vendor\'s aside');
