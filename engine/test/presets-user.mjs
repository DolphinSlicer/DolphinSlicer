// User presets between the app and desktop OrcaSlicer.
//   node engine/test/presets-user.mjs st|mt            check
//   node engine/test/presets-user.mjs st --export      write fixtures/presets/user/engine/ (then
//                                                      python3 -I engine/scripts/make-user-refs.py)
// Two sets of user presets (printer, process, filament, each inheriting a system preset):
// - desktop/: files in the format desktop OrcaSlicer saves (written by hand; the CLI cannot save
//   presets). Imported here, they must slice to the G-code desktop makes with them.
// - engine/: saved by the engine after editing, as the app does. Saving again must give the same
//   bytes, and desktop must slice them to the same G-code as the engine (so desktop loads them
//   as the app means them).
// Desktop's G-code (make-user-refs.py) comes from the CLI with these files in its data folder.
// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { loadEngine, slice } from './run-engine.mjs';
import { compareGcode } from './gcode-compare.mjs';
import { loadVendor } from './presets-pick.mjs';

const here = import.meta.dirname;
const variant = process.argv[2] ?? 'st';
const exporting = process.argv.includes('--export');
const profiles = resolve(here, '../../.work/orca-src/resources/profiles');
const dir = resolve(here, 'fixtures/presets/user');
const M = await loadEngine(process.env.ENGINE_DIST ?? resolve(here, `../../.work/build-engine-${variant}/dist`), variant);
const TYPES = { machine: 'printer', process: 'print', filament: 'filament' };

let P;
const call = (fn, j) => M.ccall(fn, 'number', ['number', 'string'], [P, JSON.stringify(j)]);
const str = (fn, j) => M.ccall(fn, 'string', ['number', 'string'], [P, typeof j === 'string' ? j : JSON.stringify(j)]);
const err = () => M.UTF8ToString(M._orca_presets_last_error(P));
const state = () => JSON.parse(M.UTF8ToString(M._orca_presets_state(P)));
const ok = (rc) => assert.equal(rc, 0, err());

/** Edit and save the engine's user presets, as the app's settings tab does. */
function engineSet() {
  P = loadVendor(M, profiles, 'Custom');
  const files = {};
  const save = (folder, type, name) => {
    const saved = JSON.parse(str('orca_presets_save', { type, name }) || 'null');
    assert.ok(saved, err());
    files[`${folder}/${name}.json`] = M.FS.readFile(saved.file, { encoding: 'utf8' });
  };
  ok(call('orca_presets_select', { printer: 'MyKlipper 0.4 nozzle', defaults: true }));
  ok(call('orca_presets_edit', { type: 'printer', values: { retraction_length: { index: 0, value: '0.6' }, z_hop: { index: 0, value: '0.3' } } }));
  save('machine', 'printer', 'Engine Klipper');
  ok(call('orca_presets_select', { printer: 'Engine Klipper', process: '0.20mm Standard @MyKlipper', filaments: ['Generic PLA @System'] }));
  ok(call('orca_presets_edit', { type: 'print', values: { layer_height: '0.16', wall_loops: '4', sparse_infill_pattern: 'cubic', sparse_infill_density: '20%' } }));
  save('process', 'print', 'Engine strong');
  const fv = JSON.parse(str('orca_presets_values', 'filament'));
  ok(call('orca_presets_edit', { type: 'filament', values: { nozzle_temperature: { index: fv.variant_index ?? 0, value: '205' }, filament_flow_ratio: { index: fv.variant_index ?? 0, value: '0.97' } } }));
  save('filament', 'filament', 'Engine PLA');
  M._orca_presets_destroy(P);
  return files;
}

function readSet(name) {
  const files = {};
  for (const folder of Object.keys(TYPES))
    for (const f of readdirSync(join(dir, name, folder))) files[`${folder}/${f}`] = readFileSync(join(dir, name, folder, f), 'utf8');
  return files;
}

