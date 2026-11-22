// The preview's data (orca_export_preview): a slice's moves as desktop's preview gets them, and
// the same G-code read back as a file (orca_process_gcode, desktop's G-code viewer) gives the same.
//   node engine/test/preview.mjs st|mt
// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEngine, ORCA } from './run-engine.mjs';

const here = import.meta.dirname;
const variant = process.argv[2] ?? 'st';
const M = await loadEngine(process.env.ENGINE_DIST ?? resolve(here, `../../.work/build-engine-${variant}/dist`), variant);
const fixture = 'cube';

const e = M._orca_create();
const err = () => M.UTF8ToString(M._orca_last_error(e));
M.FS.mkdirTree('/in');
M.FS.writeFile('/in/model.3mf', readFileSync(resolve(here, `fixtures/${fixture}.3mf`)));
assert.equal(M.ccall('orca_load_model', 'number', ['number', 'string', 'string'], [e, '/in/model.3mf', '3mf']), ORCA.OK, err());
assert.equal(M.ccall('orca_set_config', 'number', ['number', 'string'], [e, readFileSync(resolve(here, `fixtures/ref/${fixture}.settings.json`), 'utf8')]), ORCA.OK, err());
let rc = M.ccall('orca_slice_start', 'number', ['number', 'number', 'string'], [e, 1, '/out/g.gcode']);
while (rc === ORCA.RUNNING) { await new Promise((r) => setTimeout(r, 25)); rc = M._orca_slice_poll(e); }
assert.equal(rc, ORCA.OK, err());

/** The exported vertices: per-vertex arrays as orca_engine.h describes them. */
function preview() {
  const out = M.ccall('orca_export_preview', 'number', ['number'], [e]);
  if (!out) assert.fail(err());
  const meta = JSON.parse(M.UTF8ToString(out));
  const n = meta.count;
  assert.equal(meta.bytes, n * 60);
  const buf = M.HEAPU8.slice(meta.data, meta.data + meta.bytes).buffer;
  const f = (k) => new Float32Array(buf, n * 12 + k * n * 4, n);
  return {
    meta, n, pos: new Float32Array(buf, 0, n * 3), height: f(0), speed: f(2), actual: f(3), fan: f(5), temp: f(6),
    layer: new Uint32Array(buf, n * 52, n), role: new Uint8Array(buf, n * 56, n), type: new Uint8Array(buf, n * 57, n),
  };
}

const s = preview();
const EXTRUDE = 10, TRAVEL = 8, OUTER_WALL = 2;
const extrusions = [...s.type.keys()].filter((i) => s.type[i] === EXTRUDE);
assert.ok(extrusions.length > 1000, 'extrusion vertices');
assert.ok(s.type.includes(TRAVEL), 'travel vertices');
assert.ok(extrusions.some((i) => s.role[i] === OUTER_WALL), 'outer walls');
// Layers are numbered one after the other; each has its time.
for (let i = 1; i < s.n; i++) assert.ok(s.layer[i] === s.layer[i - 1] || s.layer[i] === s.layer[i - 1] + 1, `layer order at ${i}`);
assert.equal(s.meta.layer_times.length, s.layer[s.n - 1] + 1);
assert.ok(Math.abs(s.meta.layer_times.reduce((a, b) => a + b, 0) - s.meta.time_s) < 1, 'layer times add up to the print time');
// Values from the settings: 0.2 mm layers (0.4 first layer per the fixture or less), a fan, a temperature.
assert.ok(extrusions.every((i) => s.height[i] > 0 && s.speed[i] > 0), 'heights and speeds');
assert.ok(extrusions.some((i) => s.actual[i] < s.speed[i]), 'actual speed below the set speed where the head speeds up');
assert.ok(extrusions.some((i) => s.temp[i] > 150), 'temperatures');
assert.equal(s.meta.tool_colors.length, 1, 'filament color');
assert.ok(s.meta.filament_g > 0 && s.meta.filament_m > 0, 'filament used');

// The same G-code as a file.
M.FS.writeFile('/in/g.gcode', M.FS.readFile('/out/g.gcode'));
assert.equal(M.ccall('orca_process_gcode', 'number', ['number', 'string'], [e, '/in/g.gcode']), ORCA.OK, err());
const g = preview();
assert.equal(g.n, s.n, 'same vertices');
assert.deepEqual([...g.layer], [...s.layer], 'same layers');
assert.deepEqual([...g.role], [...s.role], 'same roles');
assert.ok(Math.abs(g.meta.time_s - s.meta.time_s) < 1, 'same print time');
assert.deepEqual(g.meta.tool_colors, s.meta.tool_colors, 'the filament colors of its settings');

// A file that is not there: an error, not a crash.
const bad = M.ccall('orca_process_gcode', 'number', ['number', 'string'], [e, '/in/missing.gcode']);
assert.notEqual(bad, ORCA.OK, 'a missing file fails');
M._orca_destroy(e);
console.log(`ok    preview: ${s.n} vertices, ${s.meta.layer_times.length} layers; the G-code read back gives the same`);
