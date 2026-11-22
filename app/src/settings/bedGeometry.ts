// Bed geometry settings: printable_area, bed_exclude_area, bed_exclude_volumes.
// Parsing and generation follow the desktop code so values round-trip unchanged:
//   - shape detection: BuildVolume::BuildVolume (libslic3r/BuildVolume.cpp)
//   - rectangle/circle generation: BedShapePanel::update_shape (slic3r/GUI/BedShapeDialog.cpp)
//   - collision volume syntax: append_bed_exclusion_volume_regions (libslic3r/PrintConfig.cpp)
// SPDX-License-Identifier: AGPL-3.0-or-later

export type Pt = [number, number];

/** "250x0" → [250, 0]; null if malformed. */
export function parsePoint(s: string): Pt | null {
  const t = s.trim();
  const i = t.indexOf('x');
  if (i < 0 || t.indexOf('x', i + 1) >= 0) return null;
  const a = t.slice(0, i).trim(),
    b = t.slice(i + 1).trim();
  if (!a || !b) return null;
  const x = Number(a),
    y = Number(b);
  return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
}

export function parsePoints(elements: string[]): Pt[] | null {
  const out: Pt[] = [];
  for (const e of elements) {
    const p = parsePoint(e);
    if (!p) return null;
    out.push(p);
  }
  return out;
}

/** Like the config files (C++ ostream default: 6 significant digits). */
export function fmt(n: number): string {
  if (Object.is(n, -0) || Math.abs(n) < 1e-9) return '0';
  return String(Number(n.toPrecision(6)));
}

export const formatPoint = ([x, y]: Pt) => `${fmt(x)}x${fmt(y)}`;
/** Elements to send to the engine; full precision, the engine serializes like desktop. */
export const toElements = (pts: Pt[]) => pts.map(([x, y]) => `${x}x${y}`);

export function area(pts: Pt[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i]!,
      [x2, y2] = pts[(i + 1) % pts.length]!;
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

export function bbox(pts: Pt[]) {
  const xs = pts.map((p) => p[0]),
    ys = pts.map((p) => p[1]);
  return { min: [Math.min(...xs), Math.min(...ys)] as Pt, max: [Math.max(...xs), Math.max(...ys)] as Pt };
}

/** A polygon with at least 3 points and a non-zero area. */
export const isPolygon = (pts: Pt[]) => pts.length >= 3 && Math.abs(area(pts)) > 1e-9;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** An axis-aligned rectangle (area equals its bounding box, as BuildVolume checks). */
export function asRect(pts: Pt[]): Rect | null {
  if (pts.length < 4) return null;
  const b = bbox(pts);
  const w = b.max[0] - b.min[0],
    h = b.max[1] - b.min[1];
  if (w <= 0 || h <= 0 || Math.abs(Math.abs(area(pts)) - w * h) > 1e-6 * Math.max(1, w * h)) return null;
  return { x: b.min[0], y: b.min[1], w, h };
}

/** Desktop's order: front-left, front-right, back-right, back-left. */
export const rectPoints = ({ x, y, w, h }: Rect): Pt[] => [
  [x, y],
  [x + w, y],
  [x + w, y + h],
  [x, y + h],
];

/** Desktop's circular bed: 72 edges around the centre, starting one step after +X. */
export function circlePoints(diameter: number, cx = 0, cy = 0): Pt[] {
  const r = diameter / 2,
    edges = 72,
    out: Pt[] = [];
  for (let i = 1; i <= edges; i++) {
    const a = (i * 2 * Math.PI) / edges;
    out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return out;
}

/** A discretized circle (BuildVolume's test: vertices within 5 µm, edges sag less than 3 mm). */
export function asCircle(pts: Pt[]): { cx: number; cy: number; d: number } | null {
  if (pts.length <= 4) return null;
  const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length,
    cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  const dist = (p: Pt) => Math.hypot(p[0] - cx, p[1] - cy);
  const r = pts.reduce((s, p) => s + dist(p), 0) / pts.length;
  let prev = pts[pts.length - 1]!;
  for (const p of pts) {
    if (Math.abs(dist(p) - r) > 0.005 || r - dist([(prev[0] + p[0]) / 2, (prev[1] + p[1]) / 2]) > 3) return null;
    prev = p;
  }
  return { cx, cy, d: 2 * r };
}

export type BedShape =
  | { kind: 'rect'; w: number; h: number; ox: number; oy: number }
  | { kind: 'circle'; d: number; cx: number; cy: number }
  | { kind: 'custom'; points: Pt[] };

/** How desktop's bed shape dialog would show these points. Origin = where X0 Y0 is, from the front-left corner. */
export function detectShape(pts: Pt[]): BedShape {
  const r = asRect(pts);
  if (r) return { kind: 'rect', w: r.w, h: r.h, ox: -r.x, oy: -r.y };
  const c = asCircle(pts);
  if (c) return { kind: 'circle', d: c.d, cx: c.cx, cy: c.cy };
  return { kind: 'custom', points: pts };
}

export function shapePoints(s: BedShape): Pt[] {
  if (s.kind === 'rect') return rectPoints({ x: -s.ox, y: -s.oy, w: s.w, h: s.h });
  if (s.kind === 'circle') return circlePoints(s.d, s.cx, s.cy);
  return s.points;
}

// ── Toolhead collision volumes ─────────────────────────────────────────────────────────────
export interface Volume {
  points: Pt[];
  /** Height range in mm; null = the full printable height. Either end may be open. */
  z: { min: number | null; max: number | null } | null;
}

/** Parse bed_exclude_volumes. Returns null if any entry is not understood (then edit as text). */
export function parseVolumes(text: string): Volume[] | null {
  const out: Volume[] = [];
  for (const raw of text.split(/[|\n]/)) {
    const spec = raw.trim();
    if (!spec) continue;
    let z: Volume['z'] = null;
    let points: Pt[] | null = null;
    for (let field of spec.split(';')) {
      field = field.trim();
      if (!field) continue;
      const dots = field.indexOf('..');
      if (dots >= 0 && !field.includes('x')) {
        const a = field.slice(0, dots).trim(),
          b = field.slice(dots + 2).trim();
        const min = a ? Number(a) : null,
          max = b ? Number(b) : null;
        if ((min !== null && !Number.isFinite(min)) || (max !== null && !Number.isFinite(max))) return null;
        z = { min, max };
        continue;
      }
      field = field.replace(/^(points|polygon)=/i, '');
      points = parsePoints(field.split(','));
      if (!points) return null;
    }
    if (!points || !isPolygon(points)) return null;
    out.push({ points, z });
  }
  return out;
}

export function formatVolumes(vs: Volume[]): string {
  return vs
    .map((v) => {
      const pts = v.points.map(formatPoint).join(', ');
      if (!v.z) return pts;
      return `${v.z.min === null ? '' : fmt(v.z.min)}..${v.z.max === null ? '' : fmt(v.z.max)};${pts}`;
    })
    .join(' | ');
}
