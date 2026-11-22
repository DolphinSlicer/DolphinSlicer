// Support painting (orca_paint_*): desktop's TriangleSelector driven by rays, and the paint
// applied to the model for slicing (orca_set_layout "supports").
//   node engine/test/paint.mjs st|mt
// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEngine, ORCA } from './run-engine.mjs';

const here = import.meta.dirname;
const variant = process.argv[2] ?? 'st';
const M = await loadEngine(process.env.ENGINE_DIST ?? resolve(here, `../../.work/build-engine-${variant}/dist`), variant);
const e = M._orca_create();
const err = () => M.UTF8ToString(M._orca_last_error(e));
M.FS.mkdirTree('/in');
M.FS.writeFile('/in/model.3mf', readFileSync(resolve(here, 'fixtures/cube.3mf')));
assert.equal(M.ccall('orca_load_model', 'number', ['number', 'string', 'string'], [e, '/in/model.3mf', '3mf']), ORCA.OK, err());
const info = () => JSON.parse(M.UTF8ToString(M._orca_model_info(e)));
const cube = info().objects[0];
assert.equal(cube.painted, false);
const [x0, y0, z0] = cube.bbox.min, [x1, y1, z1] = cube.bbox.max;
const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
// The object as it stands, raised so its bottom is on the bed.
const instance = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 100, 100, -z0, 1];

const open = (supports) => M.ccall('orca_paint_open', 'number', ['number', 'string'], [e, JSON.stringify({ object: 0, instances: [instance], ...(supports ? { supports } : {}) })]);
const p = open();
assert.ok(p, err());
const event = (ev) => JSON.parse(M.ccall('orca_paint_event', 'string', ['number', 'string'], [p, JSON.stringify({ tool: 'circle', radius: 2, camera: [100, 100, 200], ...ev })]));
// The view's side of orca_paint_render: the blocks it was sent, kept until sent again.
const shown = new Map();
const counts = () => {
  const r = JSON.parse(M.UTF8ToString(M._orca_paint_render(p)));
  if (r.full) shown.clear();
  for (const b of r.blocks) shown.set(`${b.part}:${b.block}`, b.counts);
  return [0, 1, 2, 3, 4].map((g) => [...shown.values()].reduce((sum, c) => sum + c[g], 0));
};
const data = () => JSON.parse(M.UTF8ToString(M._orca_paint_data(p)));
// Straight down onto the top face's center, in world coordinates.
const top = [100 + cx, 100 + cy, 200, 0, 0, -1];

// Hovering: where the brush is, nothing painted.
let r = event({ action: 'move', rays: [top] });
assert.equal(r.hit, true);
assert.ok(Math.abs(r.point[2] - (z1 - z0)) < 1e-3, 'the hit is on the top face');
assert.deepEqual(r.normal.map((v) => Math.round(v)), [0, 0, 1]);
assert.deepEqual(counts(), [0, 0, 0, 0, 0]);
assert.equal(event({ action: 'move', rays: [[0, 0, 200, 0, 0, -1]] }).hit, false, 'beside the object');

// Left button: enforcers, split finer than the cube's two triangles per face.
assert.equal(event({ action: 'down', button: 'left', rays: [top] }).changed, true);
let c = counts();
assert.ok(c[0] > 9 * 3, `enforcers drawn (${c[0] / 9} triangles)`);
assert.equal(c[1], 0);
const painted = data();
assert.equal(painted.length, 1, 'one model part');
assert.ok(painted[0].length > 0 && painted[0].every(([t, s]) => Number.isInteger(t) && /^[0-9A-F]+$/.test(s)), 'desktop’s 3MF form');
// A drag: the stroke from the last point, as one capsule.
event({ action: 'drag', button: 'left', rays: [[100 + cx + 6, 100 + cy, 200, 0, 0, -1], [100 + cx + 3, 100 + cy, 200, 0, 0, -1], top] });
assert.ok(counts()[0] > c[0], 'the stroke painted more');
// Right button: blockers; Shift: erase.
event({ action: 'down', button: 'right', rays: [[100 + cx - 6, 100 + cy - 6, 200, 0, 0, -1]] });
assert.ok(counts()[1] > 0, 'blockers');
event({ action: 'down', button: 'right', erase: true, rays: [[100 + cx - 6, 100 + cy - 6, 200, 0, 0, -1]] });
assert.equal(counts()[1], 0, 'erased');

// Smart fill: the hovered face is previewed, a click fills it.
M._orca_paint_reset(p);
event({ action: 'move', tool: 'fill', smart_fill_angle: 30, rays: [top] });
c = counts();
assert.ok(c[2] > 0 && c[0] === 0, 'the fill’s preview');
// Moving on the preview keeps it without work; another tool clears it.
assert.equal(event({ action: 'move', tool: 'fill', smart_fill_angle: 30, rays: [[100 + cx + 1, 100 + cy, 200, 0, 0, -1]] }).changed, false, 'still on the preview');
assert.equal(event({ action: 'clear' }).changed, true);
assert.equal(counts()[2], 0, 'cleared');
event({ action: 'move', tool: 'fill', smart_fill_angle: 30, rays: [top] });
assert.equal(counts()[2], c[2], 'shown again');
event({ action: 'down', tool: 'fill', button: 'right', smart_fill_angle: 30, rays: [top] });
// Filled, and (as desktop) selected again as the next click's preview.
assert.equal(counts()[1] + counts()[4], c[2], 'the face is filled with blockers');
assert.equal(counts()[2], 0);

