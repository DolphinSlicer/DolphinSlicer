// Desktop's calibration tests (orca_presets_calib): each makes its test plate as a 3MF and changes
// the edited presets as desktop's Plater::calib_* do; a slice with its parameters (orca_set_calib)
// has the test's G-code (temperature, pressure advance, … stepping up the tower).
//   node engine/test/calib.mjs st|mt
// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadEngine, slice } from './run-engine.mjs';

const here = import.meta.dirname;
const variant = process.argv[2] ?? 'st';
const M = await loadEngine(process.env.ENGINE_DIST ?? resolve(here, `../../.work/build-engine-${variant}/dist`), variant);
const resources = resolve(here, '../../.work/orca-src/resources');
function writeTree(src, dst, ext) {
  M.FS.mkdirTree(dst);
  for (const n of readdirSync(src)) {
    const s = join(src, n);
    if (statSync(s).isDirectory()) writeTree(s, `${dst}/${n}`, ext);
    else if (ext.test(n)) M.FS.writeFile(`${dst}/${n}`, readFileSync(s));
  }
}
for (const v of ['Custom', 'OrcaFilamentLibrary']) {
  M.FS.mkdirTree('/orca/system');
  M.FS.writeFile(`/orca/system/${v}.json`, readFileSync(join(resources, 'profiles', `${v}.json`)));
  writeTree(join(resources, 'profiles', v), `/orca/system/${v}`, /\.json$/);
}
writeTree(join(resources, 'calib'), '/calib', /\.(drc|3mf|stl)$/);

const P = M._orca_presets_create();
const str = (fn, arg) => M.ccall(fn, 'string', ['number', 'string'], [P, arg]);
const err = () => M.UTF8ToString(M._orca_presets_last_error(P));
assert.equal(M.ccall('orca_presets_load', 'number', ['number', 'string'], [P, '/orca']), 0, err());
const select = (printer) =>
  assert.equal(M.ccall('orca_presets_select', 'number', ['number', 'string'], [P, JSON.stringify({ printer, defaults: true })]), 0, err());
const values = (type) => JSON.parse(str('orca_presets_values', type)).values;
const dirty = () => JSON.parse(M.UTF8ToString(M._orca_presets_state(P))).dirty;

/** Start a test on a fresh selection; its plate's objects and a slice of it. */
async function run(request, printer = 'MyKlipper 0.4 nozzle') {
  select(printer);
  // Each test as on presets with no changes (the last test's are discarded).
  for (const type of ['print', 'filament', 'printer'])
    assert.equal(M.ccall('orca_presets_reset', 'number', ['number', 'string'], [P, JSON.stringify({ type, to: 'saved' })]), 0, err());
  const out = str('orca_presets_calib', JSON.stringify({ ...request, assets: '/calib', out: '/out/calib.3mf' }));
  assert.ok(out, err());
  const r = JSON.parse(out);
  const bytes = M.FS.readFile('/out/calib.3mf');
  const e = M._orca_create();
  M.FS.mkdirTree('/in');
  M.FS.writeFile('/in/calib.3mf', bytes);
  assert.equal(M.ccall('orca_load_model', 'number', ['number', 'string', 'string'], [e, '/in/calib.3mf', '3mf']), 0);
  const info = JSON.parse(M.UTF8ToString(M._orca_model_info(e)));
  M._orca_destroy(e);
  const config = M.ccall('orca_presets_full_config', 'string', ['number'], [P]);
  const { gcode } = await slice(M, bytes, config, { calib: r.calib });
  return { ...r, objects: info.objects, gcode };
}
const all = (g, re) => [...g.matchAll(re)].map((m) => Number(m[1]));
const height = (o) => o.bbox.max[2] - o.bbox.min[2];

// Temperature tower: cut to 230–190 °C (a 10 mm block each), stepping down by 5 °C.
let r = await run({ params: { mode: 'temp_tower', start: 230, end: 190 } });
assert.equal(r.calib.mode, 'temp_tower');
assert.equal(r.objects.length, 1);
assert.ok(Math.abs(height(r.objects[0]) - 90) < 0.1, `9 blocks: ${height(r.objects[0])}`);
assert.deepEqual([...new Set(all(r.gcode, /^M104 S(\d+)/gm))], [230, 225, 220, 215, 210, 205, 200, 195, 190]);
assert.ok(values('filament').nozzle_temperature.every((v) => v === '230'), 'the filament starts at 230 °C');
assert.ok(dirty().filament, 'the filament shows as modified');
console.log('ok temperature tower');

// Pressure advance tower: one mm per step, the advance rising with it.
r = await run({ params: { mode: 'pa_tower', start: 0, end: 0.1, step: 0.002 } });
assert.ok(Math.abs(height(r.objects[0]) - 51) < 0.1, `51 mm: ${height(r.objects[0])}`);
let pa = all(r.gcode, /^SET_PRESSURE_ADVANCE ADVANCE=([\d.]+)/gm);
assert.ok(pa.length > 40 && pa.at(-1) > 0.09 && pa.every((v, i) => i === 0 || v >= pa[i - 1]), 'rising pressure advance');
console.log('ok PA tower');

// PA line: lines drawn with each value, numbered.
r = await run({ params: { mode: 'pa_line', start: 0, end: 0.1, step: 0.002, print_numbers: true } });
pa = new Set(all(r.gcode, /^SET_PRESSURE_ADVANCE ADVANCE=([\d.]+)/gm));
assert.ok(pa.size >= 50, `${pa.size} values`);
console.log('ok PA line');

