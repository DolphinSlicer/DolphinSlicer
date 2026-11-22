// Bed geometry and object placement (pure functions, unit-tested).
// SPDX-License-Identifier: AGPL-3.0-or-later

export interface Bed {
  /** Printable area polygon (mm), counter-clockwise. */
  polygon: [number, number][];
  height: number;
  /** Areas the printer cannot use (e.g. a cutter or purge zone). */
  exclude: [number, number][][];
  min: [number, number];
  max: [number, number];
}

const parsePoints = (v: unknown): [number, number][] =>
  (Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : [])
    .map((s) => String(s).split('x').map(Number) as [number, number])
    .filter((p) => p.length === 2 && p.every(Number.isFinite));

/** `next`, or `prev` when it is the same bed: what shows the bed need not draw it again then. */
export const keepBed = (prev: Bed | null, next: Bed): Bed => (prev && JSON.stringify(prev) === JSON.stringify(next) ? prev : next);

/** Read the bed from a full config (OrcaSlicer JSON: printable_area, printable_height, bed_exclude_area). */
export function bedFromConfig(cfg: Record<string, unknown>): Bed {
  let polygon = parsePoints(cfg.printable_area);
  if (polygon.length < 3)
    polygon = [
      [0, 0],
      [200, 0],
      [200, 200],
      [0, 200],
    ];
  // Counter-clockwise, as PartPlate::set_shapes uses it.
  let area = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i]!,
      b = polygon[(i + 1) % polygon.length]!;
    area += a[0] * b[1] - b[0] * a[1];
  }
  if (area < 0) polygon.reverse();
  const ex = parsePoints(cfg.bed_exclude_area);
  const xs = polygon.map((p) => p[0]),
    ys = polygon.map((p) => p[1]);
  return {
    polygon,
    height: Number(cfg.printable_height) || 200,
    exclude: ex.length >= 3 ? [ex] : [],
    min: [Math.min(...xs), Math.min(...ys)],
    max: [Math.max(...xs), Math.max(...ys)],
  };
}

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export const rectW = (r: Rect) => r.x1 - r.x0;
export const rectH = (r: Rect) => r.y1 - r.y0;
const overlaps = (a: Rect, b: Rect, gap: number) => a.x0 < b.x1 + gap && b.x0 < a.x1 + gap && a.y0 < b.y1 + gap && b.y0 < a.y1 + gap;

/**
 * Pick a position for a footprint of size w×h on the bed, avoiding `taken` rectangles.
 * Tries the bed centre (or `near`) first, then a spiral of candidate positions. Returns the centre point.
 */
export function placeFootprint(bed: Bed, taken: Rect[], w: number, h: number, gap = 6, near?: [number, number]): [number, number] {
  const cx = near?.[0] ?? (bed.min[0] + bed.max[0]) / 2,
    cy = near?.[1] ?? (bed.min[1] + bed.max[1]) / 2;
  const fits = (x: number, y: number) => {
    const r = { x0: x - w / 2, y0: y - h / 2, x1: x + w / 2, y1: y + h / 2 };
    return taken.every((t) => !overlaps(r, t, gap)) && r.x0 >= bed.min[0] && r.y0 >= bed.min[1] && r.x1 <= bed.max[0] && r.y1 <= bed.max[1];
  };
  if (fits(cx, cy)) return [cx, cy];
  const step = Math.max(2, Math.min(w, h) / 4);
  const maxR = Math.hypot(bed.max[0] - bed.min[0], bed.max[1] - bed.min[1]);
  for (let r = step; r < maxR; r += step) {
    const n = Math.max(8, Math.ceil((2 * Math.PI * r) / step));
    for (let k = 0; k < n; k++) {
      const a = (2 * Math.PI * k) / n;
      const x = cx + r * Math.cos(a),
        y = cy + r * Math.sin(a);
      if (fits(x, y)) return [x, y];
    }
  }
  // No room: put it next to the bed (outside objects are not sliced; the UI flags them), in
  // columns beside it, clear of what stands there already.
  const beside = (x: number, y: number) => {
    const r = { x0: x - w / 2, y0: y - h / 2, x1: x + w / 2, y1: y + h / 2 };
    return taken.every((t) => !overlaps(r, t, gap));
  };
  const top = Math.max(bed.max[1] - h / 2, bed.min[1] + h / 2);
  for (let x = bed.max[0] + gap + w / 2, n = 0; n < 400; x += step, n++)
    for (let y = bed.min[1] + h / 2; y <= top; y += step) if (beside(x, y)) return [x, y];
  return [bed.max[0] + w / 2 + gap, cy];
}
