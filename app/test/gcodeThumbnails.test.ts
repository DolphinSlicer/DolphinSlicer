// The thumbnail sizes read from the printer's "thumbnails" setting.
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { thumbnailSizes } from '../src/view/gcodeThumbnails';

describe('thumbnailSizes', () => {
  it('reads each size, whatever the format', () => {
    expect(thumbnailSizes('32x32/PNG, 300x300/PNG')).toEqual([
      { width: 32, height: 32 },
      { width: 300, height: 300 },
    ]);
    expect(thumbnailSizes('48x48/QOI,96x64/JPG')).toEqual([
      { width: 48, height: 48 },
      { width: 96, height: 64 },
    ]);
  });
  it('skips empty, malformed and duplicate entries', () => {
    expect(thumbnailSizes('')).toEqual([]);
    expect(thumbnailSizes('abc, 0x10/PNG, 32x32/PNG, 32x32/JPG')).toEqual([{ width: 32, height: 32 }]);
  });
});
