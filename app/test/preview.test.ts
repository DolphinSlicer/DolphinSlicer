// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { colorize, hexColor, RANGE_COLORS, rangeValues, TRAVEL } from '../src/gcode/colors';
import { buildPreview, MOVE, PATH, type PreviewMeta, roundToBin } from '../src/gcode/preview';

interface V {
  type: number;
  pos: [number, number, number];
  layer: number;
  role?: number;
  speed?: number;
  actual?: number;
  h?: number;
  w?: number;
  mm3?: number;
  extruder?: number;
  color?: number;
  /** Seconds the move takes. */
  time?: number;
}

/** The engine's preview file (orca_export_preview) for these vertices. */
function file(vs: V[]): ArrayBuffer {
  const n = vs.length;
  const buf = new ArrayBuffer(n * 64);
  const f = new Float32Array(buf, 0, n * 14);
  vs.forEach((v, i) => {
    f.set(v.pos, i * 3);
    const vals = [v.h ?? 0.2, v.w ?? 0.45, v.speed ?? 0, v.actual ?? v.speed ?? 0, v.mm3 ?? 0.1, 0, 210, 0, 1000, 8, v.time ?? 0];
    vals.forEach((x, k) => {
      f[n * 3 + k * n + i] = x;
    });
  });
  new Uint32Array(buf, n * 56, n).set(vs.map((v) => v.layer));
  const u8 = (k: number, get: (v: V) => number) => new Uint8Array(buf, n * 60 + k * n, n).set(vs.map(get));
  u8(0, (v) => v.role ?? 0);
  u8(1, (v) => v.type);
  u8(2, (v) => v.extruder ?? 0);
  u8(3, (v) => v.color ?? 0);
  return buf;
}
const meta = (n: number, layers: number[]): PreviewMeta => ({
  count: n,
  layer_times: layers,
  tool_colors: ['#FF0000', '#00FF00'],
  print_colors: ['#FF0000', '#00FF00'],
  filaments: [],
  time_s: 0,
  filament_m: 0,
  filament_g: 0,
  cost: 0,
  spiral_vase: false,
});

// A travel, a wall of two segments, infill (a new path: phantom vertex in front), and a second layer.
const { Travel: T, Extrude: E } = MOVE;
const VERTS: V[] = [
  { type: T, pos: [0, 0, 0.2], layer: 0, speed: 200 },
  { type: T, pos: [10, 0, 0.2], layer: 0, speed: 200 },
  { type: E, pos: [10, 0, 0.2], layer: 0, role: 2, speed: 50 },
  { type: E, pos: [20, 0, 0.2], layer: 0, role: 2, speed: 50 },
  { type: E, pos: [20, 10, 0.2], layer: 0, role: 2, speed: 50 },
  { type: E, pos: [20, 10, 0.2], layer: 0, role: 4, speed: 100 },
  { type: E, pos: [10, 10, 0.2], layer: 0, role: 4, speed: 100 },
  { type: T, pos: [10, 10, 0.4], layer: 1, speed: 200 },
  { type: E, pos: [10, 10, 0.4], layer: 1, role: 2, speed: 30, extruder: 1, color: 1 },
  { type: E, pos: [20, 10, 0.4], layer: 1, role: 2, speed: 30, extruder: 1, color: 1 },
];

