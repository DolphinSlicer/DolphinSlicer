// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { bedFromConfig, placeFootprint, type Rect } from '../src/model/bed';

const bed = bedFromConfig({ printable_area: ['0x0', '250x0', '250x250', '0x250'], printable_height: '250' });

describe('bed', () => {
  it('reads printable area and height from an OrcaSlicer config', () => {
    expect(bed.min).toEqual([0, 0]);
    expect(bed.max).toEqual([250, 250]);
    expect(bed.height).toBe(250);
    // clockwise input is made counter-clockwise
    const cw = bedFromConfig({ printable_area: ['0x0', '0x200', '200x200', '200x0'] });
    expect(cw.polygon[1]).toEqual([200, 200]);
  });

  it('places the first object at the bed centre and avoids existing ones', () => {
    expect(placeFootprint(bed, [], 20, 20)).toEqual([125, 125]);
    const taken: Rect[] = [{ x0: 115, y0: 115, x1: 135, y1: 135 }];
    const [x, y] = placeFootprint(bed, taken, 20, 20);
    const r = { x0: x - 10, y0: y - 10, x1: x + 10, y1: y + 10 };
    expect(r.x0 >= 135 + 6 || r.x1 <= 115 - 6 || r.y0 >= 135 + 6 || r.y1 <= 115 - 6).toBe(true);
    expect(r.x0).toBeGreaterThanOrEqual(0);
    expect(r.x1).toBeLessThanOrEqual(250);
  });

  it('puts an object that cannot fit next to the bed', () => {
    const [x] = placeFootprint(bed, [], 300, 20);
    expect(x).toBeGreaterThan(250);
  });

  it('puts the next one that cannot fit beside the first, not on it', () => {
    const taken: Rect[] = [];
    const spots: Rect[] = [];
    for (let i = 0; i < 4; i++) {
      const [x, y] = placeFootprint(bed, taken, 300, 100);
      const r = { x0: x - 150, y0: y - 50, x1: x + 150, y1: y + 50 };
      for (const o of spots) expect(r.x0 >= o.x1 || o.x0 >= r.x1 || r.y0 >= o.y1 || o.y0 >= r.y1).toBe(true);
      expect(r.x0).toBeGreaterThanOrEqual(250);
      spots.push(r);
      taken.push(r);
    }
  });
});