// PA pattern: one handle per speed and acceleration, patterns made when slicing.
r = await run({ params: { mode: 'pa_pattern', start: 0, end: 0.08, step: 0.005, accelerations: [1000, 3000], speeds: [50, 100] } });
assert.deepEqual(r.objects.map((o) => o.name).sort(), ['pa_pattern_100_1000', 'pa_pattern_100_3000', 'pa_pattern_50_1000', 'pa_pattern_50_3000']);
assert.ok(r.objects.every((o) => o.has_config), 'speed and acceleration per object');
assert.ok((r.gcode.match(/^; start pressure advance pattern for layer$/gm) ?? []).length >= 4);
// Without speeds and accelerations: the defaults, said as desktop does.
r = await run({ params: { mode: 'pa_pattern', start: 0, end: 0.08, step: 0.005 } });
assert.deepEqual(r.notices.map((n) => n.kind), ['accel', 'speed']);
console.log('ok PA pattern');

// Flow ratio (YOLO): objects with their own flow ratio, no parameters for the slice.
r = await run({ params: { mode: 'flow_rate' }, flow: { linear: true, pass: 1, pattern: 'archimedeanchords' } });
assert.equal(r.calib, null);
assert.ok(r.objects.length > 5 && r.objects.every((o) => o.name.startsWith('flowrate_') && o.has_config));
assert.equal(values('print').layer_height, '0.2');
console.log('ok flow ratio');

// Max flowrate: speeds in mm/s for the slice, the filament's limit raised.
r = await run({ params: { mode: 'vol_speed_tower', start: 5, end: 20, step: 0.5 } });
assert.ok(r.calib.start > 20 && r.calib.end > r.calib.start, 'mm/s');
assert.ok(values('filament').filament_max_volumetric_speed.every((v) => Number(v) >= 200));
console.log('ok max flowrate');

// Retraction: the length rises a step per mm.
r = await run({ params: { mode: 'retraction_tower', start: 0, end: 2, step: 0.1 } });
const lengths = all(r.gcode, /^; Calib_Retraction_tower: Z_HEIGHT: [\d.]+, length:([\d.]+)/gm);
assert.ok(lengths[0] === 0 && Math.abs(lengths.at(-1) - 2) < 1e-6, `${lengths[0]}…${lengths.at(-1)}`);
console.log('ok retraction');

// VFA: a spiral tower; the check of its end speed against the filament's limit.
r = await run({ params: { mode: 'vfa_tower', start: 40, end: 200, step: 10 } });
assert.equal(values('print').spiral_mode, '1');
assert.equal(r.calib.vfa_layer_height, 0.2);
for (const type of ['print', 'filament', 'printer'])
  M.ccall('orca_presets_reset', 'number', ['number', 'string'], [P, JSON.stringify({ type, to: 'saved' })]);
const vfa = JSON.parse(str('orca_presets_calib_vfa', JSON.stringify({ start: 40, end: 400, step: 10, nozzle_based_resize: true })));
assert.equal(vfa.exceeds, true);
assert.ok(vfa.limit < 400 && vfa.default_lh === 0.2, JSON.stringify(vfa));
console.log('ok VFA');

// Input shaping: the frequency, then the damping, stepped up the tower.
r = await run({ params: { mode: 'input_shaping_freq', freqStartX: 15, freqEndX: 110, freqStartY: 15, freqEndY: 110, start: 0.15, shaper_type: 'mzv' } });
const freq = all(r.gcode, /^SET_INPUT_SHAPER SHAPER_FREQ_X=([\d.]+)/gm);
assert.ok(freq[0] === 15 && freq.at(-1) > 100, `${freq[0]}…${freq.at(-1)}`);
r = await run({ params: { mode: 'input_shaping_damp', freqStartX: 30, freqStartY: 30, start: 0, end: 0.4, test_model: 1, shaper_type: 'mzv' } });
const damp = all(r.gcode, /^SET_INPUT_SHAPER DAMPING_RATIO_X=([\d.]+)/gm);
assert.ok(damp.length > 10 && damp.at(-1) > 0.35, `${damp.at(-1)}`);
console.log('ok input shaping');

// Cornering (Klipper: square corner velocity) on the SCV-V2 model.
r = await run({ params: { mode: 'cornering', start: 1, end: 15, test_model: 2 } });
assert.equal(r.objects[0].name, 'SCV-V2.drc');
const scv = all(r.gcode, /^SET_VELOCITY_LIMIT SQUARE_CORNER_VELOCITY=([\d.]+)/gm);
assert.ok(scv.length > 10 && Math.max(...scv) > 14, `${Math.max(...scv)}`);
console.log('ok cornering');

// Belt printers: the tower in blocks along the belt, one temperature each.
r = await run({ params: { mode: 'temp_tower', start: 230, end: 190 } }, 'MyBeltPrinter 0.4 nozzle');
assert.deepEqual(r.objects.map((o) => o.name), ['temp_230', 'temp_225', 'temp_220', 'temp_215', 'temp_210', 'temp_205', 'temp_200', 'temp_195', 'temp_190']);
assert.ok(new Set(all(r.gcode, /^M104 S(\d+)/gm)).size === 9);
console.log('ok belt temperature tower');
console.log('calibration ok');
