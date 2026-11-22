// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { hexToHsv, hsvToHex, parseHex } from '../src/ui/ColorPicker';

describe('color picker', () => {
  it('reads hex codes with or without the #, short or long', () => {
    expect(parseHex('#1e88e5')).toBe('#1E88E5');
    expect(parseHex('1E88E5')).toBe('#1E88E5');
    expect(parseHex(' #f80 ')).toBe('#FF8800');
    expect(parseHex('#12345')).toBeNull();
    expect(parseHex('red')).toBeNull();
  });

  it('converts to hue, saturation and brightness and back', () => {
    expect(hexToHsv('#FF0000')).toEqual({ h: 0, s: 1, v: 1 });
    expect(hexToHsv('#000000')).toEqual({ h: 0, s: 0, v: 0 });
    expect(hexToHsv('#0000FF').h).toBe(240);
    for (const hex of ['#1E88E5', '#000000', '#FFFFFF', '#808080', '#CC3629', '#00FF7F', '#FF00FF'])
      expect(hsvToHex(hexToHsv(hex))).toBe(hex);
  });
});
