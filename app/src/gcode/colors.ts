// The preview's color views, as desktop's (GCodeViewer::update_by_mode, libvgcode ViewerImpl::
// get_vertex_color and ColorRange): which segment gets which color, and the legend's values.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { ROLE_COLORS } from './parse';
import type { PreviewData, Range } from './preview';

export type ViewType =
  | 'summary'
  | 'feature'
  | 'filament'
  | 'speed'
  | 'actualSpeed'
  | 'acceleration'
  | 'jerk'
  | 'height'
  | 'width'
  | 'flow'
  | 'actualFlow'
  | 'layerTime'
  | 'layerTimeLog'
  | 'fan'
  | 'temperature'
  | 'pressureAdvance';

/** Desktop's views, in its order, with their names, legend titles and decimals (desktop's text from GCodeViewer.cpp, shown with tr()). */
export const VIEWS: { id: ViewType; name: string; title?: string; decimals?: number }[] = [
  { id: 'summary', name: 'Summary' },
  { id: 'feature', name: 'Line Type' },
  { id: 'filament', name: 'Filament' },
  { id: 'speed', name: 'Speed', title: 'Speed (mm/s)', decimals: 0 },
  { id: 'actualSpeed', name: 'Actual Speed', title: 'Actual Speed (mm/s)', decimals: 0 },
  { id: 'acceleration', name: 'Acceleration', title: 'Acceleration (mm/s²)', decimals: 0 },
  { id: 'jerk', name: 'Jerk', title: 'Jerk (mm/s)', decimals: 1 },
  { id: 'height', name: 'Layer Height', title: 'Layer height (mm)', decimals: 2 },
  { id: 'width', name: 'Line Width', title: 'Line width (mm)', decimals: 2 },
  { id: 'flow', name: 'Flow', title: 'Volumetric flow rate (mm³/s)', decimals: 2 },
  { id: 'actualFlow', name: 'Actual Flow', title: 'Actual volumetric flow rate (mm³/s)', decimals: 2 },
  { id: 'layerTime', name: 'Layer Time', title: 'Layer Time', decimals: 1 },
  { id: 'layerTimeLog', name: 'Layer Time (log)', title: 'Layer Time (log)', decimals: 1 },
  { id: 'fan', name: 'Fan Speed', title: 'Fan speed (%)', decimals: 0 },
  { id: 'temperature', name: 'Temperature', title: 'Temperature (℃)', decimals: 0 },
  { id: 'pressureAdvance', name: 'Pressure Advance', title: 'Pressure Advance', decimals: 3 },
];

/** Views that color the travel moves too (by their value) and offer to show them. */
export const SPEED_VIEWS = new Set<ViewType>(['speed', 'actualSpeed', 'acceleration', 'jerk']);

/** Desktop's automatic choice: Filament for prints with several filaments, Line Type else. */
export const autoView = (d: PreviewData): ViewType => (d.extrudersUsed.length > 1 ? 'filament' : 'feature');

type RGB = [number, number, number];
/** libvgcode DEFAULT_RANGES_COLORS: blue (low) to red (high). */
export const RANGE_COLORS: RGB[] = [
  [11, 44, 122],
  [19, 89, 133],
  [28, 136, 145],
  [4, 214, 15],
  [170, 242, 0],
  [252, 249, 3],
  [245, 206, 10],
  [227, 136, 32],
  [209, 104, 48],
  [194, 82, 60],
  [148, 38, 22],
];
/** libvgcode DUMMY_COLOR and the travel option color. */
export const DUMMY: RGB = [64, 64, 64];
export const TRAVEL: RGB = [56, 72, 155];

const step = (r: Range, log: boolean) => {
  const n = RANGE_COLORS.length - 1;
  if (!log) return (r.max - r.min) / n;
  return r.min !== 0 ? Math.log(r.max / r.min) / n : 0;
};

/** libvgcode ColorRange::get_color_at, into out[o..o+2]. */
export function rangeColor(r: Range, log: boolean, value: number, out: Uint8Array, o: number) {
  if (r.min > r.max) {
    out.set(RANGE_COLORS[0]!, o);
    return;
  }
  const v = Math.min(r.max, Math.max(r.min, value));
  const s = step(r, log);
  let t = 0;
  if (s > 0) t = log ? (r.min !== 0 ? Math.log(v / r.min) / s : 0) : (v - r.min) / s;
  const last = RANGE_COLORS.length - 1;
  const lo = Math.min(last, Math.max(0, Math.floor(t))),
    hi = Math.min(last, lo + 1);
  const f = Math.min(1, Math.max(0, t - lo));
  const a = RANGE_COLORS[lo]!,
    b = RANGE_COLORS[hi]!;
  // libvgcode's lerp truncates to a byte.
  out[o] = (1 - f) * a[0] + f * b[0];
  out[o + 1] = (1 - f) * a[1] + f * b[1];
  out[o + 2] = (1 - f) * a[2] + f * b[2];
}

