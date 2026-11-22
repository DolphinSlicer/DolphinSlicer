// Compose a config with the engine's PresetBundle (desktop full_config()) and compare it with
// the desktop CLI's flattened config for the same selection, then slice a fixture with it.
//   node engine/test/presets-check.mjs st|mt
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { loadEngine, slice } from './run-engine.mjs';
import { compareGcode } from './gcode-compare.mjs';

const here = import.meta.dirname;
const variant = process.argv[2] ?? 'st';
const dist = process.env.ENGINE_DIST ?? resolve(here, `../../.work/build-engine-${variant}/dist`);
const profiles = resolve(here, '../../.work/orca-src/resources/profiles');
const M = await loadEngine(dist, variant);

export function writeTree(M, src, dst) {
  M.FS.mkdirTree(dst);
  for (const name of readdirSync(src)) {
    const s = join(src, name), d = `${dst}/${name}`;
    if (statSync(s).isDirectory()) writeTree(M, s, d);
    else if (name.endsWith('.json')) M.FS.writeFile(d, readFileSync(s));
  }
}
for (const v of ['Custom', 'OrcaFilamentLibrary']) {
  M.FS.mkdirTree('/orca/system');
  M.FS.writeFile(`/orca/system/${v}.json`, readFileSync(join(profiles, `${v}.json`)));
  writeTree(M, join(profiles, v), `/orca/system/${v}`);
}
const P = M._orca_presets_create();
let t = performance.now();
let rc = M.ccall('orca_presets_load', 'number', ['number', 'string'], [P, '/orca']);
console.log('load rc', rc, Math.round(performance.now() - t), 'ms', M.UTF8ToString(M._orca_presets_last_error(P)).slice(0, 300));
const printers = JSON.parse(M.UTF8ToString(M._orca_presets_list(P))).printers;
console.log('printers', printers.length, printers.slice(0, 3).map((p) => p.name));
rc = M.ccall('orca_presets_select', 'number', ['number', 'string'], [P, JSON.stringify({
  printer: 'MyKlipper 0.4 nozzle', process: '0.20mm Standard @MyKlipper', filaments: ['Generic PLA @System'] })]);
const state = JSON.parse(M.UTF8ToString(M._orca_presets_state(P)));
console.log('select rc', rc, state.printer, '|', state.process, '|', state.filaments, 'processes', state.processes.length, 'filaments', state.filament_presets.length);
const cfgText = M.ccall('orca_presets_full_config', 'string', ['number'], [P]);
const ours = JSON.parse(cfgText);
const ref = JSON.parse(readFileSync(resolve(here, 'fixtures/ref/cube.settings.json'), 'utf8'));
const keys = new Set([...Object.keys(ours), ...Object.keys(ref)]);
const diffs = [...keys].filter((k) => JSON.stringify(ours[k]) !== JSON.stringify(ref[k]));
console.log('config keys ours', Object.keys(ours).length, 'ref', Object.keys(ref).length, 'differ', diffs.length);
for (const k of diffs) console.log(`  ${k}: ours=${JSON.stringify(ours[k])?.slice(0, 120)} ref=${JSON.stringify(ref[k])?.slice(0, 120)}`);

// The fixture 3MF carries project settings the CLI applied on top of the presets; align those
// (they are project state, not preset composition), then compare the G-code body without the
// trailing config block (where unresolved vs resolved variant arrays are echoed).
for (const k of ['enable_prime_tower', 'curr_bed_type', 'filament_colour']) ours[k] = ref[k];
const body = (g) => g.split('; CONFIG_BLOCK_START')[0];
const refG = gunzipSync(readFileSync(resolve(here, 'fixtures/ref/cube.gcode.gz'))).toString('utf8');
const r = await slice(M, readFileSync(resolve(here, 'fixtures/cube.3mf')), JSON.stringify(ours));
const cmp = compareGcode(body(refG), body(r.gcode));
console.log('cube with engine-composed config: identical =', cmp.identical, cmp.identical ? '' : `firstDiff ${cmp.firstDiff} structural ${cmp.structural}`);
if (!cmp.identical) for (const s of cmp.samples.slice(0, 10)) console.log(`   L${s.line}\n     ref: ${s.ref}\n     got: ${s.got}`);