describe('buildPreview', () => {
  const d = buildPreview(file(VERTS), meta(VERTS.length, [12, 3]));

  it('makes a segment of each move, none of a phantom vertex, and keeps travels apart', () => {
    expect(d.segCount).toBe(4);
    expect(d.travelCount).toBe(2);
    expect([...d.seg.subarray(0, 6)]).toEqual([10, 0, expect.closeTo(0.2), 20, 0, expect.closeTo(0.2)]);
    expect([...d.role]).toEqual([2, 2, 4, 2]);
    expect(d.rolesPresent).toEqual([2, 4]);
    expect(d.extrudersUsed).toEqual([0, 1]);
  });

  it('numbers the layers, with their heights and where their segments start', () => {
    expect(d.layerCount).toBe(2);
    expect([...d.layerZ].map((z) => +z.toFixed(2))).toEqual([0.2, 0.4]);
    expect([...d.layerSegStart]).toEqual([0, 3, 4]);
    expect([...d.layerTravelStart]).toEqual([0, 1, 2]);
  });

  it('joins segments only along one path', () => {
    const at = (k: number) => [...d.join.subarray(k * 6, k * 6 + 6)];
    expect(at(0)).toEqual([0, 0, 0, 0, 127, 0]); // the wall turns into +Y
    expect(at(1)).toEqual([127, 0, 0, 0, 0, 0]); // coming from +X; the infill is another path
    expect(at(2)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('works out the ranges over every vertex, travels counted only when shown', () => {
    expect(d.ranges.speed[0]).toMatchObject({ min: 30, max: 100 });
    expect(d.ranges.speed[1]).toMatchObject({ min: 30, max: 200 });
    expect(d.ranges.layerTime).toMatchObject({ min: 3, max: 12 });
  });
});

describe('the path played back', () => {
  // A travel (1 s), a retraction in place (0.5 s), two extrusions (2 s, 1 s); next layer: a travel (0.25 s).
  const R = MOVE.Retract;
  const vs: V[] = [
    { type: T, pos: [0, 0, 0.2], layer: 0 },
    { type: T, pos: [10, 0, 0.2], layer: 0, time: 1 },
    { type: R, pos: [10, 0, 0.2], layer: 0, time: 0.5 },
    { type: E, pos: [10, 0, 0.2], layer: 0, role: 2 },
    { type: E, pos: [20, 0, 0.2], layer: 0, role: 2, time: 2 },
    { type: E, pos: [20, 10, 0.2], layer: 0, role: 2, time: 1 },
    { type: T, pos: [20, 10, 0.4], layer: 1, time: 0.25 },
  ];
  const d = buildPreview(file(vs), meta(vs.length, [4.5, 0.25]));

  it('lists the moves in print order with what each draws', () => {
    expect(d.path.count).toBe(4);
    const kinds = [...d.path.ref].map((r) => [r >>> PATH.shift, r & PATH.index]);
    expect(kinds).toEqual([
      [PATH.Travel, 0],
      [PATH.Seg, 0],
      [PATH.Seg, 1],
      [PATH.Travel, 1],
    ]);
    expect(d.path.start).toEqual([0, 0, expect.closeTo(0.2)]);
    expect([...d.path.end.subarray(3, 6)]).toEqual([20, 0, expect.closeTo(0.2)]);
    expect([...d.layerPathStart]).toEqual([0, 3, 4]);
  });

  it('times them from their layer’s start, a pause in place before the next move', () => {
    expect([...d.path.t0]).toEqual([0, 1.5, 3.5, 0]);
    expect([...d.path.t1]).toEqual([1, 3.5, 4.5, 0.25]);
    expect([...d.layerPathTime]).toEqual([4.5, 0.25]);
  });
});

describe('colors', () => {
  const d = buildPreview(file(VERTS), meta(VERTS.length, [12, 3]));

  it('colors by speed from blue (slowest) to red (fastest), travels in their color unless shown', () => {
    const c = colorize(d, 'speed', { travel: false, custom: true });
    expect([...c.seg.subarray(9, 12)]).toEqual(RANGE_COLORS[0]); // 30 mm/s
    expect([...c.seg.subarray(6, 9)]).toEqual(RANGE_COLORS[10]); // 100 mm/s
    expect([...colorize(d, 'speed', { travel: true, custom: true }).travel.subarray(0, 3)]).toEqual(RANGE_COLORS[10]);
    expect([...colorize(d, 'height', { travel: true, custom: true }).travel.subarray(0, 3)]).toEqual(TRAVEL);
  });

  it('colors by filament', () => {
    const c = colorize(d, 'filament', { travel: false, custom: true });
    expect([...c.seg.subarray(0, 3)]).toEqual([255, 0, 0]);
    expect([...c.seg.subarray(9, 12)]).toEqual([0, 255, 0]);
  });

  it('gives the legend values as desktop: one, two, or eleven steps', () => {
    expect(rangeValues({ min: 5, max: 5, count: 1 }, false)).toEqual([5]);
    expect(rangeValues({ min: 5, max: 10, count: 2 }, false)).toEqual([5, 10]);
    const v = rangeValues({ min: 0, max: 100, count: 3 }, false);
    expect(v).toHaveLength(11);
    expect(v[5]).toBeCloseTo(50);
    expect(rangeValues({ min: 1, max: 100, count: 3 }, true)[5]).toBeCloseTo(10);
  });

  it('rounds values to bins as libvgcode does', () => {
    expect(roundToBin(0.2)).toBeCloseTo(0.2);
    expect(roundToBin(0.123)).toBeCloseTo(0.12);
    expect(roundToBin(0.0123)).toBeCloseTo(0.012);
    expect(hexColor('#00ff0080')).toEqual([0, 255, 0]);
    expect(hexColor('')).toEqual([64, 64, 64]);
  });
});
