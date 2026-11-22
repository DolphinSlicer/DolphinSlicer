// The preview's data from the engine: the vertices desktop's preview gets (orca_export_preview,
// after desktop's LibVGCodeWrapper.cpp convert()) turned into segments for the renderer, with the
// values the color views need and their ranges (libvgcode ViewerImpl::update_color_ranges).
// SPDX-License-Identifier: AGPL-3.0-or-later

import { ROLES } from './parse';

/** libvgcode EMoveType. */
export const MOVE = {
  Noop: 0,
  Retract: 1,
  Unretract: 2,
  Seam: 3,
  ToolChange: 4,
  ColorChange: 5,
  PausePrint: 6,
  CustomGCode: 7,
  Travel: 8,
  Wipe: 9,
  Extrude: 10,
} as const;
const ROLE_CUSTOM = 14;

/** What orca_export_preview returns beside the vertices. */
export interface PreviewMeta {
  count: number;
  /** Seconds per layer (normal mode). */
  layer_times: number[];
  /** Filament colors ("#RRGGBB"), by extruder. */
  tool_colors: string[];
  /** Colors of the "Filament" view: the filaments', then the color changes'. */
  print_colors: string[];
  filaments: { id: number; m: number; g: number }[];
  time_s: number;
  filament_m: number;
  filament_g: number;
  cost: number;
  spiral_vase: boolean;
}

/** A color range's extent and how many distinct steps it saw (libvgcode ColorRange). */
export interface Range {
  min: number;
  max: number;
  count: number;
}

/** Values a segment is colored by, one per segment. */
export interface SegValues {
  speed: Float32Array;
  actualSpeed: Float32Array;
  mm3: Float32Array;
  fan: Float32Array;
  temp: Float32Array;
  pa: Float32Array;
  accel: Float32Array;
  jerk: Float32Array;
  extruder: Uint8Array;
  color: Uint8Array;
}

export interface PreviewData {
  /** Extrusion segments: x0 y0 z0 x1 y1 z1 per segment. */
  seg: Float32Array;
  /** Width and height per segment (mm). */
  wh: Float32Array;
  /** Role index per segment (ROLES). */
  role: Uint8Array;
  /** Layer index per segment. */
  layer: Uint32Array;
  /**
   * Directions of the neighbouring segments on the same path, per segment: previous xyz then next
   * xyz, normalized to ±127 (0,0,0 where the path starts or ends). The renderer joins segments at
   * the bisector of the corner, as the desktop preview does.
   */
  join: Int8Array;
  values: SegValues;
  segCount: number;
  /** Travel moves: x0 y0 z0 x1 y1 z1. */
  travel: Float32Array;
  travelLayer: Uint32Array;
  /** Values of the travel moves that the speed views color them by. */
  travelValues: Pick<SegValues, 'speed' | 'actualSpeed' | 'accel' | 'jerk'>;
  travelCount: number;
  /** First segment / travel index of each layer, plus a final end entry. */
  layerSegStart: Uint32Array;
  layerTravelStart: Uint32Array;
  layerZ: Float32Array;
  layerCount: number;
  /** Layers with a pause or custom G-code (grey in the Filament view, as desktop). */
  layerGrey: Uint8Array;
  /** Roles that occur. */
  rolesPresent: number[];
  /** Extruders that extrude. */
  extrudersUsed: number[];
  /**
   * Color ranges over all vertices. The speed ones count travel moves only when they are shown,
   * and width and flow skip custom G-code extrusions when those are hidden: both kinds are
   * given for each case ([hidden, shown]).
   */
  ranges: {
    height: Range;
    fan: Range;
    temp: Range;
    pa: Range;
    layerTime: Range;
    speed: [Range, Range];
    actualSpeed: [Range, Range];
    accel: [Range, Range];
    jerk: [Range, Range];
    width: [Range, Range];
    flow: [Range, Range];
    actualFlow: [Range, Range];
  };
  bbox: { min: [number, number, number]; max: [number, number, number] };
  meta: PreviewMeta;
}

/** libvgcode ColorRange::update. */
export function newRange(): Range {
  return { min: 3.4028234663852886e38, max: -3.4028234663852886e38, count: 0 };
}
export function grow(r: Range, v: number) {
  if (v !== r.min && v !== r.max) r.count++;
  if (v < r.min) r.min = v;
  if (v > r.max) r.max = v;
}

const SCALE = [100, 1000, 10000, 100000, 1000000];
const INVSCALE = [0.01, 0.001, 0.0001, 0.00001, 0.000001].map(Math.fround);
const THRESHOLD = [0.095, 0.0095, 0.00095, 0.000095, 0.0000095].map(Math.fround);
/** libvgcode round_to_bin: two significant digits for small values, 0.01 mm otherwise. */
export function roundToBin(v: number): number {
  let i = 0;
  for (; v < THRESHOLD[i]! && i < 4; ++i);
  return Math.fround(Math.floor(v * SCALE[i]! + 0.5) * INVSCALE[i]!);
}