if (exporting) {
  for (const [path, text] of Object.entries(engineSet())) {
    mkdirSync(join(dir, 'engine', path.split('/')[0]), { recursive: true });
    writeFileSync(join(dir, 'engine', path), text);
  }
  console.log('wrote', join(dir, 'engine'));
  process.exit(0);
}

// Saving again gives the committed bytes (what desktop was given).
const again = engineSet();
assert.deepEqual(again, readSet('engine'), 'the engine saves its user presets as before');
console.log('ok    engine user presets save byte-identically');

// Whether a config holds a preset file's value. A file holds one element for every variant
// (nozzle volume type), or one for all; a config has the selected variant's element (the first
// here: MyKlipper's Direct Drive Standard) or, the CLI's, every variant's. "nil" in a file means
// the variant inherits the parent's value.
function holds(config, v) {
  if (!Array.isArray(v)) return config === v;
  if (!Array.isArray(config)) return false;
  if (v.length === 1) return config.length > 0 && config.every((x) => x === v[0]);
  return config.length <= v.length && config.every((x, i) => v[i] === 'nil' || x === v[i]);
}
const body = (g) => g.replace(/; CONFIG_BLOCK_START[\s\S]*?; CONFIG_BLOCK_END\n?/, '');
const cube = readFileSync(resolve(here, 'fixtures/cube.3mf'));
let failed = 0;
for (const set of ['desktop', 'engine']) {
  const files = readSet(set);
  P = loadVendor(M, profiles, 'Custom');
  M.FS.mkdirTree('/import');
  const paths = Object.entries(files).map(([p, text]) => {
    const f = `/import/${p.replace('/', '-')}`;
    M.FS.writeFile(f, text);
    return f;
  });
  const imp = JSON.parse(str('orca_presets_import', { files: paths }) || 'null');
  assert.ok(imp, err());
  assert.equal(imp.imported?.length, 3, `${set}: imported ${JSON.stringify(imp)}`);
  const name = (folder) => JSON.parse(Object.entries(files).find(([p]) => p.startsWith(`${folder}/`))[1]).name;
  const sel = { printer: name('machine'), process: name('process'), filaments: [name('filament')] };
  ok(call('orca_presets_select', sel));
  const st = state();
  assert.deepEqual({ printer: st.printer, process: st.process, filaments: st.filaments }, sel);
  const ours = JSON.parse(M.ccall('orca_presets_full_config', 'string', ['number'], [P]));
  M._orca_presets_destroy(P);

  const ref = JSON.parse(gunzipSync(readFileSync(join(dir, `${set}.settings.json.gz`))).toString('utf8'));
  for (const k of ['curr_bed_type', 'enable_prime_tower', 'filament_colour']) ours[k] = ref[k];
  // Every edited key reached both configs with the same value.
  for (const text of Object.values(files)) {
    for (const [k, v] of Object.entries(JSON.parse(text))) {
      if (['from', 'inherits', 'name', 'version'].includes(k) || /_settings_id$|_extruder_(id|variant)$/.test(k)) continue;
      assert.ok(holds(ours[k], v), `${set}: ${k} in the engine's config: ${JSON.stringify(ours[k])} for ${JSON.stringify(v)}`);
      assert.ok(holds(ref[k], v), `${set}: ${k} in desktop's config: ${JSON.stringify(ref[k])} for ${JSON.stringify(v)}`);
    }
  }
  const r = await slice(M, cube, JSON.stringify(ours));
  const cmp = compareGcode(body(gunzipSync(readFileSync(join(dir, `${set}.gcode.gz`))).toString('utf8')), body(r.gcode), { maxSamples: 5 });
  failed += cmp.identical ? 0 : 1;
  console.log(`${cmp.identical ? 'ok   ' : 'FAIL '} ${set} user presets (${sel.printer} | ${sel.process} | ${sel.filaments[0]}): ` +
    (cmp.identical ? 'same G-code as desktop' : `G-code differs from line ${cmp.firstDiff}\n` +
      cmp.samples.map((s) => `   L${s.line}\n     desktop: ${s.ref}\n     engine:  ${s.got}`).join('\n')));
}
process.exit(failed ? 1 : 0);