/** libvgcode ColorRange::get_values: the legend's values, lowest first. */
export function rangeValues(r: Range, log: boolean): number[] {
  if (r.min > r.max) return [];
  if (r.count === 1) return [r.min];
  if (r.count === 2) return [r.min, r.max];
  const s = step(r, log);
  return RANGE_COLORS.map((_, i) => (log ? Math.exp(Math.log(r.min) + i * s) : r.min + i * s));
}

/** "#RRGGBB" (or "#RRGGBBAA") to bytes; desktop's dark grey when it is not a color. */
export function hexColor(s: string | undefined): RGB {
  const m = /^#?([0-9a-f]{6})/i.exec(s ?? '');
  if (!m) return DUMMY;
  const v = parseInt(m[1]!, 16);
  return [v >> 16, (v >> 8) & 255, v & 255];
}

export interface Shown {
  /** Travel moves shown. */
  travel: boolean;
  /** Custom G-code extrusions shown (the Line Type list's "Custom"). */
  custom: boolean;
}

/** The range a view colors by, given what is shown; null for the views that do not use one. */
export function viewRange(d: PreviewData, view: ViewType, shown: Shown): { range: Range; log: boolean } | null {
  const r = d.ranges,
    tv = shown.travel ? 1 : 0,
    cv = shown.custom ? 1 : 0;
  switch (view) {
    case 'speed':
      return { range: r.speed[tv], log: false };
    case 'actualSpeed':
      return { range: r.actualSpeed[tv], log: false };
    case 'acceleration':
      return { range: r.accel[tv], log: false };
    case 'jerk':
      return { range: r.jerk[tv], log: false };
    case 'height':
      return { range: r.height, log: false };
    case 'width':
      return { range: r.width[cv], log: false };
    case 'flow':
      return { range: r.flow[cv], log: false };
    case 'actualFlow':
      return { range: r.actualFlow[cv], log: false };
    case 'layerTime':
      return { range: r.layerTime, log: false };
    case 'layerTimeLog':
      return { range: r.layerTime, log: true };
    case 'fan':
      return { range: r.fan, log: false };
    case 'temperature':
      return { range: r.temp, log: false };
    case 'pressureAdvance':
      return { range: r.pa, log: false };
    default:
      return null;
  }
}

/** Colors (RGB bytes) of every extrusion segment and travel move in a view (libvgcode get_vertex_color). */
export function colorize(d: PreviewData, view: ViewType, shown: Shown): { seg: Uint8Array; travel: Uint8Array } {
  const seg = new Uint8Array(d.segCount * 3),
    travel = new Uint8Array(d.travelCount * 3);
  const v = d.values,
    vr = viewRange(d, view, shown);
  const valueAt: ((k: number) => number) | null =
    vr &&
    (
      {
        speed: (k: number) => v.speed[k]!,
        actualSpeed: (k: number) => v.actualSpeed[k]!,
        acceleration: (k: number) => v.accel[k]!,
        jerk: (k: number) => v.jerk[k]!,
        height: (k: number) => d.wh[k * 2 + 1]!,
        width: (k: number) => d.wh[k * 2]!,
        flow: (k: number) => v.speed[k]! * v.mm3[k]!,
        actualFlow: (k: number) => v.actualSpeed[k]! * v.mm3[k]!,
        layerTime: (k: number) => d.meta.layer_times[d.layer[k]!] ?? 0,
        layerTimeLog: (k: number) => d.meta.layer_times[d.layer[k]!] ?? 0,
        fan: (k: number) => v.fan[k]!,
        temperature: (k: number) => v.temp[k]!,
        pressureAdvance: (k: number) => v.pa[k]!,
      } as Partial<Record<ViewType, (k: number) => number>>
    )[view]!;
  if (vr && valueAt) {
    for (let k = 0; k < d.segCount; k++) rangeColor(vr.range, vr.log, valueAt(k), seg, k * 3);
  } else if (view === 'feature') {
    for (let k = 0; k < d.segCount; k++) seg.set(ROLE_COLORS[d.role[k]!] ?? DUMMY, k * 3);
  } else {
    // Summary and Filament: the filament's color, after any color change; grey in a layer with a
    // pause or custom G-code.
    const colors = d.meta.print_colors.map(hexColor);
    for (let k = 0; k < d.segCount; k++)
      seg.set(d.layerGrey[d.layer[k]!] || !colors.length ? DUMMY : colors[v.color[k]! % colors.length]!, k * 3);
  }
  if (vr && SPEED_VIEWS.has(view)) {
    const tv = d.travelValues;
    const tval = { speed: tv.speed, actualSpeed: tv.actualSpeed, acceleration: tv.accel, jerk: tv.jerk }[view as 'speed']!;
    for (let k = 0; k < d.travelCount; k++) rangeColor(vr.range, false, tval[k]!, travel, k * 3);
  } else {
    for (let k = 0; k < d.travelCount; k++) travel.set(TRAVEL, k * 3);
  }
  return { seg, travel };
}
