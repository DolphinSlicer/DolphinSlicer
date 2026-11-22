// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  asRect,
  circlePoints,
  detectShape,
  fmt,
  formatVolumes,
  parsePoints,
  parseVolumes,
  shapePoints,
  toElements,
} from '../src/settings/bedGeometry';

describe('bed shape', () => {
  it('detects a rectangle with its origin as desktop shows it', () => {
    const pts = parsePoints(['-10x-5', '240x-5', '240x245', '-10x245'])!;
    expect(detectShape(pts)).toEqual({ kind: 'rect', w: 250, h: 250, ox: 10, oy: 5 });
    expect(shapePoints(detectShape(pts))).toEqual(pts);
  });

  it('round-trips the circle desktop generates (72 edges)', () => {
    const pts = circlePoints(200);
    expect(pts).toHaveLength(72);
    const s = detectShape(parsePoints(pts.map(([x, y]) => `${fmt(x)}x${fmt(y)}`))!);
    expect(s.kind).toBe('circle');
    if (s.kind === 'circle') expect(s.d).toBeCloseTo(200, 3);
  });

  it('treats other polygons as custom', () => {
    expect(detectShape(parsePoints(['0x0', '200x0', '100x150'])!).kind).toBe('custom');
    expect(asRect(parsePoints(['0x0', '200x0', '200x200', '100x250', '0x200'])!)).toBeNull();
  });

  it('writes elements the engine parses back exactly', () => {
    expect(toElements([[0.1, 250]])).toEqual(['0.1x250']);
    expect(fmt(1 / 3)).toBe('0.333333');
    expect(fmt(-0)).toBe('0');
  });
});

describe('collision volumes', () => {
  it('parses full-height and Z-limited volumes', () => {
    const v = parseVolumes('0x0, 30x0, 30x20, 0x20 | 5..40;100x100, 120x100, 120x120')!;
    expect(v).toEqual([
      {
        points: [
          [0, 0],
          [30, 0],
          [30, 20],
          [0, 20],
        ],
        z: null,
      },
      {
        points: [
          [100, 100],
          [120, 100],
          [120, 120],
        ],
        z: { min: 5, max: 40 },
      },
    ]);
    expect(formatVolumes(v)).toBe('0x0, 30x0, 30x20, 0x20 | 5..40;100x100, 120x100, 120x120');
  });

  it('accepts open ranges, newlines and the points= prefix', () => {
    expect(parseVolumes('..20;points=0x0,10x0,10x10\n30..;0x0,5x0,5x5')).toEqual([
      {
        points: [
          [0, 0],
          [10, 0],
          [10, 10],
        ],
        z: { min: null, max: 20 },
      },
      {
        points: [
          [0, 0],
          [5, 0],
          [5, 5],
        ],
        z: { min: 30, max: null },
      },
    ]);
    expect(formatVolumes(parseVolumes('..20;0x0,10x0,10x10')!)).toBe('..20;0x0, 10x0, 10x10');
  });

  it('rejects what desktop would drop', () => {
    expect(parseVolumes('')).toEqual([]);
    expect(parseVolumes('0x0, 10x0')).toBeNull(); // fewer than 3 points
    expect(parseVolumes('0x0, 10x0, 20x0')).toBeNull(); // zero area
    expect(parseVolumes('a..b;0x0,1x0,1x1')).toBeNull();
  });
});