// Gap fill: a small enforcer island inside the blockers takes the blockers' state.
event({ action: 'down', button: 'left', radius: 0.4, rays: [top] });
c = counts();
assert.ok(c[0] > 0);
assert.equal(M.ccall('orca_paint_gap', 'number', ['number', 'string'], [p, JSON.stringify({ preview: 5 })]), ORCA.OK);
assert.equal(counts()[0], 0, 'previewed as filled');
M.ccall('orca_paint_gap', 'number', ['number', 'string'], [p, JSON.stringify({ preview: null, apply: 5 })]);
assert.equal(counts()[0], 0, 'filled');
assert.ok(counts()[1] > 0);

// Undo: other paint on the same object, without opening it again.
const set = (supports) => M.ccall('orca_paint_set', 'number', ['number', 'string'], [p, JSON.stringify({ supports })]);
const before = data(), drawn = counts();
event({ action: 'down', button: 'right', rays: [top] });
assert.notDeepEqual(data(), before);
assert.equal(set(before), ORCA.OK);
assert.deepEqual(data(), before, 'the paint set back');
assert.deepEqual(counts(), drawn, 'and drawn as before');
assert.equal(set(null), ORCA.OK);
assert.deepEqual(data(), [[]], 'as loaded: none');
assert.deepEqual(counts(), [0, 0, 0, 0, 0]);
assert.notEqual(set([[[99999, 'F']]]), ORCA.OK, 'bad data refused');
assert.equal(set(before), ORCA.OK);

// The paint, to slice with: orca_set_layout takes it.
const final = data();
M._orca_paint_close(p);
assert.equal(M.ccall('orca_set_layout', 'number', ['number', 'string'], [e, JSON.stringify({ objects: [{ index: 0, instances: [{ matrix: instance }], supports: final }] })]), ORCA.OK, err());
assert.equal(info().objects[0].painted, true, 'the model has the painted supports');
// Opened again from the model as it is now (no data given): the same paint.
const q = open();
const again = JSON.parse(M.UTF8ToString(M._orca_paint_data(q)));
assert.deepEqual(again, final, 'round trip through the model');
M._orca_paint_close(q);
// Bad data is refused.
assert.notEqual(M.ccall('orca_set_layout', 'number', ['number', 'string'], [e, JSON.stringify({ objects: [{ index: 0, instances: [{ matrix: instance }], supports: [[[99999, 'F']]] }] })]), ORCA.OK);
assert.equal(open([[[0, 'xyz']]]), 0, 'not hex: refused');
// A copy painted otherwise: the index again, as another object.
const moved = instance.slice(); moved[12] = 140;
assert.equal(M.ccall('orca_set_layout', 'number', ['number', 'string'], [e, JSON.stringify({ objects: [
  { index: 0, instances: [{ matrix: instance }], supports: final }, { index: 0, instances: [{ matrix: moved }], supports: [[]] }] })]), ORCA.OK, err());
assert.deepEqual(info().objects.map((o) => o.painted), [true, false], 'two objects, one painted');
// Erased: none left.
assert.equal(M.ccall('orca_set_layout', 'number', ['number', 'string'], [e, JSON.stringify({ objects: [{ index: 0, instances: [{ matrix: instance }], supports: [[]] }] })]), ORCA.OK, err());
assert.equal(info().objects[0].painted, false);
M._orca_destroy(e);

// Slicing with the paint: blockers on every triangle of a model with an overhang leave no
// support where automatic supports make some (desktop's 3MF writes a blocked triangle as "8").
const supportLines = async (supports) => {
  const s = M._orca_create();
  M.FS.writeFile('/in/model.3mf', readFileSync(resolve(here, 'fixtures/overhang.3mf')));
  assert.equal(M.ccall('orca_load_model', 'number', ['number', 'string', 'string'], [s, '/in/model.3mf', '3mf']), ORCA.OK);
  const o = JSON.parse(M.UTF8ToString(M._orca_model_info(s))).objects[0];
  if (supports) assert.equal(M.ccall('orca_set_layout', 'number', ['number', 'string'], [s, JSON.stringify({ objects: [{ index: 0, instances: o.instances.map((i) => ({ matrix: i.matrix })), supports: supports(o.triangles) }] })]), ORCA.OK);
  assert.equal(M.ccall('orca_set_config', 'number', ['number', 'string'], [s, readFileSync(resolve(here, 'fixtures/ref/overhang.settings.json'), 'utf8')]), ORCA.OK);
  let rc = M.ccall('orca_slice_start', 'number', ['number', 'number', 'string'], [s, 1, '/out/p.gcode']);
  while (rc === ORCA.RUNNING) { await new Promise((r) => setTimeout(r, 25)); rc = M._orca_slice_poll(s); }
  assert.equal(rc, ORCA.OK);
  const g = new TextDecoder().decode(M.FS.readFile('/out/p.gcode'));
  M._orca_destroy(s);
  return (g.match(/^;TYPE:Support$/gm) ?? []).length;
};
const auto = await supportLines();
assert.ok(auto > 0, 'automatic supports under the overhang');
assert.equal(await supportLines((n) => [Array.from({ length: n }, (_, i) => [i, '8'])]), 0, 'all blocked: no support');
console.log('ok    paint: brush, fill and gap fill on a cube; the paint applied for slicing');
