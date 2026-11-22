// Large-model benchmark: slice generated models with both builds, record time, heap and G-code
// size, and keep the biggest G-code for the browser preview benchmark.
//   node engine/test/bench-large.mjs [st|mt|both]   → .work/bench/report.json, .work/bench/*.gcode
// Config: Custom "MyKlipper 0.4 nozzle", composed by the engine's PresetBundle.
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadEngine } from './run-engine.mjs';

const here = import.meta.dirname;
const out = resolve(here, '../../.work/bench');
mkdirSync(out, { recursive: true });
const profiles = resolve(here, '../../.work/orca-src/resources/profiles');
const which = process.argv[2] ?? 'both';

function stl(tris) {
  const b = Buffer.alloc(84 + tris.length * 50);
  b.writeUInt32LE(tris.length, 80);
  let o = 84;
  for (const t of tris) { o += 12; for (const v of t) { b.writeFloatLE(v[0], o); b.writeFloatLE(v[1], o + 4); b.writeFloatLE(v[2], o + 8); o += 12; } o += 2; }
  return b;
}
// Bumpy sphere: many triangles and non-trivial perimeters on every layer.
function bumpySphere(r, seg, bumps = 24, amp = 0.06) {
  const rings = seg / 2, tris = [];
  const p = (i, j) => {
    const th = (Math.PI * i) / rings, ph = (2 * Math.PI * j) / seg;
    const rr = r * (1 + amp * Math.sin(bumps * ph) * Math.sin(th * bumps / 2));
    return [rr * Math.sin(th) * Math.cos(ph), rr * Math.sin(th) * Math.sin(ph), r - r * Math.cos(th)];
  };
  for (let i = 0; i < rings; i++) for (let j = 0; j < seg; j++) {
    const a = p(i, j), b = p(i + 1, j), c = p(i + 1, j + 1), d = p(i, j + 1);
    if (i > 0) tris.push([a, b, d]);
    if (i < rings - 1) tris.push([b, c, d]);
  }
  return stl(tris);
}

function writeTree(M, src, dst) {
  M.FS.mkdirTree(dst);
  for (const name of readdirSync(src)) {
    const s = join(src, name), d = `${dst}/${name}`;
    if (statSync(s).isDirectory()) writeTree(M, s, d); else if (name.endsWith('.json')) M.FS.writeFile(d, readFileSync(s));
  }
}

const cases = [
  { name: 'sphere-1M', model: () => bumpySphere(60, 1024), process: '0.20mm Standard @MyKlipper' },
  { name: 'sphere-fine', model: () => bumpySphere(70, 512), process: '0.08mm Extra Fine @MyKlipper' },
];

const report = { node: process.version, cases: [] };
for (const variant of which === 'both' ? ['st', 'mt'] : [which]) {
  const M = await loadEngine(resolve(here, `../../.work/build-engine-${variant}/dist`), variant);
  for (const v of ['Custom', 'OrcaFilamentLibrary']) {
    M.FS.mkdirTree('/orca/system');
    M.FS.writeFile(`/orca/system/${v}.json`, readFileSync(join(profiles, `${v}.json`)));
    writeTree(M, join(profiles, v), `/orca/system/${v}`);
  }
  const P = M._orca_presets_create();
  M.ccall('orca_presets_load', 'number', ['number', 'string'], [P, '/orca']);
  for (const c of cases) {
    M.ccall('orca_presets_select', 'number', ['number', 'string'], [P, JSON.stringify({ printer: 'MyKlipper 0.4 nozzle', process: c.process, filaments: ['Generic PLA @System'] })]);
    const cfg = M.ccall('orca_presets_full_config', 'string', ['number'], [P]);
    const bytes = c.model();
    const e = M._orca_create();
    M.FS.mkdirTree('/in');
    M.FS.writeFile('/in/m.stl', bytes);
    M.ccall('orca_load_model', 'number', ['number', 'string', 'string'], [e, '/in/m.stl', 'stl']);
    // Centre on the 250×250 bed (matrix: translation only).
    const info = JSON.parse(M.UTF8ToString(M._orca_model_info(e)));
    const bb = info.objects[0].bbox;
    const m = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 125, 125, -bb.min[2], 1];
    M.ccall('orca_set_layout', 'number', ['number', 'string'], [e, JSON.stringify({ objects: [{ index: 0, instances: [{ matrix: m }] }] })]);
    M.ccall('orca_set_config', 'number', ['number', 'string'], [e, cfg]);
    const t0 = performance.now();
    let rc = M.ccall('orca_slice_start', 'number', ['number', 'number', 'string'], [e, 1, '/out/g.gcode']);
    while (rc === 1) { await new Promise((r) => setTimeout(r, 50)); rc = M._orca_slice_poll(e); }
    const ms = performance.now() - t0;
    if (rc !== 0) { console.log(variant, c.name, 'FAILED', M.UTF8ToString(M._orca_last_error(e))); M._orca_destroy(e); continue; }
    const g = M.FS.readFile('/out/g.gcode');
    M.FS.unlink('/out/g.gcode');
    if (variant === 'mt' || which !== 'both') writeFileSync(join(out, `${c.name}.gcode`), g);
    const row = { variant, name: c.name, triangles: bytes.readUInt32LE(80), process: c.process, sliceMs: Math.round(ms),
      heapMiB: Math.round(M.HEAPU8.length / 2 ** 20), gcodeMB: +(g.length / 1e6).toFixed(1),
      layers: (Buffer.from(g).toString('latin1').match(/^;LAYER_CHANGE$/gm) ?? []).length };
    console.log(JSON.stringify(row));
    report.cases.push(row);
    M._orca_destroy(e);
  }
}
writeFileSync(join(out, `report-${which}.json`), JSON.stringify(report, null, 2));
process.exit(0);