/** Split the engine's preview file (see orca_export_preview) into segments for the renderer. */
export function buildPreview(buf: ArrayBuffer, meta: PreviewMeta): PreviewData {
  const n = meta.count;
  let at = 0;
  const f32 = (k: number) => {
    const a = new Float32Array(buf, at, k);
    at += k * 4;
    return a;
  };
  const pos = f32(n * 3);
  const height = f32(n),
    width = f32(n),
    speed = f32(n),
    actual = f32(n),
    mm3 = f32(n),
    fan = f32(n),
    temp = f32(n),
    pa = f32(n),
    accel = f32(n),
    jerk = f32(n);
  const vLayer = new Uint32Array(buf, at, n);
  at += n * 4;
  const u8 = () => {
    const a = new Uint8Array(buf, at, n);
    at += n;
    return a;
  };
  const role = u8(),
    type = u8(),
    extruder = u8(),
    color = u8();

  let segs = 0,
    travels = 0;
  for (let i = 1; i < n; i++) {
    const zero = pos[i * 3] === pos[i * 3 - 3] && pos[i * 3 + 1] === pos[i * 3 - 2] && pos[i * 3 + 2] === pos[i * 3 - 1];
    if (zero) continue;
    if (type[i] === MOVE.Extrude) segs++;
    else if (type[i] === MOVE.Travel) travels++;
  }
  const seg = new Float32Array(segs * 6),
    wh = new Float32Array(segs * 2),
    sRole = new Uint8Array(segs),
    sLayer = new Uint32Array(segs);
  const sVert = new Uint32Array(segs);
  const values: SegValues = {
    speed: new Float32Array(segs),
    actualSpeed: new Float32Array(segs),
    mm3: new Float32Array(segs),
    fan: new Float32Array(segs),
    temp: new Float32Array(segs),
    pa: new Float32Array(segs),
    accel: new Float32Array(segs),
    jerk: new Float32Array(segs),
    extruder: new Uint8Array(segs),
    color: new Uint8Array(segs),
  };
  const travel = new Float32Array(travels * 6),
    tLayer = new Uint32Array(travels);
  const travelValues = {
    speed: new Float32Array(travels),
    actualSpeed: new Float32Array(travels),
    accel: new Float32Array(travels),
    jerk: new Float32Array(travels),
  };
  const layerCount = n ? vLayer[n - 1]! + 1 : 0;
  const layerSeg = new Uint32Array(layerCount + 1),
    layerTr = new Uint32Array(layerCount + 1);
  const layerZ = new Float32Array(layerCount),
    layerGrey = new Uint8Array(layerCount);
  const zSeen = new Uint8Array(layerCount);
  const present = new Uint8Array(ROLES.length),
    used = new Uint8Array(256);
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity,
    maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;

  const pair = () => [newRange(), newRange()] as [Range, Range];
  const ranges: PreviewData['ranges'] = {
    height: newRange(),
    fan: newRange(),
    temp: newRange(),
    pa: newRange(),
    layerTime: newRange(),
    speed: pair(),
    actualSpeed: pair(),
    accel: pair(),
    jerk: pair(),
    width: pair(),
    flow: pair(),
    actualFlow: pair(),
  };

  let sc = 0,
    tc = 0,
    li = -1;
  for (let i = 0; i < n; i++) {
    const L = vLayer[i]!;
    while (li < L) {
      li++;
      layerSeg[li] = sc;
      layerTr[li] = tc;
    }
    const t = type[i]!,
      x = pos[i * 3]!,
      y = pos[i * 3 + 1]!,
      z = pos[i * 3 + 2]!;
    // libvgcode Layers::update: a layer's z is that of its last extrusion (not custom G-code).
    if (t === MOVE.Extrude && role[i] !== ROLE_CUSTOM) {
      layerZ[L] = z;
      zSeen[L] = 1;
    }
    if (t === MOVE.PausePrint || t === MOVE.CustomGCode) layerGrey[L] = 1;
    // Ranges, as libvgcode ViewerImpl::update_color_ranges (over every vertex).
    if (t === MOVE.Extrude) {
      grow(ranges.height, roundToBin(height[i]!));
      const w = roundToBin(width[i]!),
        fl = roundToBin(speed[i]! * mm3[i]!),
        afl = roundToBin(actual[i]! * mm3[i]!);
      grow(ranges.width[1], w);
      grow(ranges.flow[1], fl);
      grow(ranges.actualFlow[1], afl);
      if (role[i] !== ROLE_CUSTOM) {
        grow(ranges.width[0], w);
        grow(ranges.flow[0], fl);
        grow(ranges.actualFlow[0], afl);
      }
      grow(ranges.fan, roundToBin(fan[i]!));
      grow(ranges.temp, roundToBin(temp[i]!));
      if (pa[i]! >= 0) grow(ranges.pa, pa[i]!);
    }
    if (t === MOVE.Extrude || t === MOVE.Travel) {
      // [0]: travel moves hidden, [1]: shown.
      const first = t === MOVE.Extrude ? 0 : 1;
      for (let k = first; k < 2; k++) {
        grow(ranges.speed[k]!, speed[i]!);
        grow(ranges.actualSpeed[k]!, actual[i]!);
        grow(ranges.accel[k]!, accel[i]!);
        grow(ranges.jerk[k]!, jerk[i]!);
      }
    }
    if (i === 0) continue;
    if (x === pos[i * 3 - 3] && y === pos[i * 3 - 2] && z === pos[i * 3 - 1]) continue;
    if (t === MOVE.Extrude) {
      const o = sc * 6;
      seg[o] = pos[i * 3 - 3]!;
      seg[o + 1] = pos[i * 3 - 2]!;
      seg[o + 2] = pos[i * 3 - 1]!;
      seg[o + 3] = x;
      seg[o + 4] = y;
      seg[o + 5] = z;
      wh[sc * 2] = width[i]!;
      wh[sc * 2 + 1] = height[i]!;
      sRole[sc] = role[i]!;
      sLayer[sc] = L;
      sVert[sc] = i;
      values.speed[sc] = speed[i]!;
      values.actualSpeed[sc] = actual[i]!;
      values.mm3[sc] = mm3[i]!;
      values.fan[sc] = fan[i]!;
      values.temp[sc] = temp[i]!;
      values.pa[sc] = pa[i]!;
      values.accel[sc] = accel[i]!;
      values.jerk[sc] = jerk[i]!;
      values.extruder[sc] = extruder[i]!;
      values.color[sc] = color[i]!;
      present[role[i]! < ROLES.length ? role[i]! : 0] = 1;
      used[extruder[i]!] = 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
      sc++;
    } else if (t === MOVE.Travel) {
      const o = tc * 6;
      travel[o] = pos[i * 3 - 3]!;
      travel[o + 1] = pos[i * 3 - 2]!;
      travel[o + 2] = pos[i * 3 - 1]!;
      travel[o + 3] = x;
      travel[o + 4] = y;
      travel[o + 5] = z;
      tLayer[tc] = L;
      travelValues.speed[tc] = speed[i]!;
      travelValues.actualSpeed[tc] = actual[i]!;
      travelValues.accel[tc] = accel[i]!;
      travelValues.jerk[tc] = jerk[i]!;
      tc++;
    }
  }
  while (li < layerCount) {
    li++;
    layerSeg[li] = sc;
    layerTr[li] = tc;
  }
  // A layer without extrusions shows the height of the one below.
  for (let l = 1; l < layerCount; l++) if (!zSeen[l]) layerZ[l] = layerZ[l - 1]!;
  for (const lt of meta.layer_times) grow(ranges.layerTime, lt);

  const rolesPresent: number[] = [];
  present.forEach((v, k) => v && rolesPresent.push(k));
  const extrudersUsed: number[] = [];
  used.forEach((v, k) => v && extrudersUsed.push(k));
  return {
    seg,
    wh,
    role: sRole,
    layer: sLayer,
    join: joins(sVert, type, sc, seg),
    values,
    segCount: sc,
    travel,
    travelLayer: tLayer,
    travelValues,
    travelCount: tc,
    layerSegStart: layerSeg,
    layerTravelStart: layerTr,
    layerZ,
    layerCount,
    layerGrey,
    rolesPresent,
    extrudersUsed,
    ranges,
    bbox: sc ? { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] } : { min: [0, 0, 0], max: [0, 0, 0] },
    meta,
  };
}

/**
 * Neighbour directions for every segment (see PreviewData.join). Two segments are on one path
 * when they come from consecutive extrusion vertices: a path start has a phantom vertex in front
 * (no segment of its own), which breaks the chain, as in libvgcode.
 */
function joins(vert: Uint32Array, type: Uint8Array, n: number, seg: Float32Array): Int8Array {
  const out = new Int8Array(n * 6);
  const dir = (k: number, o: number) => {
    const dx = seg[k * 6 + 3]! - seg[k * 6]!,
      dy = seg[k * 6 + 4]! - seg[k * 6 + 1]!,
      dz = seg[k * 6 + 5]! - seg[k * 6 + 2]!;
    const l = Math.hypot(dx, dy, dz);
    if (l < 1e-6) return;
    out[o] = Math.round((dx / l) * 127);
    out[o + 1] = Math.round((dy / l) * 127);
    out[o + 2] = Math.round((dz / l) * 127);
  };
  for (let k = 1; k < n; k++) {
    if (vert[k] !== vert[k - 1]! + 1 || type[vert[k - 1]!] !== MOVE.Extrude) continue;
    dir(k - 1, k * 6); // previous direction of k
    dir(k, (k - 1) * 6 + 3); // next direction of k-1
  }
  return out;
}
